import crypto from 'node:crypto';
import { ADMIN_TOKEN_TTL_MS, adminTokenSecret, clientApiKey, serviceApiKey } from './config.mjs';

/* ------------------------------------------------------------------ *
 * Text / URL sanitizers (same rules as the Next app)
 * ------------------------------------------------------------------ */

export function sanitizeText(raw, maxLength = 160, allowNewlines = false) {
  if (typeof raw !== 'string') return '';
  const cleaned = allowNewlines
    ? raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    : raw.replace(/[\x00-\x1F\x7F]/g, ' ');
  return cleaned.trim().slice(0, maxLength);
}

export function sanitizeSafeImageUrl(raw) {
  const str = sanitizeText(raw, 500);
  if (!str) return '';
  if (str.startsWith('/')) {
    if (str.startsWith('//') || str.includes('..') || str.includes('\\')) return '';
    return str;
  }
  try {
    const parsed = new URL(str);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
    return '';
  } catch {
    return '';
  }
}

export function isValidSafeEmail(email) {
  if (!email || email.length > 160 || email.includes(' ')) return false;
  const atIndex = email.indexOf('@');
  if (atIndex <= 0 || atIndex !== email.lastIndexOf('@')) return false;
  const domain = email.slice(atIndex + 1);
  if (domain.length < 3 || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return false;
  }
  return true;
}

export function slugifyTournamentName(raw) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export const ALLOWED_GAME_IDS = [
  'valorant',
  'cs2',
  'pubgm',
  'freefire',
  'mlbb',
  'dota2',
  'eafc',
  'efootball',
];

export function isValidGameId(value) {
  return typeof value === 'string' && ALLOWED_GAME_IDS.includes(value);
}

export const GAME_DEFAULTS = {
  valorant: { name: 'Valorant', uidLabel: 'Riot ID (Name#TAG)', uidPlaceholder: 'e.g. RadiantCU#BD1' },
  pubgm: { name: 'PUBG Mobile', uidLabel: 'PUBGM Character UID', uidPlaceholder: 'e.g. 51294810234' },
  cs2: { name: 'Counter-Strike 2', uidLabel: 'Steam64 / FACEIT Nickname', uidPlaceholder: 'e.g. s1mple_cu' },
  mlbb: { name: 'Mobile Legends', uidLabel: 'MLBB Account ID (Server)', uidPlaceholder: 'e.g. 482910421 (2048)' },
  freefire: { name: 'Free Fire', uidLabel: 'Free Fire Player UID', uidPlaceholder: 'e.g. 1928374650' },
  eafc: { name: 'EA Sports FC', uidLabel: 'EA Account ID', uidPlaceholder: 'e.g. CU_Striker99' },
  efootball: { name: 'eFootball', uidLabel: 'Konami / eFootball Owner ID', uidPlaceholder: 'e.g. ASDF-123-456-789' },
  dota2: { name: 'Dota 2', uidLabel: 'Dota 2 Friend ID', uidPlaceholder: 'e.g. 149283712' },
};

export function generateSecureFourDigits() {
  return crypto.randomInt(1000, 10000);
}

export function generateObjectIdHex() {
  return crypto.randomBytes(12).toString('hex');
}

/* ------------------------------------------------------------------ *
 * Constant-time secret comparison
 * ------------------------------------------------------------------ */

export function safeCompare(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  if (!received || !expected) return false;
  const a = crypto.createHash('sha256').update(received, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

export function isClientApiKeyValid(received) {
  return safeCompare(received || '', clientApiKey);
}

export function isServiceKeyValid(received) {
  return Boolean(serviceApiKey) && safeCompare(received || '', serviceApiKey);
}

/* ------------------------------------------------------------------ *
 * Admin tokens: HMAC-signed, short-lived, minted by the Next app for
 * signed-in admins. The browser never sees ADMIN_TOKEN_SECRET.
 * ------------------------------------------------------------------ */

function sign(payload) {
  return crypto.createHmac('sha256', adminTokenSecret).update(payload).digest('hex');
}

export function issueAdminToken(subject, ttlMs = ADMIN_TOKEN_TTL_MS) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const nonce = crypto.randomBytes(10).toString('hex');
  const payload = `cuec-api.${sanitizeText(subject, 80) || 'admin'}.${issuedAt}.${expiresAt}.${nonce}`;
  return Buffer.from(`${payload}.${sign(payload)}`, 'utf8').toString('base64url');
}

export function verifyAdminToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length > 700) return null;
  try {
    const decoded = Buffer.from(rawToken, 'base64url').toString('utf8');
    const parts = decoded.split('.');
    if (parts.length !== 6) return null;
    const [prefix, subject, issuedStr, expiresStr, nonce, providedSig] = parts;
    if (prefix !== 'cuec-api' || !nonce || !providedSig) return null;

    const issuedAt = Number(issuedStr);
    const expiresAt = Number(expiresStr);
    const now = Date.now();
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
    if (now > expiresAt) return null;
    if (expiresAt - issuedAt > ADMIN_TOKEN_TTL_MS + 60_000) return null;

    const payload = `${prefix}.${subject}.${issuedStr}.${expiresStr}.${nonce}`;
    const expected = sign(payload);
    const providedBuf = Buffer.from(providedSig, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (providedBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) return null;

    return { subject, expiresAt };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Sliding-window rate limiter (per IP + bucket)
 * ------------------------------------------------------------------ */

const rateLimits = new Map();
const MAX_TRACKED_KEYS = 20_000;

export function checkRateLimit(req, bucket, maxRequests, windowMs) {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  const clientIp =
    forwarded.split(',')[0]?.trim() || String(req.headers['x-real-ip'] || '') || req.ip || 'local';
  const key = `${bucket}:${clientIp}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  const existing = (rateLimits.get(key) || []).filter((ts) => ts > windowStart);
  if (existing.length >= maxRequests) {
    const oldest = existing[0] || now;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
  }

  existing.push(now);
  rateLimits.set(key, existing);

  if (rateLimits.size > MAX_TRACKED_KEYS) {
    for (const [trackedKey, timestamps] of rateLimits.entries()) {
      if (timestamps.every((ts) => ts <= windowStart)) rateLimits.delete(trackedKey);
    }
  }

  return { allowed: true, retryAfterSec: 0 };
}

/* ------------------------------------------------------------------ *
 * Response shaping
 * ------------------------------------------------------------------ */

const PUBLIC_SQUAD_STATUSES = ['Verified', 'Pending Check-In', 'Approved', 'Rejected'];

export function isValidSquadStatus(value) {
  return PUBLIC_SQUAD_STATUSES.includes(value);
}

/** Public view of a registration: no contact details, student IDs or pass codes. */
export function redactRegistration(registration) {
  return {
    id: String(registration._id),
    name: registration.name,
    tag: registration.tag,
    department: registration.department,
    status: registration.status,
    rosterSize: Array.isArray(registration.rosterMembers) ? registration.rosterMembers.length : 0,
    inGameIds: (registration.rosterMembers || [])
      .map((member) => sanitizeText(member?.ign || member?.inGameId, 64))
      .filter(Boolean),
    createdAt: registration.createdAt,
  };
}

export function serializeRegistration(registration) {
  return {
    id: String(registration._id),
    tournamentId: String(registration.tournamentId),
    tournamentSlug: registration.tournamentSlug,
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
    rosterMembers: (registration.rosterMembers || []).map((member) => ({
      role: member.role || 'Player',
      fullName: member.fullName || '',
      studentId: member.studentId || '',
      ign: member.ign || '',
      inGameId: member.inGameId || '',
    })),
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
  };
}
