import crypto from 'node:crypto';
import { memberVerifySecret, isProduction } from './config.mjs';
import { MemberModel, MemberSettingsModel, DEFAULT_MEMBER_VISIBILITY } from './memberModels.mjs';

const MEMBER_WINDOW_KEY = 'member_photo_window';
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{8,32}$/;
const DEVELOPMENT_VERIFY_SECRET = 'cuec-local-member-verification-secret';

export { PUBLIC_ID_PATTERN };

export function isValidPublicId(value) {
  return typeof value === 'string' && PUBLIC_ID_PATTERN.test(value);
}

/* ------------------------------------------------------------------ *
 * Serializers: private fields never leave this module unmapped.
 * ------------------------------------------------------------------ */

export function serializePublicMember(member) {
  const photo = member.photo || {};
  return {
    publicId: member.publicId,
    name: member.name,
    position: member.position || '',
    wing: member.wing || '',
    department: member.department || '',
    batch: member.batch || '',
    session: member.session || '',
    bio: member.bio || '',
    gamesPlayed: member.gamesPlayed || [],
    achievements: member.achievements || [],
    contribution: member.contribution || '',
    photo: {
      url: photo.url || '',
      status: photo.status || 'none',
    },
    status: member.status || 'active',
    visibility: { ...DEFAULT_MEMBER_VISIBILITY, ...(member.visibility || {}) },
    scanCount: member.scanCount || 0,
    createdAt: member.createdAt,
  };
}

export function serializeAdminMember(member) {
  const photo = member.photo || {};
  return {
    publicId: member.publicId,
    name: member.name,
    position: member.position || '',
    wing: member.wing || '',
    department: member.department || '',
    session: member.session || '',
    gamesPlayed: member.gamesPlayed || [],
    status: member.status || 'active',
    photoStatus: photo.status || 'none',
    photoUrl:
      photo.status === 'approved' || photo.status === 'pending' ? photo.url || '' : '',
    submittedAt: photo.submittedAt || null,
    rejectionNote: photo.rejectionNote || '',
  };
}

/* ------------------------------------------------------------------ *
 * Identity helpers
 * ------------------------------------------------------------------ */

/** 12-character URL-safe CSPRNG identifier (~72 bits of entropy). */
export function generatePublicId() {
  return crypto.randomBytes(9).toString('base64url');
}

export async function generateUniquePublicId() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generatePublicId();
    const exists = await MemberModel.exists({ publicId: candidate });
    if (!exists) return candidate;
  }
  throw new Error('Could not allocate a unique member ID. Please retry.');
}

export function normalizeStudentId(value) {
  return String(value || '').replace(/[\s-]/g, '').toUpperCase();
}

function getVerificationSecret() {
  if (memberVerifySecret) return memberVerifySecret;
  if (!isProduction) return DEVELOPMENT_VERIFY_SECRET;
  console.warn(
    '[api] MEMBER_VERIFY_SECRET is not set. Photo verification hashes use a development fallback.'
  );
  return DEVELOPMENT_VERIFY_SECRET;
}

