import { Router } from 'express';
import mongoose from 'mongoose';
import {
  generateSecureFourDigits,
  isValidSafeEmail,
  redactRegistration,
  sanitizeText,
  serializeRegistration,
} from '../security.mjs';
import {
  TournamentModel,
  TournamentRegistrationModel,
  logActivity,
  serializePublicTournament,
} from '../db.mjs';
import { ApiError, asyncHandler, rateLimit, requireAdmin, requireApiKey } from '../http.mjs';
import {
  sendRegistrationApprovedEmail,
  sendRegistrationReceivedEmail,
  sendRegistrationRejectedEmail,
} from '../email.mjs';

/** Public registration endpoints (`/api/tournaments/...`). */
export const publicRegistrationsRouter = Router();

/** Admin registration endpoints (`/api/admin/registrations`). */
export const adminRegistrationsRouter = Router();

async function resolveTournament(identifier) {
  const clean = sanitizeText(identifier, 100);
  if (!clean) throw new ApiError(400, 'Invalid tournament identifier.');
  const query = mongoose.Types.ObjectId.isValid(clean)
    ? { $or: [{ _id: clean }, { slug: clean }] }
    : { slug: clean };
  const tournament = await TournamentModel.findOne({
    ...query,
    $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }],
  }).lean();
  return tournament;
}

function parseRoster(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 8)
    .map((member) => ({
      role: sanitizeText(member?.role, 32) || 'Player',
      fullName: sanitizeText(member?.fullName, 80),
      studentId: sanitizeText(member?.studentId, 32),
      ign: sanitizeText(member?.ign, 80),
      inGameId: sanitizeText(member?.inGameId, 64),
    }))
    .filter((member) => member.fullName || member.inGameId || member.ign);
}

async function uniquePassCode(slug) {
  const prefix = slug.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'CU';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `CUEC-${prefix}-${generateSecureFourDigits()}`;
    const clash = await TournamentRegistrationModel.exists({ passCode: candidate });
    if (!clash) return candidate;
  }
  // Fallback keeps the format but adds entropy rather than failing the request.
  return `CUEC-${prefix}-${Date.now().toString().slice(-6)}`;
}

/* --------------------------- Public: register --------------------------- */

publicRegistrationsRouter.post(
  '/tournaments/:id/register',
  requireApiKey,
  rateLimit('tournament-register', 15, 10 * 60_000),
  asyncHandler(async (req, res) => {
    const tournament = await resolveTournament(req.params.id);
    if (!tournament) throw new ApiError(404, 'Tournament not found.');
    if (tournament.category !== 'upcoming') {
      throw new ApiError(400, 'Registration is closed for this tournament.');
    }

    const body = req.body || {};
    const name = sanitizeText(body.name, 80);
    const captainStudentId = sanitizeText(body.captainStudentId, 32);
    const captainEmail = sanitizeText(body.captainEmail, 160);

    if (!name || !captainStudentId) {
      throw new ApiError(400, 'Squad/Player name and CU Student ID are required.');
    }
    if (captainEmail && !isValidSafeEmail(captainEmail)) {
      throw new ApiError(400, 'Please provide a valid contact email address.');
    }

    // Atomically claim a slot so two simultaneous registrations cannot overfill.
    const claimed = await TournamentModel.findOneAndUpdate(
      {
        _id: tournament._id,
        $expr: { $lt: [{ $ifNull: ['$slotsFilled', 0] }, '$slotsTotal'] },
      },
      { $inc: { slotsFilled: 1 } },
      { new: true }
    ).lean();
    if (!claimed) {
      throw new ApiError(400, 'All slots for this tournament are already full.');
    }

    const passCode = await uniquePassCode(tournament.slug);

    try {
      const created = await TournamentRegistrationModel.create({
        tournamentId: tournament._id,
        tournamentSlug: tournament.slug,
        name,
        tag: (sanitizeText(body.tag, 8) || 'CU').toUpperCase(),
        department: sanitizeText(body.department, 60) || 'CU',
        status: 'Pending Check-In',
        passCode,
        captainName: sanitizeText(body.captainName, 80),
        captainStudentId,
        captainEmail,
        captainDiscord: sanitizeText(body.captainDiscord, 64),
        captainInGameId: sanitizeText(body.captainInGameId, 64),
        rosterMembers: parseRoster(body.rosterMembers),
      });

      const registrations = await TournamentRegistrationModel.find({ tournamentId: tournament._id })
        .sort({ createdAt: -1 })
        .lean();

      await logActivity({
        kind: 'registration',
        status: 'recorded',
        message: `Team registered: ${created.name} for ${tournament.name}`,
      });

      void sendRegistrationReceivedEmail(tournament, created);

      res.status(201).json({
        registration: redactRegistration(created),
        passCode,
        tournament: serializePublicTournament(claimed, registrations),
      });
    } catch (error) {
      // Give the slot back if the registration document could not be stored.
      await TournamentModel.updateOne(
        { _id: tournament._id, slotsFilled: { $gt: 0 } },
        { $inc: { slotsFilled: -1 } }
      );
      if (error?.code === 11000) {
        throw new ApiError(409, 'This team has already been registered. Please check in with an admin.');
      }
      throw error;
    }
  })
);

/* ----------------------- Public: list / inspect teams -------------------- */

