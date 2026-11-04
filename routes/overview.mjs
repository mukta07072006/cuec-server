import { Router } from 'express';
import { asyncHandler, requireAdmin } from '../http.mjs';
import {
  ActivityLogModel,
  MemberApplicationModel,
  RecruitmentModel,
  TournamentModel,
  TournamentRegistrationModel,
  serializeTournament,
} from '../db.mjs';

/**
 * Everything the admin console needs in one authenticated call. Team
 * registrations are folded in so slot counts and the roster drawer have the
 * shape the UI already knows.
 */
export const adminOverviewRouter = Router();

adminOverviewRouter.get(
  '/overview',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const [tournaments, registrations, recruitment, applications, activityLogs] =
      await Promise.all([
        TournamentModel.find({ isDeleted: { $ne: true } }).sort({ createdAt: -1 }).lean(),
        TournamentRegistrationModel.find({}).sort({ createdAt: -1 }).lean(),
        RecruitmentModel.findOne({ singletonKey: 'active_recruitment' }).lean(),
        MemberApplicationModel.find().sort({ createdAt: -1 }).limit(1000).lean(),
        ActivityLogModel.find().sort({ createdAt: -1 }).limit(100).lean(),
      ]);

    const grouped = {};
    for (const registration of registrations) {
      if (!registration.tournamentSlug) continue;
      (grouped[registration.tournamentSlug] ||= []).push(registration);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      storageEngine: 'mongodb',
      tournaments: tournaments.map((tournament) => ({
        ...serializeTournament(tournament),
        registeredSquads: (grouped[tournament.slug] || []).map((registration) => ({
          id: String(registration._id),
          name: registration.name,
          tag: registration.tag,
          department: registration.department,
          status: registration.status,
          rejectionReason: registration.rejectionReason || '',
          passCode: registration.passCode || '',
          captainName: registration.captainName || '',
          captainStudentId: registration.captainStudentId || '',
          captainEmail: registration.captainEmail || '',
          captainDiscord: registration.captainDiscord || '',
          captainInGameId: registration.captainInGameId || '',
          rosterMembers: registration.rosterMembers || [],
          createdAt: registration.createdAt,
        })),
      })),
      recruitment: recruitment ? { ...recruitment, _id: String(recruitment._id) } : null,
      applications: applications.map((application) => ({
        ...application,
        _id: String(application._id),
        createdAt: application.createdAt
          ? new Date(application.createdAt).toISOString()
          : new Date().toISOString(),
      })),
      activityLogs: activityLogs.map((log) => ({ ...log, _id: String(log._id) })),
    });
  })
);