/** HMAC of the normalized student ID; the raw value is never stored twice. */
export function hashVerificationKey(studentId) {
  const normalized = normalizeStudentId(studentId);
  if (!normalized) return '';
  return crypto.createHmac('sha256', getVerificationSecret()).update(normalized).digest('hex');
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function listPublicMembers() {
  const docs = await MemberModel.find({ status: 'active' }).sort({ name: 1 }).lean();
  return docs.map(serializePublicMember);
}

export async function getMemberByPublicId(publicId) {
  if (!isValidPublicId(publicId)) return null;
  const doc = await MemberModel.findOne({ publicId }).lean();
  return doc ? serializePublicMember(doc) : null;
}

export async function listAdminMembers() {
  const docs = await MemberModel.find({}).sort({ name: 1 }).lean();
  return docs.map(serializeAdminMember);
}

export async function getMemberStats() {
  const [total, pending, approved, missing] = await Promise.all([
    MemberModel.countDocuments({}),
    MemberModel.countDocuments({ 'photo.status': 'pending' }),
    MemberModel.countDocuments({ 'photo.status': 'approved' }),
    MemberModel.countDocuments({ 'photo.status': { $in: ['none', 'rejected'] } }),
  ]);
  return { total, pending, approved, missing };
}

/**
 * Name search for the photo-submission page: returns ONLY public id, name and
 * whether a photo exists — never any private field.
 */
export async function searchMembersForPhoto(query) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return [];

  const docs = await MemberModel.find({
    status: 'active',
    name: new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  })
    .select('publicId name photo.status')
    .limit(8)
    .lean();

  return docs.map((doc) => {
    const photo = doc.photo || {};
    return {
      publicId: doc.publicId,
      name: doc.name,
      submitted: photo.status === 'pending' || photo.status === 'approved',
    };
  });
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export async function createMember(input) {
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw new Error('Member name is required.');

  const publicId = await generateUniquePublicId();
  const studentId = String(input.studentId || '').trim();

  const created = await MemberModel.create({
    publicId,
    name,
    position: String(input.position || '').trim(),
    wing: String(input.wing || '').trim(),
    department: String(input.department || '').trim(),
    batch: String(input.batch || '').trim(),
    session: String(input.session || '').trim(),
    bio: String(input.bio || '').trim(),
    gamesPlayed: (input.gamesPlayed || []).map((g) => String(g).trim()).filter(Boolean),
    achievements: (input.achievements || []).map((a) => String(a).trim()).filter(Boolean),
    contribution: String(input.contribution || '').trim(),
    email: String(input.email || '').trim().toLowerCase(),
    phone: String(input.phone || '').trim(),
    studentId,
    verificationKeyHash: hashVerificationKey(studentId),
    photo: {
      url: '',
      status: 'none',
      submittedAt: null,
      rejectionNote: '',
      ...(input.photo || {}),
    },
    status: input.status || 'active',
    visibility: { ...DEFAULT_MEMBER_VISIBILITY, ...(input.visibility || {}) },
  });

  return created.toObject();
}

export async function updateMemberByImport(publicId, patch) {
  const set = {};
  for (const key of ['position', 'wing', 'department', 'batch', 'session', 'bio', 'contribution', 'phone']) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
  if (patch.email !== undefined) set.email = String(patch.email).trim().toLowerCase();
  if (patch.gamesPlayed !== undefined) set.gamesPlayed = patch.gamesPlayed;
  if (patch.achievements !== undefined) set.achievements = patch.achievements;
  if (patch.studentId !== undefined) {
    set.studentId = patch.studentId;
    set.verificationKeyHash = hashVerificationKey(patch.studentId);
  }
  if (patch.imageUrl) {
    set.photo = {
      url: patch.imageUrl,
      status: 'approved',
      submittedAt: new Date(),
      rejectionNote: '',
    };
  }

  if (Object.keys(set).length === 0) return null;

  const updated = await MemberModel.findOneAndUpdate(
    { publicId },
    { $set: set },
    { returnDocument: 'after' }
  ).lean();
  return updated || null;
}

/**
 * Verifies a member by public id + CU student ID (exact normalized comparison)
 * and stores the uploaded photo as pending review. Returns `null` for any
 * mismatch so callers can answer with one generic error.
 */
export async function submitMemberPhoto(publicId, studentId, photoUrl) {
  if (!isValidPublicId(publicId)) return null;

  const typedId = normalizeStudentId(studentId);
  if (!typedId) return null;

  const doc = await MemberModel.findOne({ publicId, status: 'active' })
    .select('+studentId')
    .lean();
  if (!doc) return null;

  const storedId = normalizeStudentId(doc.studentId);
  if (!storedId || storedId !== typedId) return null;

  const updated = await MemberModel.findOneAndUpdate(
    { publicId },
    {
      $set: {
        photo: {
          url: photoUrl,
          status: 'pending',
          submittedAt: new Date(),
          rejectionNote: '',
        },
      },
    },
    { returnDocument: 'after' }
  ).lean();

  return updated || null;
}

export async function reviewMemberPhoto(publicId, status, rejectionNote = '') {
  if (!isValidPublicId(publicId)) return null;

  const existing = await MemberModel.findOne({ publicId }).lean();
  if (!existing) return null;
  const currentUrl = (existing.photo || {}).url || '';
  if (!currentUrl) return null;

  const updated = await MemberModel.findOneAndUpdate(
    { publicId },
    {
      $set: {
        'photo.status': status,
        'photo.rejectionNote':
          status === 'rejected' ? String(rejectionNote).trim().slice(0, 300) : '',
      },
    },
    { returnDocument: 'after' }
  ).lean();

  return updated || null;
}

/* ------------------------------------------------------------------ *
 * Photo submission window
 * ------------------------------------------------------------------ */

export async function getSubmissionWindow() {
  const doc = await MemberSettingsModel.findOneAndUpdate(
    { singletonKey: MEMBER_WINDOW_KEY },
    { $setOnInsert: { isOpen: false, opensAt: null, closesAt: null } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return {
    isOpen: Boolean(doc.isOpen),
    opensAt: doc.opensAt || null,
    closesAt: doc.closesAt || null,
  };
}

export async function saveSubmissionWindow(patch) {
  const update = {};
  if (typeof patch.isOpen === 'boolean') update.isOpen = patch.isOpen;
  if (patch.opensAt !== undefined) {
    update.opensAt = patch.opensAt ? new Date(patch.opensAt) : null;
  }
  if (patch.closesAt !== undefined) {
    update.closesAt = patch.closesAt ? new Date(patch.closesAt) : null;
  }

  const current = await getSubmissionWindow();
  const nextOpensAt =
    patch.opensAt !== undefined ? (patch.opensAt ? new Date(patch.opensAt) : null) : current.opensAt;
  const nextClosesAt =
    patch.closesAt !== undefined
      ? patch.closesAt
        ? new Date(patch.closesAt)
        : null
      : current.closesAt;

  if (nextOpensAt && nextClosesAt && nextClosesAt.getTime() <= nextOpensAt.getTime()) {
    throw new Error('The submission window must close after it opens.');
  }

  // A path cannot appear in both $set and $setOnInsert.
  const setOnInsert = {};
  if (!('isOpen' in update)) setOnInsert.isOpen = false;
  if (!('opensAt' in update)) setOnInsert.opensAt = null;
  if (!('closesAt' in update)) setOnInsert.closesAt = null;

  await MemberSettingsModel.findOneAndUpdate(
    { singletonKey: MEMBER_WINDOW_KEY },
    {
      $set: update,
      ...(Object.keys(setOnInsert).length > 0 ? { $setOnInsert: setOnInsert } : {}),
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return getSubmissionWindow();
}

/**
 * Effective state: the admin switch must be on AND the current time must fall
 * inside the configured range (when a bound is set).
 */
export function isSubmissionWindowOpen(window, now = new Date()) {
  if (!window || !window.isOpen) return false;
  if (window.opensAt && now.getTime() < new Date(window.opensAt).getTime()) return false;
  if (window.closesAt && now.getTime() > new Date(window.closesAt).getTime()) return false;
  return true;
}
