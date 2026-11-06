import { Router } from 'express';
import mongoose from 'mongoose';
import {
  generateSecureFourDigits,
  isValidSafeEmail,
  sanitizeSafeImageUrl,
  sanitizeText,
} from '../security.mjs';
import {
  MemberApplicationModel,
  RecruitmentModel,
  logActivity,
} from '../db.mjs';
import { ApiError, asyncHandler, rateLimit, requireAdmin, requireApiKey } from '../http.mjs';

export const recruitmentRouter = Router();
export const adminApplicationsRouter = Router();

const SINGLETON = 'active_recruitment';

/** Seeded on first read so a fresh database never 404s the public /join page. */
const DEFAULT_RECRUITMENT = {
  singletonKey: SINGLETON,
  isOpen: true,
  title: 'Autumn 2026 Club & Executive Wing Recruitment',
  sessionLabel: 'Session 2026–27',
  deadlineLabel: 'Nov 25, 2026 · 11:59 PM',
  announcement:
    'Applications are officially open for University of Chittagong students across all faculties! Join our competitive rosters, live broadcast desk, tournament referee corps, or creative media team.',
  openWings: [
    'Competitive Player',
    'Broadcast & Shoutcasting',
    'Tournament Operations & Referee',
    'Graphic Design & Production',
    'Social Media & Community Management',
  ],
  requirements: [
    'Must be a currently enrolled student at the University of Chittagong with a valid Student ID.',
    'Commitment to fair play, campus sportsmanship, and active Discord communication.',
    'Prior tournament or production experience is a bonus, but beginners are welcome.',
  ],
  headerImageUrl: '',
};

export const APPLICATION_DESIGNATIONS = ['HEAD', 'EXECUTIVE', 'ASSOCIATE'];

async function getRecruitment() {
  const existing = await RecruitmentModel.findOne({ singletonKey: SINGLETON }).lean();
  if (existing) return existing;
  const created = await RecruitmentModel.create(DEFAULT_RECRUITMENT);
  return created.toObject();
}

recruitmentRouter.get(
  '/',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const recruitment = await getRecruitment();
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    res.json({
      recruitment: { ...recruitment, _id: String(recruitment._id) },
    });
  })
);

recruitmentRouter.put(
  '/',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const openWings = Array.isArray(body.openWings)
      ? body.openWings.slice(0, 20).map((wing) => sanitizeText(wing, 80)).filter(Boolean)
      : [];
    const requirements = Array.isArray(body.requirements)
      ? body.requirements.slice(0, 20).map((item) => sanitizeText(item, 240)).filter(Boolean)
      : [];

    const current = await getRecruitment();
    const updated = await RecruitmentModel.findOneAndUpdate(
      { singletonKey: SINGLETON },
      {
        $set: {
          isOpen: Boolean(body.isOpen),
          title: sanitizeText(body.title, 140) || current.title,
          sessionLabel: sanitizeText(body.sessionLabel, 64) || current.sessionLabel,
          deadlineLabel: sanitizeText(body.deadlineLabel, 80) || current.deadlineLabel,
          announcement: sanitizeText(body.announcement, 1000, true) || current.announcement,
          openWings,
          requirements,
          headerImageUrl: sanitizeSafeImageUrl(body.headerImageUrl),
        },
      },
      { new: true }
    ).lean();

    res.json({ recruitment: { ...updated, _id: String(updated._id) } });
  })
);

