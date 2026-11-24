import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  adminTokenSecretFingerprint,
  allowedOrigins,
  assertConfig,
  isPlaceholderAdminTokenSecret,
  isProduction,
  mongoHostLabel,
  port,
} from './config.mjs';
import { connectDatabase, isDatabaseReady } from './db.mjs';
import {
  ApiError,
  corsOptions,
  errorHandler,
  notFoundHandler,
  rateLimit,
  requestLogger,
  requireApiKey,
  requireTrustedOrigin,
  securityHeaders,
} from './http.mjs';
import { tournamentsRouter } from './routes/tournaments.mjs';
import {
  adminRegistrationsRouter,
  publicRegistrationsRouter,
} from './routes/registrations.mjs';
import { adminApplicationsRouter, recruitmentRouter } from './routes/recruitment.mjs';
import { adminMembersRouter, publicMembersRouter } from './routes/members.mjs';
import { uploadsRouter } from './routes/uploads.mjs';
import { bootstrapRouter } from './routes/bootstrap.mjs';
import { adminOverviewRouter } from './routes/overview.mjs';

assertConfig();

/**
 * Serverless hosts (Vercel) import the app instead of running the listener at
 * the bottom of this file, so the first API request has to open MongoDB itself.
 * `connectDatabase()` caches its promise, so once connected this is a single
 * `readyState` check per request.
 */
async function ensureDatabase(req, res, next) {
  if (isDatabaseReady()) return next();
  try {
    await connectDatabase();
    next();
  } catch (error) {
    next(error);
  }
}

export function createApp() {
  const app = express();

  // Behind a proxy (nginx / Cloudflare / Vercel) so rate limits use the real IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(cors({ origin: corsOptions, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] }));

  // Base64 image uploads carry large bodies, so their router installs its own
  // sized JSON parser before the small global one below.
  app.use('/api/uploads', uploadsRouter);

  // Member ID photos are sent as ~7 MB base64 JSON; everything else stays
  // under the 96 kB cap imposed below.
  app.use('/api/members/photo', express.json({ limit: '8mb' }));

  // JSON only, hard size cap: registration bodies are small.
  app.use(express.json({ limit: '96kb' }));
  app.use(requestLogger);

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'cuec-api',
      database: isDatabaseReady() ? 'connected' : 'disconnected',
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Lightweight liveness probe for uptime monitors and platform health checks.
  // No database call and no API key, so it stays fast and cheap to ping.
  app.get(['/ping', '/api/ping'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      service: 'cuec-api',
      message: 'pong',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Every API route below requires the client API key and a trusted origin
  // for mutations. Admin-only routes additionally require an admin token.
  const api = express.Router();
  api.use(requireApiKey);
  api.use(requireTrustedOrigin);
  api.use(rateLimit('api', 300, 60_000));
  // After the key/origin checks, so rejected requests never touch MongoDB.
  api.use(ensureDatabase);

  api.use('/tournaments', tournamentsRouter);
  api.use(publicRegistrationsRouter);
  api.use('/recruitment', recruitmentRouter);
  api.use('/members', publicMembersRouter);
  api.use(bootstrapRouter);

  const admin = express.Router();
  admin.use(requireApiKey);
  admin.use(requireTrustedOrigin);
  admin.use(rateLimit('admin', 240, 60_000));
  admin.use('/registrations', adminRegistrationsRouter);
  admin.use('/applications', adminApplicationsRouter);
  admin.use('/members', adminMembersRouter);
  admin.use(adminOverviewRouter);

  api.use('/admin', admin);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * True only when this file was started directly (`node index.mjs`), so importing
 * it in a test, a script or a Vercel Function does not spin up a listener.
 *
 * Compares resolved real paths instead of matching a suffix: hosts such as
 * Railway/Render run `node index.mjs` with the app directory as cwd (and as the
 * repo root when it is not a monorepo), so `argv[1]` has no `api-server/` prefix
 * and a suffix check would silently skip startup.
 */
function resolveEntryPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

const normalizePath = (value) =>
  process.platform === 'win32' ? value.toLowerCase() : value;

const invokedFile = process.argv[1] ? normalizePath(resolveEntryPath(process.argv[1])) : '';
const thisFile = normalizePath(resolveEntryPath(fileURLToPath(import.meta.url)));
const isEntryPoint = invokedFile !== '' && invokedFile === thisFile;

/**
 * One instance shared by both hosting styles: the long-lived listener for
 * Render/Railway, and the default export that Vercel turns into a Function.
 */
const app = createApp();

if (isEntryPoint) {
  // Bind all interfaces: platform routers (Railway/Render) reach the container
  // from outside, so a loopback-only listener fails its health check.
  const host = process.env.HOST?.trim() || '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`[api] CUEC API listening on http://${host}:${port}`);
    console.log(`[api] allowed origins: ${allowedOrigins.join(', ')}`);
    // Hostnames only: makes a wrong connection string obvious in platform logs.
    console.log(`[api] MongoDB target: ${mongoHostLabel}`);
    // Compare this id with the Next app's value: a mismatch rejects every
    // admin token, which the browser sees as a console that logs you out.
    console.log(`[api] admin token secret id: ${adminTokenSecretFingerprint || '(unset)'}`);
    if (isPlaceholderAdminTokenSecret()) {
      console.warn(
        '[api] WARNING: ADMIN_TOKEN_SECRET is still an example placeholder. ' +
          'Admin requests will all fail with 401 until it is set to the same value as the Next app\'s ADMIN_TOKEN_SECRET.'
      );
    }
  });

  connectDatabase()
    .then(() => console.log('[api] MongoDB connected'))
    .catch((error) => {
      console.error('[api] MongoDB connection failed:', error.message);
      if (isProduction) process.exit(1);
    });

  const shutdown = (signal) => {
    console.log(`[api] ${signal} received, closing server`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('[api] Unhandled rejection:', reason);
  });
}

// Vercel's Express support detects this default export and serves every route
// through one Function; importing the module there never starts the listener.
export default app;
export { ApiError };
