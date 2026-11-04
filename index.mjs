import express from 'express';
import cors from 'cors';
import { allowedOrigins, assertConfig, isProduction, port } from './config.mjs';
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

const isEntryPoint = process.argv[1]?.replace(/\\/g, '/').endsWith('api-server/index.mjs');

if (isEntryPoint) {
  const app = createApp();

  const server = app.listen(port, () => {
    console.log(`[api] CUEC API listening on http://localhost:${port}`);
    console.log(`[api] allowed origins: ${allowedOrigins.join(', ')}`);
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

export { ApiError };
