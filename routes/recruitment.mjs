import { Router } from 'express';
import mongoose from 'mongoose';
import {
  generateSecureFourDigits,
  isValidSafeEmail,
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

async function getRecruitment() {
  const existing = await RecruitmentModel.findOne({ singletonKey: SINGLETON }).lean();
  return existing;
}

recruitmentRouter.get(
  '/',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const recruitment = await getRecruitment();
    if (!recruitment) throw new ApiError(404, 'Recruitment configuration not found.');

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
    if (!current) throw new ApiError(404, 'Recruitment configuration not found.');

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
    const studentId = sanitizeText(body.studentId, 32);
    const email = sanitizeText(body.email, 160);
    const wing = sanitizeText(body.wing, 80);

    if (!fullName || !studentId || !email || !wing) {
      throw new ApiError(
        400,
        'Full Name, CU Student ID, Email, and Wing selection are required.'
      );
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
      department: sanitizeText(body.department, 100) || 'University of Chittagong',
      email,
      discordTag: sanitizeText(body.discordTag, 64),
      primaryGame: sanitizeText(body.primaryGame, 64) || 'Valorant',
      wing,
      motivation: sanitizeText(body.motivation, 1000, true),
      relevantSkills: sanitizeText(body.relevantSkills, 1000, true),
      previousExperience: sanitizeText(body.previousExperience, 1000, true),
      whyJoin: sanitizeText(body.whyJoin, 1000, true),
      weeklyCommitment: sanitizeText(body.weeklyCommitment, 60),
      offlineEvents: sanitizeText(body.offlineEvents, 40),
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
