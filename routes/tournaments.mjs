import { Router } from 'express';
import mongoose from 'mongoose';
import {
  GAME_DEFAULTS,
  isValidGameId,
  sanitizeSafeImageUrl,
  sanitizeText,
  slugifyTournamentName,
} from '../security.mjs';
import { TournamentModel, TournamentRegistrationModel, logActivity, serializePublicTournament, serializeTournament } from '../db.mjs';
import { ApiError, asyncHandler, requireAdmin, requireApiKey } from '../http.mjs';

export const tournamentsRouter = Router();

const MATCH_STATUSES = ['SCHEDULED', 'LIVE NOW', 'COMPLETED'];
const MAX_GROUPS = 12;
const MAX_MATCHES_PER_GROUP = 40;

function sanitizeGroups(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_GROUPS).map((group, groupIndex) => {
    const source = group || {};
    const matches = Array.isArray(source.matches) ? source.matches : [];
    return {
      id: sanitizeText(source.id, 60) || `group-${groupIndex + 1}`,
      name: sanitizeText(source.name, 60) || `Group ${String.fromCharCode(65 + groupIndex)}`,
      matches: matches
        .slice(0, MAX_MATCHES_PER_GROUP)
        .map((match, matchIndex) => {
          const m = match || {};
          return {
            id: sanitizeText(m.id, 60) || `match-${groupIndex + 1}-${matchIndex + 1}`,
            round: sanitizeText(m.round, 80),
            teamA: sanitizeText(m.teamA, 80),
            teamB: sanitizeText(m.teamB, 80),
            dateLabel: sanitizeText(m.dateLabel, 80),
            score: sanitizeText(m.score, 40),
            status: MATCH_STATUSES.includes(m.status) ? m.status : 'SCHEDULED',
          };
        })
        .filter((match) => match.teamA || match.teamB),
    };
  });
}

/** Accepts an ObjectId or a slug and returns the Mongo query. */
function identifierQuery(identifier, extra = {}) {
  const clean = sanitizeText(identifier, 100);
  if (!clean) throw new ApiError(400, 'Invalid tournament identifier.');
  const query = mongoose.Types.ObjectId.isValid(clean)
    ? { $or: [{ _id: clean }, { slug: clean }] }
    : { slug: clean };
  return { ...query, ...extra };
}

async function findTournament(identifier) {
  return TournamentModel.findOne(identifierQuery(identifier, { isDeleted: { $ne: true } })).lean();
}

async function registrationsFor(tournamentIds) {
  if (tournamentIds.length === 0) return new Map();
  const rows = await TournamentRegistrationModel.find({ tournamentId: { $in: tournamentIds } })
    .sort({ createdAt: -1 })
    .lean();
  const byTournament = new Map();
  for (const row of rows) {
    const key = String(row.tournamentId);
    if (!byTournament.has(key)) byTournament.set(key, []);
    byTournament.get(key).push(row);
  }
  return byTournament;
}

/* ----------------------------- Public reads ----------------------------- */

tournamentsRouter.get(
  '/',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const docs = await TournamentModel.find({ $or: [{ isDeleted: false }, { isDeleted: { $exists: false } }] })
      .sort({ createdAt: -1 })
      .lean();

    const byTournament = await registrationsFor(docs.map((doc) => doc._id));

    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    res.json({
      tournaments: docs.map((doc) =>
        serializePublicTournament(doc, byTournament.get(String(doc._id)) || [])
      ),
    });
  })
);

tournamentsRouter.get(
  '/:id',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const doc = await findTournament(req.params.id);
    if (!doc) throw new ApiError(404, 'Tournament not found.');

    const registrations = await TournamentRegistrationModel.find({ tournamentId: doc._id })
      .sort({ createdAt: -1 })
      .lean();

    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    res.json({ tournament: serializePublicTournament(doc, registrations) });
  })
);

/* ------------------------------ Admin writes ---------------------------- */