recruitmentRouter.post(
  '/apply',
  requireApiKey,
  rateLimit('recruitment-apply', 10, 10 * 60_000),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const fullName = sanitizeText(body.fullName, 80);
    const department = sanitizeText(body.department, 100);
    const session = sanitizeText(body.session, 40);
    const studentId = sanitizeText(body.studentId, 32);
    const email = sanitizeText(body.email, 160);
    const phone = sanitizeText(body.phone, 32);
    const facebookUrl = sanitizeText(body.facebookUrl, 300);
    const discordTag = sanitizeText(body.discordTag, 64);
    const primaryGame = sanitizeText(body.primaryGame, 64);
    const wing = sanitizeText(body.wing, 80);
    const designation = sanitizeText(body.designation, 40).toUpperCase();
    const relevantSkills = sanitizeText(body.relevantSkills, 1000, true);
    const previousExperience = sanitizeText(body.previousExperience, 1000, true);
    const whyJoin = sanitizeText(body.whyJoin, 1000, true);
    const weeklyCommitment = sanitizeText(body.weeklyCommitment, 60);
    const offlineEvents = sanitizeText(body.offlineEvents, 40);
    const motivation = sanitizeText(body.motivation, 1000, true);

    const missing = [
      ['Full Name', fullName],
      ['Department', department],
      ['Session', session],
      ['Student ID', studentId],
      ['Email', email],
      ['Number', phone],
      ['Facebook Link', facebookUrl],
      ['DC ID', discordTag],
      ['Wing in CUEC', wing],
      ['Designation', designation],
      ['Esports Title', primaryGame],
      ['Relevant skills / experience', relevantSkills],
      ['Previous club / organization work', previousExperience],
      ['Why you want to join', whyJoin],
      ['Weekly commitment', weeklyCommitment],
      ['Offline campus events', offlineEvents],
      ['Competitive rank / portfolio', motivation],
    ]
      .filter(([, value]) => !value)
      .map(([label]) => label);

    if (missing.length > 0) {
      throw new ApiError(
        400,
        `Please complete every field (type N/A in the question fields if it does not apply): ${missing.join(', ')}.`
      );
    }
    if (!APPLICATION_DESIGNATIONS.includes(designation)) {
      throw new ApiError(400, 'Designation must be HEAD, EXECUTIVE, or ASSOCIATE.');
    }
    if (!isValidSafeEmail(email)) {
      throw new ApiError(400, 'Please provide a valid email address.');
    }

    const recruitment = await getRecruitment();
    if (recruitment && recruitment.isOpen === false) {
      throw new ApiError(400, 'Member recruitment is currently closed.');
    }

    const application = await MemberApplicationModel.create({
      memberCode: `CU-${new Date().getFullYear()}-${generateSecureFourDigits()}`,
      fullName,
      studentId,
      department,
      session,
      email,
      phone,
      facebookUrl,
      discordTag,
      primaryGame,
      wing,
      designation,
      motivation,
      relevantSkills,
      previousExperience,
      whyJoin,
      weeklyCommitment,
      offlineEvents,
      status: 'Pending',
    });

    await logActivity({
      kind: 'application',
      status: 'recorded',
      message: `Club application received: ${application.fullName}`,
    });

    res.status(201).json({
      application: {
        ...application.toObject(),
        _id: String(application._id),
      },
    });
  })
);

/* ------------------------------- Admin ---------------------------------- */

adminApplicationsRouter.get(
  '/',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const applications = await MemberApplicationModel.find().sort({ createdAt: -1 }).limit(1000).lean();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      applications: applications.map((application) => ({
        ...application,
        _id: String(application._id),
        createdAt: application.createdAt
          ? new Date(application.createdAt).toISOString()
          : new Date().toISOString(),
      })),
    });
  })
);

adminApplicationsRouter.patch(
  '/:id',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid application id.');

    const status = req.body?.status;
    if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
      throw new ApiError(400, 'Invalid application status.');
    }
    const rejectionReason = sanitizeText(req.body?.rejectionReason, 1000, true);

    const updated = await MemberApplicationModel.findByIdAndUpdate(
      id,
      { $set: { status, rejectionReason } },
      { new: true }
    ).lean();
    if (!updated) throw new ApiError(404, 'Application not found.');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ application: { ...updated, _id: String(updated._id) } });
  })
);

adminApplicationsRouter.delete(
  '/:id',
  requireApiKey,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(400, 'Invalid application id.');

    const removed = await MemberApplicationModel.findByIdAndDelete(id).lean();
    if (!removed) throw new ApiError(404, 'Application not found.');
    res.json({ deleted: true, id });
  })
);