publicRegistrationsRouter.get(
  '/tournaments/:id/registrations',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const tournament = await resolveTournament(req.params.id);
    if (!tournament) throw new ApiError(404, 'Tournament not found.');

    const registrations = await TournamentRegistrationModel.find({ tournamentId: tournament._id })
      .sort({ createdAt: -1 })
      .lean();

    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    res.json({ registrations: registrations.map(redactRegistration) });
  })
);

publicRegistrationsRouter.get(
  '/tournaments/:id/registrations/:registrationId',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const tournament = await resolveTournament(req.params.id);
    if (!tournament) throw new ApiError(404, 'Tournament not found.');

    const { registrationId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(registrationId)) {
      throw new ApiError(400, 'Invalid registration id.');
    }

    const registration = await TournamentRegistrationModel.findOne({
      _id: registrationId,
      tournamentId: tournament._id,
    }).lean();
    if (!registration) throw new ApiError(404, 'Registration not found.');

    // Public detail: roster + in-game IDs only. No emails, student IDs or pass codes.
    res.json({
      registration: {
        id: String(registration._id),
        tournamentId: String(registration.tournamentId),
        tournamentSlug: registration.tournamentSlug,
        name: registration.name,
        tag: registration.tag,
        department: registration.department,
        status: registration.status,
        captainName: registration.captainName,
        captainInGameId: registration.captainInGameId,
        rosterMembers: (registration.rosterMembers || []).map((member) => ({
          role: member.role,
          fullName: member.fullName,
          ign: member.ign,
          inGameId: member.inGameId,
        })),
        createdAt: registration.createdAt,
      },
    });
  })
);

/* ----------------------------- Admin routes ----------------------------- */

adminRegistrationsRouter.get(
  '/',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.tournamentId) {
      const clean = sanitizeText(req.query.tournamentId, 100);
      if (!mongoose.Types.ObjectId.isValid(clean)) {
        throw new ApiError(400, 'Invalid tournamentId filter.');
      }
      filter.tournamentId = clean;
    }
    if (req.query.status) {
      const status = sanitizeText(req.query.status, 32);
      if (!['Verified', 'Pending Check-In', 'Approved', 'Rejected'].includes(status)) {
        throw new ApiError(400, 'Invalid status filter.');
      }
      filter.status = status;
    }

    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
    const registrations = await TournamentRegistrationModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      registrations: registrations.map(serializeRegistration),
      tournaments: (await TournamentModel.find({}).select('slug name category').lean()).map((doc) => ({
        id: String(doc._id),
        slug: doc.slug,
        name: doc.name,
        category: doc.category,
      })),
    });
  })
);

adminRegistrationsRouter.get(
  '/:id',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid registration id.');

    const registration = await TournamentRegistrationModel.findById(id).lean();
    if (!registration) throw new ApiError(404, 'Registration not found.');
    const tournament = await TournamentModel.findById(registration.tournamentId)
      .select('slug name category gameName slotsFilled slotsTotal teamSize checkInLabel dateLabel')
      .lean();

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      registration: serializeRegistration(registration),
      tournament: tournament
        ? {
            id: String(tournament._id),
            slug: tournament.slug,
            name: tournament.name,
            category: tournament.category,
            gameName: tournament.gameName,
            slotsFilled: tournament.slotsFilled,
            slotsTotal: tournament.slotsTotal,
            teamSize: tournament.teamSize,
            checkInLabel: tournament.checkInLabel,
            dateLabel: tournament.dateLabel,
          }
        : null,
    });
  })
);

adminRegistrationsRouter.patch(
  '/:id',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid registration id.');

    const body = req.body || {};
    const status = body.status;
    const rejectionReason = sanitizeText(body.rejectionReason, 1000, true);

    if (status !== 'Approved' && status !== 'Rejected') {
      throw new ApiError(400, 'Invalid registration status.');
    }
    if (status === 'Rejected' && !rejectionReason) {
      throw new ApiError(400, 'A rejection reason is required.');
    }

    const before = await TournamentRegistrationModel.findById(id).lean();
    if (!before) throw new ApiError(404, 'Registration not found.');

    const updated = await TournamentRegistrationModel.findByIdAndUpdate(
      id,
      { $set: { status, rejectionReason: status === 'Rejected' ? rejectionReason : '' } },
      { new: true }
    ).lean();

    const tournament = await TournamentModel.findById(updated.tournamentId)
      .select('name slug checkInLabel dateLabel')
      .lean();

    if (before.status !== status && tournament) {
      if (status === 'Approved') {
        void sendRegistrationApprovedEmail(tournament, updated);
      } else {
        void sendRegistrationRejectedEmail(tournament, { ...updated, rejectionReason });
      }
    }

    await logActivity({
      kind: 'registration',
      status: 'recorded',
      message: `Registration ${updated.name} marked ${status}`,
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({ registration: serializeRegistration(updated) });
  })
);

adminRegistrationsRouter.delete(
  '/:id',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid registration id.');

    const removed = await TournamentRegistrationModel.findByIdAndDelete(id).lean();
    if (!removed) throw new ApiError(404, 'Registration not found.');

    // Free the slot the team occupied.
    await TournamentModel.updateOne(
      { _id: removed.tournamentId, slotsFilled: { $gt: 0 } },
      { $inc: { slotsFilled: -1 } }
    );

    await logActivity({
      kind: 'registration',
      status: 'recorded',
      message: `Registration removed: ${removed.name}`,
    });

    res.json({ deleted: true, id });
  })
);
