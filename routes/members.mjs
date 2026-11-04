import express from 'express';
import { ApiError, asyncHandler, rateLimit, requireAdmin, requireSuperAdmin } from '../http.mjs';
import { sanitizeText } from '../security.mjs';
import { parseMemberCsv } from '../memberCsv.mjs';
import {
  createMember,
  getMemberByPublicId,
  getMemberStats,
  getSubmissionWindow,
  isSubmissionWindowOpen,
  isValidPublicId,
  listAdminMembers,
  listPublicMembers,
  reviewMemberPhoto,
  saveSubmissionWindow,
  searchMembersForPhoto,
  serializeAdminMember,
  submitMemberPhoto,
  updateMemberByImport,
} from '../members.mjs';
import { MemberAchievementModel, MemberModel } from '../memberModels.mjs';
import { uploadImage } from '../cloudinary.mjs';
import {
  ACCEPTED_IMAGE_TYPES,
  MIN_MEMBER_PHOTO_DIMENSION,
  isRealImage,
  parseDataUrl,
  readImageDimensions,
} from '../images.mjs';

const MEMBER_MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Public routes — mounted at /api/members
 * ------------------------------------------------------------------ */

export const publicMembersRouter = express.Router();

/** Public directory: active members only, private fields never selected. */
publicMembersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const members = await listPublicMembers();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ members });
  })
);

/** Photo-submission window state (timestamps only). */
publicMembersRouter.get(
  '/window',
  asyncHandler(async (req, res) => {
    const window = await getSubmissionWindow();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      isOpen: isSubmissionWindowOpen(window),
      opensAt: window.opensAt,
      closesAt: window.closesAt,
    });
  })
);

/** Name search for the photo form: public id, name and a submitted flag only. */
publicMembersRouter.get(
  '/lookup',
  rateLimit('member-lookup', 30, 10 * 60_000),
  asyncHandler(async (req, res) => {
    const query = sanitizeText(req.query.q, 120);
    const results = await searchMembersForPhoto(query);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ results });
  })
);

/** Submit an ID photo: verifies name + student ID, stores it as pending. */
publicMembersRouter.post(
  '/photo',
  rateLimit('member-photo-upload', 8, 15 * 60_000),
  asyncHandler(async (req, res) => {
    const window = await getSubmissionWindow();
    if (!isSubmissionWindowOpen(window)) {
      throw new ApiError(403, 'Photo submission is currently closed.');
    }

    const publicId = sanitizeText(req.body?.publicId, 40);
    const studentId = sanitizeText(req.body?.studentId, 40);
    const parsed = parseDataUrl(req.body?.file);

    if (!publicId || !studentId) {
      throw new ApiError(400, 'Select your name and enter your Student ID.');
    }
    if (!parsed) {
      throw new ApiError(400, 'Choose a JPG, PNG or WebP photo to upload.');
    }
    if (!ACCEPTED_IMAGE_TYPES.includes(parsed.mime)) {
      throw new ApiError(400, 'Only JPG, PNG or WebP photos are accepted.');
    }
    if (parsed.buffer.length > MEMBER_MAX_PHOTO_BYTES) {
      throw new ApiError(400, 'Photos must be 5 MB or smaller.');
    }
    if (!isRealImage(parsed.buffer, parsed.mime)) {
      throw new ApiError(400, 'That file is not a valid image.');
    }

    const dimensions = readImageDimensions(parsed.buffer, parsed.mime);
    if (
      !dimensions ||
      dimensions.width < MIN_MEMBER_PHOTO_DIMENSION ||
      dimensions.height < MIN_MEMBER_PHOTO_DIMENSION
    ) {
      throw new ApiError(400, 'Photo is too small. Use at least 600 × 600 px (minimum 200 × 200).');
    }

    const photoUrl = await uploadImage({
      buffer: parsed.buffer,
      mime: parsed.mime,
      folder: 'cu-esports-club/members',
      square: true,
    });

    const member = await submitMemberPhoto(publicId, studentId, photoUrl);
    if (!member) {
      // One generic message: never reveal whether the name or the ID was wrong.
      throw new ApiError(400, 'We could not verify that name and Student ID combination.');
    }

    res.json({
      status: member.photo.status,
      url: member.photo.url,
    });
  })
);

/** Public profile used by /members/[publicId]. */
publicMembersRouter.get(
  '/:publicId',
  asyncHandler(async (req, res) => {
    if (!isValidPublicId(req.params.publicId)) {
      throw new ApiError(404, 'Member not found.');
    }
    const member = await getMemberByPublicId(req.params.publicId);
    if (!member) throw new ApiError(404, 'Member not found.');

    // Detailed achievement records live in their own collection.
    const record = await MemberModel.findOne({ publicId: member.publicId }).select('_id').lean();
    const achievements = record
      ? await MemberAchievementModel.find({ memberId: record._id }).sort({ date: -1 }).limit(50).lean()
      : [];

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      member: {
        ...member,
        achievementsDetailed: achievements.map((achievement) => ({
          title: achievement.title,
          description: achievement.description || '',
          date: achievement.date,
          link: achievement.link || '',
        })),
      },
    });
  })
);

/* ------------------------------------------------------------------ *
 * Admin routes — mounted at /api/admin/members (superadmin only)
 * ------------------------------------------------------------------ */

export const adminMembersRouter = express.Router();

adminMembersRouter.use(requireAdmin);
adminMembersRouter.use(requireSuperAdmin);

adminMembersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const [members, stats] = await Promise.all([listAdminMembers(), getMemberStats()]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ stats, members });
  })
);

