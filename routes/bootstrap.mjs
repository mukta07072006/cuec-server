import { Router } from 'express';
import { asyncHandler } from '../http.mjs';
import {
  RecruitmentModel,
  TournamentModel,
  TournamentRegistrationModel,
  serializePublicTournament,
} from '../db.mjs';

/**
 * One call the public client makes on load: public tournaments (with roster
 * summaries) plus the recruitment banner state.
 */
export const bootstrapRouter = Router();

bootstrapRouter.get(
  '/bootstrap',
  asyncHandler(async (req, res) => {
    const [tournaments, registrations, recruitment] = await Promise.all([
      TournamentModel.find({ isDeleted: { $ne: true } }).sort({ createdAt: -1 }).lean(),
      TournamentRegistrationModel.find({})
        .select('tournamentSlug name tag department status')
        .sort({ createdAt: -1 })
        .lean(),
      RecruitmentModel.findOne({ singletonKey: 'active_recruitment' }).lean(),
    ]);

    const grouped = {};
    for (const registration of registrations) {
      if (!registration.tournamentSlug) continue;
      (grouped[registration.tournamentSlug] ||= []).push(registration);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      tournaments: tournaments.map((tournament) =>
        serializePublicTournament(tournament, grouped[tournament.slug] || [])
      ),
      recruitment: recruitment ? { ...recruitment, _id: String(recruitment._id) } : null,
    });
  })
);