tournamentsRouter.post(
  '/',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = sanitizeText(body.name, 140);
    if (!name) throw new ApiError(400, 'Tournament name is required.');

    const gameId = isValidGameId(body.gameId) ? body.gameId : 'valorant';
    const gameMeta = GAME_DEFAULTS[gameId];

    const slug = slugifyTournamentName(sanitizeText(body.slug || name, 100));
    if (!slug) throw new ApiError(400, 'Valid tournament URL slug is required.');

    const existing = await TournamentModel.findOne({ slug }).lean();
    if (existing) throw new ApiError(409, `A tournament with slug "${slug}" already exists.`);

    const category =
      body.category === 'ongoing' || body.category === 'completed' ? body.category : 'upcoming';

    const requiredPlayers =
      Number(body.requiredPlayers) === 1 ? 1 : Number(body.requiredPlayers) === 4 ? 4 : 5;

    const countdownHours = Math.min(8760, Math.max(1, Number(body.countdownHours) || 72));
    const slotsTotal = Math.min(512, Math.max(2, Number(body.slotsTotal) || 16));

    const rulesList = (
      Array.isArray(body.rules)
        ? body.rules.map((rule) => sanitizeText(rule, 280)).filter(Boolean)
        : sanitizeText(body.rulesText, 3000, true)
            .split('\n')
            .map((rule) => sanitizeText(rule, 280))
            .filter(Boolean)
    ).slice(0, 25);

    const prizePool = sanitizeText(body.prizePool, 80) || 'BDT 20,000';
    const prizeBreakdown =
      Array.isArray(body.prizeBreakdown) && body.prizeBreakdown.length > 0
        ? body.prizeBreakdown.slice(0, 8).map((tier) => ({
            place: sanitizeText(tier?.place, 60) || 'Prize Tier',
            reward: sanitizeText(tier?.reward, 80) || prizePool,
          }))
        : [
            { place: 'Champion', reward: prizePool },
            { place: 'Runner-Up', reward: 'Crest & Certificates' },
          ];

    const bannerUrl = sanitizeSafeImageUrl(body.bannerUrl);
    if (body.bannerUrl && String(body.bannerUrl).trim() && !bannerUrl) {
      throw new ApiError(400, 'Invalid banner URL. Use an https:// URL or a /assets/... path.');
    }

    const stageLabel = sanitizeText(body.stageLabel, 80) || 'Group Stage · Day 1';
    const currentMatch = sanitizeText(body.currentMatch, 120) || 'Opening Stage Live';

    const created = await TournamentModel.create({
      slug,
      name,
      category,
      gameId,
      gameName: gameMeta.name,
      bannerUrl,
      dateLabel: sanitizeText(body.dateLabel, 80) || 'TBA · 7:00 PM',
      checkInLabel:
        sanitizeText(body.checkInLabel, 140) || 'Discord Lobby Check-In opens 30 mins prior',
      initialCountdownSeconds: category === 'upcoming' ? countdownHours * 3600 : 0,
      registrationStatus:
        body.registrationStatus === 'Closing Soon' || body.registrationStatus === 'Last 4 Slots'
          ? body.registrationStatus
          : 'Open',
      entryFee: sanitizeText(body.entryFee, 80) || 'Free (CU Students Only)',
      prizePool,
      prizeBreakdown,
      slotsFilled: 0,
      slotsTotal,
      teamSize:
        requiredPlayers === 1
          ? '1v1 Solo'
          : body.allowSubstitute !== false
            ? `${requiredPlayers} Players + 1 Sub`
            : `${requiredPlayers} Players`,
      requiredPlayers,
      allowSubstitute: requiredPlayers === 1 ? false : body.allowSubstitute !== false,
      inGameIdLabel: sanitizeText(body.inGameIdLabel, 60) || gameMeta.uidLabel,
      inGameIdPlaceholder: sanitizeText(body.inGameIdPlaceholder, 60) || gameMeta.uidPlaceholder,
      venue: sanitizeText(body.venue, 120) || 'Online Lobby + CU Campus Finals',
      rules:
        rulesList.length > 0
          ? rulesList
          : ['All participants must hold a valid University of Chittagong Student ID.'],
      showOnLanding: body.showOnLanding !== false,
      featureInHero: body.featureInHero === true,
      stageLabel,
      elapsedPercent: Math.min(100, Math.max(0, Number(body.elapsedPercent) || 25)),
      elapsedLabel: sanitizeText(body.elapsedLabel, 60) || 'Day 1 / 3',
      format:
        sanitizeText(body.format, 80) ||
        (requiredPlayers === 1 ? '1v1 Solo Knockout' : `${requiredPlayers}v${requiredPlayers} Bracket`),
      currentMatch,
      bracketSummary:
        category === 'ongoing'
          ? [{ round: stageLabel, matchup: currentMatch, score: 'LIVE', status: 'LIVE NOW' }]
          : [],
      championTeam: sanitizeText(body.championTeam, 100),
    });

    await logActivity({
      kind: 'tournament',
      status: 'recorded',
      message: `Tournament created: ${created.name}`,
    });

    res.status(201).json({ tournament: serializeTournament(created) });
  })
);

