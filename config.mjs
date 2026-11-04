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

// Railway/Render/Heroku inject PORT; API_PORT stays the local override.
export const port = Number(trim(process.env.PORT) || trim(process.env.API_PORT) || 4000);

export const mongoUri = trim(process.env.MONGODB_URI);
export const mongoDbName = trim(process.env.MONGO_DB_NAME) || 'CUEC';

/**
 * Hosts from the connection string, credentials stripped. Handles both forms:
 * `mongodb+srv://user:pass@cluster0.abcde.mongodb.net/db` and the multi-shard
 * `mongodb://user:pass@h1:27017,h2:27017,h3:27017/db?ssl=true`. The last `@`
 * wins so an unencoded password containing `@` cannot truncate the host.
 */
export function mongoHosts() {
  if (!mongoUri) return [];
  const withoutScheme = mongoUri.replace(/^mongodb(\+srv)?:\/\//i, '');
  const at = withoutScheme.lastIndexOf('@');
  const afterCredentials = at === -1 ? withoutScheme : withoutScheme.slice(at + 1);
  return afterCredentials
    .split(/[/?]/)[0]
    .split(',')
    .map((host) => host.split(':')[0].trim())
    .filter(Boolean);
}

/** Safe for logs: hostnames only, never the username or password. */
export const mongoHostLabel = mongoHosts().join(', ') || '(no host in MONGODB_URI)';

/**
 * True for the host used in this repo's examples. A real Atlas host always has
 * a generated subdomain (`cluster0.znex6tg.mongodb.net`), so the bare
 * `cluster.mongodb.net` can only come from a copied template.
 */
export function isPlaceholderMongoHost() {
  return mongoHosts().some(
    (host) =>
      /^(cluster|cluster0|host|example|your-cluster)\.mongodb\.net$/i.test(host) ||
      host.includes('xxxxx') ||
      host.includes('<') ||
      host.includes('>')
  );
}

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

/** Cloudinary (tournament banners + member ID photos). Optional but needed for uploads. */
export const cloudinaryCloudName = trim(process.env.CLOUDINARY_CLOUD_NAME);
export const cloudinaryApiKey = trim(process.env.CLOUDINARY_API_KEY);
export const cloudinaryApiSecret = trim(process.env.CLOUDINARY_API_SECRET);
export const cloudinaryUploadPreset = trim(process.env.CLOUDINARY_UPLOAD_PRESET);

/**
 * Secret hashing CU student IDs for photo verification. Falls back to the auth
 * secret so hashes generated before the server split stay comparable.
 */
export const memberVerifySecret =
  trim(process.env.MEMBER_VERIFY_SECRET) || trim(process.env.BETTER_AUTH_SECRET);

export const ADMIN_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Fails fast on missing configuration instead of starting a half-working API.
 * In development a missing key is fatal too: a silent no-auth fallback is worse.
 */
export function assertConfig() {
  const problems = [];
  if (!mongoUri) problems.push('MONGODB_URI is required (MongoDB connection string).');
  if (mongoUri && isPlaceholderMongoHost()) {
    problems.push(
      `MONGODB_URI uses the example host ${mongoHostLabel}, which does not exist. ` +
        'Copy the real string from MongoDB Atlas → Connect → Drivers and replace the whole value.'
    );
  }
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
