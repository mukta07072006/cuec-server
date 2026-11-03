import path from 'node:path';
import dotenv from 'dotenv';

// The API server shares the project's env files so both processes read the same
// MongoDB URI and secrets. `.env.local` wins over `.env`, matching Next.js.
dotenv.config({
  path: [path.resolve(process.cwd(), '.env.local'), path.resolve(process.cwd(), '.env')],
  quiet: true,
});

const trim = (value) => (typeof value === 'string' ? value.trim() : '');

export const isProduction = process.env.NODE_ENV === 'production';

export const port = Number(trim(process.env.API_PORT) || 4000);

export const mongoUri = trim(process.env.MONGODB_URI);
export const mongoDbName = trim(process.env.MONGO_DB_NAME) || 'CUEC';

/** Public client key. Shipped to the browser, so it guards volume, not secrets. */
export const clientApiKey = trim(process.env.API_KEY);

/** Shared secret used to verify short-lived admin tokens minted by the Next app. */
export const adminTokenSecret = trim(process.env.ADMIN_TOKEN_SECRET);

/** Server-to-server key (optional) for scripts and the migration tooling. */
export const serviceApiKey = trim(process.env.SERVICE_API_KEY);

export const allowedOrigins = trim(process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

/** Cloudinary/Resend are optional: the API degrades cleanly when unset. */
export const resendApiKey = trim(process.env.RESEND_API_KEY);
export const emailFrom = trim(process.env.EMAIL_FROM) || 'CU Esports Club <no-reply@cuec.club>';
export const siteUrl = trim(process.env.SITE_URL) || 'http://localhost:3000';

export const ADMIN_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Fails fast on missing configuration instead of starting a half-working API.
 * In development a missing key is fatal too: a silent no-auth fallback is worse.
 */
export function assertConfig() {
  const problems = [];
  if (!mongoUri) problems.push('MONGODB_URI is required (MongoDB connection string).');
  if (clientApiKey.length < 16) {
    problems.push('API_KEY is required and must be at least 16 characters.');
  }
  if (adminTokenSecret.length < 32) {
    problems.push('ADMIN_TOKEN_SECRET is required and must be at least 32 characters.');
  }
  if (problems.length > 0) {
    throw new Error(`API server configuration error:\n- ${problems.join('\n- ')}`);
  }
}
