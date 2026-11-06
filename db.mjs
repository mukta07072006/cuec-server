import mongoose from 'mongoose';
import { mongoDbName, mongoUri } from './config.mjs';

/* ------------------------------------------------------------------ *
 * Tournament (registrations live in their own collection now)
 * ------------------------------------------------------------------ */

const PrizeTierSchema = new mongoose.Schema(
  { place: { type: String, required: true }, reward: { type: String, required: true } },
  { _id: false }
);

const BracketMatchSchema = new mongoose.Schema(
  {
    round: { type: String, required: true },
    matchup: { type: String, required: true },
    score: { type: String, required: true },
    status: { type: String, required: true },
  },
  { _id: false }
);

const BracketGroupMatchSchema = new mongoose.Schema(
  {
    id: { type: String, default: '' },
    round: { type: String, default: '' },
    teamA: { type: String, default: '' },
    teamB: { type: String, default: '' },
    dateLabel: { type: String, default: '' },
    score: { type: String, default: '' },
    status: { type: String, enum: ['SCHEDULED', 'LIVE NOW', 'COMPLETED'], default: 'SCHEDULED' },
  },
  { _id: false }
);

const BracketGroupSchema = new mongoose.Schema(
  {
    id: { type: String, default: '' },
    name: { type: String, required: true },
    matches: { type: [BracketGroupMatchSchema], default: [] },
  },
  { _id: false }
);

const TournamentSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    category: {
      type: String,
      enum: ['ongoing', 'upcoming', 'completed'],
      default: 'upcoming',
      index: true,
    },
    gameId: {
      type: String,
      enum: ['valorant', 'cs2', 'pubgm', 'freefire', 'mlbb', 'dota2', 'eafc', 'efootball'],
      required: true,
    },
    gameName: { type: String, required: true },
    bannerUrl: { type: String, default: '' },
    dateLabel: { type: String, default: '' },
    checkInLabel: { type: String, default: 'Discord Lobby Check-In 30 mins prior' },
    initialCountdownSeconds: { type: Number, default: 86400 },
    registrationStatus: {
      type: String,
      enum: ['Open', 'Closing Soon', 'Last 4 Slots'],
      default: 'Open',
    },
    entryFee: { type: String, default: 'Free (CU Students Only)' },
    prizePool: { type: String, required: true },
    prizeBreakdown: { type: [PrizeTierSchema], default: [] },
    slotsFilled: { type: Number, default: 0 },
    slotsTotal: { type: Number, default: 16 },
    teamSize: { type: String, default: '5 Players + 1 Sub' },
    requiredPlayers: { type: Number, enum: [1, 4, 5], default: 5 },
    allowSubstitute: { type: Boolean, default: true },
    inGameIdLabel: { type: String, default: 'In-Game ID / UID' },
    inGameIdPlaceholder: { type: String, default: 'Enter account ID' },
    venue: { type: String, default: 'Online Lobby' },
    rules: { type: [String], default: [] },
    showOnLanding: { type: Boolean, default: true },
    featureInHero: { type: Boolean, default: false },
    stageLabel: { type: String, default: 'Group Stage' },
    elapsedPercent: { type: Number, default: 25 },
    elapsedLabel: { type: String, default: 'Day 1 / 4' },
    format: { type: String, default: 'Double Elimination' },
    currentMatch: { type: String, default: 'Match Lobby Live' },
    bracketSummary: { type: [BracketMatchSchema], default: [] },
    bracketGroups: { type: [BracketGroupSchema], default: [] },
    championTeam: { type: String, default: '' },
    runnerUpTeam: { type: String, default: '' },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

/* ------------------------------------------------------------------ *
 * Tournament registrations — one document per team, linked by
 * `tournamentId` (ObjectId) and `tournamentSlug` (for URL lookups).
 * ------------------------------------------------------------------ */

const RosterMemberSchema = new mongoose.Schema(
  {
    role: { type: String, default: 'Player', maxlength: 32 },
    fullName: { type: String, default: '', maxlength: 80 },
    studentId: { type: String, default: '', maxlength: 32 },
    ign: { type: String, default: '', maxlength: 80 },
    inGameId: { type: String, default: '', maxlength: 64 },
  },
  { _id: false }
);

const TournamentRegistrationSchema = new mongoose.Schema(
  {
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      required: true,
      index: true,
    },
    tournamentSlug: { type: String, required: true, index: true },
    name: { type: String, required: true, maxlength: 80 },
    tag: { type: String, default: 'CU', maxlength: 8 },
    department: { type: String, default: 'CU', maxlength: 60 },
    status: {
      type: String,
      enum: ['Verified', 'Pending Check-In', 'Approved', 'Rejected'],
      default: 'Pending Check-In',
      index: true,
    },
    rejectionReason: { type: String, default: '', maxlength: 1000 },
    passCode: { type: String, required: true, maxlength: 40 },
    captainName: { type: String, default: '', maxlength: 80 },
    captainStudentId: { type: String, default: '', maxlength: 32 },
    captainEmail: { type: String, default: '', maxlength: 160 },
    captainDiscord: { type: String, default: '', maxlength: 64 },
    captainInGameId: { type: String, default: '', maxlength: 64 },
    rosterMembers: { type: [RosterMemberSchema], default: [] },
    source: { type: String, default: 'web' },
  },
  { timestamps: true }
);

