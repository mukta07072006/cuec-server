/**
 * One-off migration: moves `tournament.registeredSquads[]` (the old embedded
 * array) into the dedicated `tournamentregistrations` collection.
 *
 * Usage:
 *   node api-server/scripts/migrate-registrations.mjs            # move + clean arrays
 *   node api-server/scripts/migrate-registrations.mjs --dry-run  # report only
 *   node api-server/scripts/migrate-registrations.mjs --keep-array
 *
 * Safe to re-run: entries already present (same tournament + pass code, or same
 * tournament + team name when the old entry has no pass code) are skipped.
 */
import { connectDatabase, TournamentModel, TournamentRegistrationModel } from '../db.mjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const keepArray = args.has('--keep-array');

function normalizeSquad(squad) {
  return {
    name: String(squad?.name || '').slice(0, 80),
    tag: String(squad?.tag || 'CU').slice(0, 8).toUpperCase(),
    department: String(squad?.department || 'CU').slice(0, 60),
    status: ['Verified', 'Pending Check-In', 'Approved', 'Rejected'].includes(squad?.status)
      ? squad.status
      : 'Pending Check-In',
    rejectionReason: String(squad?.rejectionReason || '').slice(0, 1000),
    passCode: String(squad?.passCode || '').slice(0, 40),
    captainName: String(squad?.captainName || '').slice(0, 80),
    captainStudentId: String(squad?.captainStudentId || '').slice(0, 32),
    captainEmail: String(squad?.captainEmail || '').slice(0, 160),
    captainDiscord: String(squad?.captainDiscord || '').slice(0, 64),
    captainInGameId: String(squad?.captainInGameId || '').slice(0, 64),
    rosterMembers: Array.isArray(squad?.rosterMembers)
      ? squad.rosterMembers.slice(0, 8).map((member) => ({
          role: String(member?.role || 'Player').slice(0, 32),
          fullName: String(member?.fullName || '').slice(0, 80),
          studentId: String(member?.studentId || '').slice(0, 32),
          ign: String(member?.ign || '').slice(0, 80),
          inGameId: String(member?.inGameId || '').slice(0, 64),
        }))
      : [],
    source: 'legacy-array',
  };
}

async function main() {
  await connectDatabase();
  console.log(`[migrate] dryRun=${dryRun} keepArray=${keepArray}`);

  const tournaments = await TournamentModel.find({}).lean();
  let inserted = 0;
  let skipped = 0;
  let touchedTournaments = 0;

  for (const tournament of tournaments) {
    const squads = Array.isArray(tournament.registeredSquads) ? tournament.registeredSquads : [];
    if (squads.length === 0) continue;

    touchedTournaments += 1;

    for (const rawSquad of squads) {
      const squad = normalizeSquad(rawSquad);
      if (!squad.name) {
        skipped += 1;
        continue;
      }

      const duplicateQuery = squad.passCode
        ? { tournamentId: tournament._id, passCode: squad.passCode }
        : { tournamentId: tournament._id, name: squad.name };

      const exists = await TournamentRegistrationModel.exists(duplicateQuery);
      if (exists) {
        skipped += 1;
        continue;
      }

      // The new schema requires a unique pass code per tournament; legacy rows
      // without one get a stable placeholder derived from their document id.
      const passCode = squad.passCode || `LEGACY-${String(tournament._id).slice(-6)}-${inserted + 1}`;

      if (!dryRun) {
        await TournamentRegistrationModel.create({
          ...squad,
          passCode,
          tournamentId: tournament._id,
          tournamentSlug: tournament.slug,
        });
      }
      inserted += 1;
    }

    if (!dryRun) {
      const total = await TournamentRegistrationModel.countDocuments({ tournamentId: tournament._id });
      await TournamentModel.updateOne(
        { _id: tournament._id },
        {
          $set: { slotsFilled: Math.max(Number(tournament.slotsFilled) || 0, total) },
          ...(keepArray ? {} : { $unset: { registeredSquads: '' } }),
        }
      );
    }
  }

  console.log(
    `[migrate] tournaments scanned=${tournaments.length} withLegacyEntries=${touchedTournaments} inserted=${inserted} skipped=${skipped}`
  );
  if (dryRun) console.log('[migrate] dry run — nothing was written.');
  process.exit(0);
}

main().catch((error) => {
  console.error('[migrate] failed:', error);
  process.exit(1);
});
