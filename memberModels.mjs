import mongoose from 'mongoose';

/**
 * Member "digital ID" collections. Same database and collection names as the
 * Next app used before the split, so existing data keeps working untouched.
 */

export const DEFAULT_MEMBER_VISIBILITY = {
  department: true,
  batch: true,
  session: true,
  bio: true,
  contributions: true,
  achievements: true,
  gamesPlayed: true,
};

const MemberPhotoSchema = new mongoose.Schema(
  {
    url: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none',
      index: true,
    },
    submittedAt: { type: Date, default: null },
    rejectionNote: { type: String, default: '', trim: true, maxlength: 300 },
  },
  { _id: false }
);

const MemberVisibilitySchema = new mongoose.Schema(
  {
    department: { type: Boolean, default: true },
    batch: { type: Boolean, default: true },
    session: { type: Boolean, default: true },
    bio: { type: Boolean, default: true },
    contributions: { type: Boolean, default: true },
    achievements: { type: Boolean, default: true },
    gamesPlayed: { type: Boolean, default: true },
  },
  { _id: false }
);

const MemberSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    position: { type: String, default: '', trim: true, maxlength: 80 },
    wing: { type: String, default: '', trim: true, maxlength: 80 },
    department: { type: String, default: '', trim: true, maxlength: 80 },
    batch: { type: String, default: '', trim: true, maxlength: 40 },
    session: { type: String, default: '', trim: true, maxlength: 40 },
    bio: { type: String, default: '', trim: true, maxlength: 600 },
    gamesPlayed: { type: [String], default: [] },
    achievements: { type: [String], default: [] },
    contribution: { type: String, default: '', trim: true, maxlength: 800 },

    // Private fields: excluded from queries unless explicitly selected.
    email: { type: String, default: '', trim: true, lowercase: true, index: true, select: false },
    phone: { type: String, default: '', trim: true, select: false },
    studentId: { type: String, default: '', trim: true, index: true, select: false },
    verificationKeyHash: { type: String, default: '', select: false },

    photo: { type: MemberPhotoSchema, default: () => ({}) },
    status: {
      type: String,
      enum: ['active', 'inactive', 'revoked'],
      default: 'active',
      index: true,
    },
    visibility: { type: MemberVisibilitySchema, default: () => DEFAULT_MEMBER_VISIBILITY },
    scanCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

MemberSchema.index({ status: 1, 'photo.status': 1 });
MemberSchema.index({ name: 1 });

const MemberSettingsSchema = new mongoose.Schema(
  {
    singletonKey: {
      type: String,
      default: 'member_photo_window',
      unique: true,
      index: true,
    },
    isOpen: { type: Boolean, default: false },
    opensAt: { type: Date, default: null },
    closesAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const MemberModel =
  mongoose.models.Member || mongoose.model('Member', MemberSchema);

const AchievementSchema = new mongoose.Schema(
  {
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, default: '', trim: true, maxlength: 800 },
    date: { type: Date, default: Date.now },
    link: { type: String, default: '', trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

AchievementSchema.index({ memberId: 1, date: -1 });

export const MemberAchievementModel =
  mongoose.models.MemberAchievement ||
  mongoose.model('MemberAchievement', AchievementSchema);

export const MemberSettingsModel =
  mongoose.models.MemberSettings || mongoose.model('MemberSettings', MemberSettingsSchema);