adminMembersRouter.get(
  '/window',
  asyncHandler(async (req, res) => {
    const window = await getSubmissionWindow();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      isOpen: window.isOpen,
      effectivelyOpen: isSubmissionWindowOpen(window),
      opensAt: window.opensAt,
      closesAt: window.closesAt,
    });
  })
);

adminMembersRouter.patch(
  '/window',
  asyncHandler(async (req, res) => {
    const window = await saveSubmissionWindow({
      isOpen: typeof req.body?.isOpen === 'boolean' ? req.body.isOpen : undefined,
      opensAt: req.body?.opensAt ?? undefined,
      closesAt: req.body?.closesAt ?? undefined,
    });

    res.json({
      isOpen: window.isOpen,
      effectivelyOpen: isSubmissionWindowOpen(window),
      opensAt: window.opensAt,
      closesAt: window.closesAt,
    });
  })
);

adminMembersRouter.patch(
  '/:publicId/photo',
  asyncHandler(async (req, res) => {
    const status =
      req.body?.status === 'approved' || req.body?.status === 'rejected' ? req.body.status : null;
    if (!status) throw new ApiError(400, 'Status must be "approved" or "rejected".');

    const note = status === 'rejected' ? sanitizeText(req.body?.rejectionNote, 300) : '';
    if (status === 'rejected' && !note) {
      throw new ApiError(400, 'Add a short note explaining the rejection.');
    }

    const member = await reviewMemberPhoto(sanitizeText(req.params.publicId, 40), status, note);
    if (!member) throw new ApiError(404, 'No submitted photo found for that member.');

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      member: {
        publicId: member.publicId,
        name: member.name,
        photoStatus: member.photo.status,
        photoUrl: member.photo.url,
        rejectionNote: member.photo.rejectionNote,
      },
    });
  })
);

const MAX_CSV_BYTES = 2 * 1024 * 1024;

/**
 * CSV import. Re-importing the same sheet never duplicates a member: rows are
 * matched on email, falling back to name + session.
 */
adminMembersRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
    const mode = req.body?.mode === 'update' ? 'update' : 'skip';

    if (!csv.trim()) throw new ApiError(400, 'Paste CSV text or choose a CSV file.');
    if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
      throw new ApiError(400, 'CSV must be 2 MB or smaller.');
    }

    const parsed = parseMemberCsv(csv);
    if (parsed.rows.length === 0 && parsed.invalid.length === 0) {
      throw new ApiError(400, 'The CSV has no data rows.');
    }

    const existing = await MemberModel.find({}).select('publicId name session email').lean();
    const byEmail = new Map();
    const byNameSession = new Map();

    for (const doc of existing) {
      const record = {
        publicId: doc.publicId,
        name: doc.name || '',
        session: doc.session || '',
      };
      const email = String(doc.email || '').toLowerCase();
      if (email) byEmail.set(email, record);
      byNameSession.set(`${record.name.toLowerCase()}::${record.session.toLowerCase()}`, record);
    }

    const results = parsed.invalid.map((row) => ({
      line: row.line,
      name: row.name,
      action: 'failed',
      reason: row.reason,
    }));

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = parsed.invalid.length;

    for (const [i, row] of parsed.rows.entries()) {
      const line = i + 2;
      const match =
        (row.email ? byEmail.get(row.email) : undefined) ??
        byNameSession.get(`${row.name.toLowerCase()}::${row.session.toLowerCase()}`);

      if (match) {
        if (mode === 'skip') {
          skipped += 1;
          results.push({ line, name: row.name, action: 'skipped', reason: 'Already exists.' });
          continue;
        }
        try {
          await updateMemberByImport(match.publicId, {
            position: row.position,
            wing: row.wing,
            department: row.department,
            batch: row.batch,
            session: row.session,
            gamesPlayed: row.gamesPlayed,
            achievements: row.achievements,
            contribution: row.contribution,
            email: row.email || undefined,
            phone: row.phone || undefined,
            studentId: row.studentId || undefined,
            imageUrl: row.imageUrl || undefined,
          });
          updated += 1;
          results.push({ line, name: row.name, action: 'updated' });
        } catch (err) {
          failed += 1;
          results.push({ line, name: row.name, action: 'failed', reason: err.message });
        }
        continue;
      }

      try {
        const member = await createMember({
          name: row.name,
          department: row.department,
          position: row.position,
          wing: row.wing,
          session: row.session,
          batch: row.batch,
          email: row.email,
          phone: row.phone,
          studentId: row.studentId,
          gamesPlayed: row.gamesPlayed,
          achievements: row.achievements,
          contribution: row.contribution,
          photo: row.imageUrl
            ? { url: row.imageUrl, status: 'approved', submittedAt: new Date(), rejectionNote: '' }
            : undefined,
        });
        const summary = serializeAdminMember(member);
        created += 1;
        results.push({ line, name: row.name, action: 'created' });

        if (row.email) {
          const record = {
            publicId: summary.publicId,
            name: summary.name,
            session: summary.session,
          };
          byEmail.set(row.email, record);
          byNameSession.set(
            `${summary.name.toLowerCase()}::${summary.session.toLowerCase()}`,
            record
          );
        }
      } catch (err) {
        failed += 1;
        results.push({ line, name: row.name, action: 'failed', reason: err.message });
      }
    }

    res.json({
      summary: {
        total: parsed.rows.length + parsed.invalid.length,
        created,
        updated,
        skipped,
        failed,
      },
      results: results.slice(0, 200),
      mode,
    });
  })
);