tournamentsRouter.patch(
  '/:id',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const doc = await findTournament(req.params.id);
    if (!doc) throw new ApiError(404, 'Tournament not found.');

    const body = req.body || {};
    const fields = {};

    const text = (key, max, newlines = false) => {
      if (body[key] !== undefined) fields[key] = sanitizeText(body[key], max, newlines);
    };

    text('name', 140);
    text('dateLabel', 80);
    text('checkInLabel', 140);
    text('entryFee', 80);
    text('prizePool', 80);
    text('teamSize', 80);
    text('inGameIdLabel', 60);
    text('inGameIdPlaceholder', 60);
    text('venue', 120);
    text('stageLabel', 80);
    text('elapsedLabel', 60);
    text('format', 80);
    text('currentMatch', 120);
    text('championTeam', 100);
    text('runnerUpTeam', 100);

    if (body.slug !== undefined && body.slug) {
      const slug = slugifyTournamentName(sanitizeText(body.slug, 100));
      if (!slug) throw new ApiError(400, 'Invalid tournament slug.');
      if (slug !== doc.slug) {
        const clash = await TournamentModel.findOne({ slug, _id: { $ne: doc._id } }).lean();
        if (clash) throw new ApiError(409, `A tournament with slug "${slug}" already exists.`);
      }
      fields.slug = slug;
    }

    if (body.category === 'ongoing' || body.category === 'upcoming' || body.category === 'completed') {
      fields.category = body.category;
    }
    if (body.gameId !== undefined) {
      if (!isValidGameId(body.gameId)) throw new ApiError(400, 'Unknown game id.');
      fields.gameId = body.gameId;
      fields.gameName = GAME_DEFAULTS[body.gameId].name;
    }
    if (body.bannerUrl !== undefined) {
      const bannerUrl = sanitizeSafeImageUrl(body.bannerUrl);
      if (String(body.bannerUrl).trim() && !bannerUrl) {
        throw new ApiError(400, 'Invalid banner URL. Use an https:// URL or a /assets/... path.');
      }
      fields.bannerUrl = bannerUrl;
    }
    if (body.registrationStatus !== undefined) {
      if (!['Open', 'Closing Soon', 'Last 4 Slots'].includes(body.registrationStatus)) {
        throw new ApiError(400, 'Invalid registration status.');
      }
      fields.registrationStatus = body.registrationStatus;
    }
    if (body.slotsTotal !== undefined) {
      fields.slotsTotal = Math.min(512, Math.max(2, Number(body.slotsTotal) || 16));
    }
    if (body.requiredPlayers !== undefined) {
      if (![1, 4, 5].includes(Number(body.requiredPlayers))) {
        throw new ApiError(400, 'requiredPlayers must be 1, 4 or 5.');
      }
      fields.requiredPlayers = Number(body.requiredPlayers);
    }
    if (body.allowSubstitute !== undefined) fields.allowSubstitute = Boolean(body.allowSubstitute);
    if (body.showOnLanding !== undefined) fields.showOnLanding = Boolean(body.showOnLanding);
    if (body.featureInHero !== undefined) fields.featureInHero = Boolean(body.featureInHero);
    if (body.initialCountdownSeconds !== undefined) {
      fields.initialCountdownSeconds = Math.min(
        8760,
        Math.max(1, Number(body.initialCountdownSeconds) || 1)
      );
    }
    if (body.elapsedPercent !== undefined) {
      fields.elapsedPercent = Math.min(100, Math.max(0, Number(body.elapsedPercent) || 0));
    }
    if (Array.isArray(body.rules)) {
      fields.rules = body.rules.map((rule) => sanitizeText(rule, 280)).filter(Boolean).slice(0, 25);
    }
    if (Array.isArray(body.prizeBreakdown)) {
      fields.prizeBreakdown = body.prizeBreakdown.slice(0, 8).map((tier) => ({
        place: sanitizeText(tier?.place, 60) || 'Prize Tier',
        reward: sanitizeText(tier?.reward, 80),
      }));
    }
    if (body.bracketGroups !== undefined) {
      fields.bracketGroups = sanitizeGroups(body.bracketGroups);
    }

    if (Object.keys(fields).length === 0) throw new ApiError(400, 'Nothing to update.');

    const updated = await TournamentModel.findByIdAndUpdate(
      doc._id,
      { $set: fields },
      { new: true, runValidators: true }
    ).lean();

    const registrations = await TournamentRegistrationModel.find({ tournamentId: doc._id })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ tournament: serializePublicTournament(updated, registrations) });
  })
);

tournamentsRouter.delete(
  '/:id',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const doc = await findTournament(req.params.id);
    if (!doc) throw new ApiError(404, 'Tournament not found.');

    await TournamentModel.updateOne({ _id: doc._id }, { $set: { isDeleted: true } });
    await logActivity({
      kind: 'tournament',
      status: 'recorded',
      message: `Tournament archived: ${doc.name}`,
    });

    res.json({ deleted: true, softDeleted: true, id: String(doc._id) });
  })
);