// One pass code per tournament, and fast "all entries for this tournament" reads.
TournamentRegistrationSchema.index({ tournamentId: 1, passCode: 1 }, { unique: true });
TournamentRegistrationSchema.index({ tournamentId: 1, createdAt: -1 });
TournamentRegistrationSchema.index({ tournamentSlug: 1, createdAt: -1 });

/* ------------------------------------------------------------------ *
 * Recruitment + member applications + activity log
 * ------------------------------------------------------------------ */

const RecruitmentSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, default: 'active_recruitment', unique: true },
    isOpen: { type: Boolean, default: true },
    title: { type: String, required: true },
    sessionLabel: { type: String, required: true },
    deadlineLabel: { type: String, required: true },
    announcement: { type: String, required: true },
    openWings: { type: [String], default: [] },
    requirements: { type: [String], default: [] },
    headerImageUrl: { type: String, default: '' },
  },
  { timestamps: true }
);

const MemberApplicationSchema = new mongoose.Schema(
  {
    memberCode: { type: String, required: true },
    fullName: { type: String, required: true },
    studentId: { type: String, required: true },
    department: { type: String, required: true },
    session: { type: String, default: '', maxlength: 40 },
    email: { type: String, required: true },
    phone: { type: String, default: '', maxlength: 32 },
    facebookUrl: { type: String, default: '', maxlength: 300 },
    discordTag: { type: String, default: '' },
    primaryGame: { type: String, required: true },
    wing: { type: String, required: true },
    designation: { type: String, default: '', maxlength: 40 },
    motivation: { type: String, default: '' },
    relevantSkills: { type: String, default: '', maxlength: 1000 },
    previousExperience: { type: String, default: '', maxlength: 1000 },
    whyJoin: { type: String, default: '', maxlength: 1000 },
    weeklyCommitment: { type: String, default: '', maxlength: 60 },
    offlineEvents: { type: String, default: '', maxlength: 40 },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    rejectionReason: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: true }
);

const ActivityLogSchema = new mongoose.Schema(
  {
    kind: { type: String, required: true },
    status: { type: String, required: true },
    message: { type: String, required: true },
    recipient: { type: String, default: '' },
    subject: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const TournamentModel =
  mongoose.models.Tournament || mongoose.model('Tournament', TournamentSchema);

export const TournamentRegistrationModel =
  mongoose.models.TournamentRegistration ||
  mongoose.model('TournamentRegistration', TournamentRegistrationSchema);

export const RecruitmentModel =
  mongoose.models.Recruitment || mongoose.model('Recruitment', RecruitmentSchema);

export const MemberApplicationModel =
  mongoose.models.MemberApplication ||
  mongoose.model('MemberApplication', MemberApplicationSchema);

export const ActivityLogModel =
  mongoose.models.ActivityLog || mongoose.model('ActivityLog', ActivityLogSchema);

/* ------------------------------------------------------------------ *
 * Connection + serializers
 * ------------------------------------------------------------------ */

let connecting = null;

export async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connecting) return connecting;

  connecting = mongoose
    .connect(mongoUri, { dbName: mongoDbName, serverSelectionTimeoutMS: 8000 })
    .then(async () => {
      // Index creation is idempotent; `syncIndexes` keeps unique constraints honest.
      await Promise.all([
        TournamentRegistrationModel.syncIndexes(),
        TournamentModel.syncIndexes(),
      ]);
      return mongoose.connection;
    })
    .catch((error) => {
      connecting = null;
      throw error;
    });

  return connecting;
}

export function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

export async function logActivity(input) {
  try {
    await ActivityLogModel.create(input);
  } catch {
    // Logging must never fail a request.
  }
}

export function serializeTournament(doc) {
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    ...plain,
    _id: String(plain._id),
    createdAt: plain.createdAt ? new Date(plain.createdAt).toISOString() : undefined,
    updatedAt: plain.updatedAt ? new Date(plain.updatedAt).toISOString() : undefined,
  };
}

/** Public tournament: keeps the roster summary for the public pages. */
export function serializePublicTournament(doc, registrations = []) {
  const tournament = serializeTournament(doc);
  delete tournament.isDeleted;
  return {
    ...tournament,
    registeredSquads: registrations.map((registration) => ({
      name: registration.name,
      tag: registration.tag,
      department: registration.department,
      status: registration.status,
    })),
  };
}
