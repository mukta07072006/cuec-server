import { allowedOrigins, isProduction } from './config.mjs';
import { checkRateLimit, isClientApiKeyValid, isServiceKeyValid, verifyAdminToken } from './security.mjs';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wraps async handlers so rejected promises reach the error middleware. */
export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function requestLogger(req, res, next) {
  const startedAt = performance.now();
  res.on('finish', () => {
    const duration = Math.round(performance.now() - startedAt);
    // Never log headers, bodies, keys or PII — just method, path, status.
    console.log(
      `[api] ${req.method} ${req.route?.path ? req.baseUrl + req.route.path : req.path} ${res.statusCode} ${duration}ms`
    );
  });
  next();
}

/** Minimal hardened headers (no extra dependency needed). */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.removeHeader('X-Powered-By');
  next();
}

export function corsOptions(requestOrigin, callback) {
  const origin = typeof requestOrigin === 'string' ? requestOrigin : '';
  const normalized = origin.replace(/\/$/, '');
  if (!origin) {
    // Same-origin / curl / server-to-server requests have no Origin header.
    callback(null, { origin: false });
    return;
  }
  if (allowedOrigins.includes(normalized)) {
    callback(null, { origin: normalized, credentials: false });
    return;
  }
  callback(new ApiError(403, 'Origin not allowed.'));
}

/**
 * Every browser mutation must come from an allow-listed origin. Service keys
 * (server-to-server) are exempt because they have no browser origin.
 */
export function requireTrustedOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const serviceKey = req.get('x-service-key') || '';
  if (isServiceKeyValid(serviceKey)) return next();

  const originHeader = (req.get('origin') || '').replace(/\/$/, '');
  const refererHeader = req.get('referer') || '';
  const candidateOrigin =
    originHeader ||
    (refererHeader ? (() => {
      try {
        return new URL(refererHeader).origin;
      } catch {
        return '';
      }
    })() : '');

  if (!candidateOrigin || !allowedOrigins.includes(candidateOrigin)) {
    return next(new ApiError(403, 'Blocked: request origin is not allowed.'));
  }
  return next();
}

/** Public client key gate for every API route. */
export function requireApiKey(req, res, next) {
  const provided = req.get('x-api-key') || '';
  if (isClientApiKeyValid(provided)) return next();
  if (isServiceKeyValid(req.get('x-service-key') || '')) return next();
  return next(new ApiError(401, 'Missing or invalid API key.'));
}

/**
 * Admin gate. Accepts either:
 *  - `x-admin-token`: short-lived HMAC token minted by the Next app for a
 *    signed-in admin/superadmin (the normal browser path), or
 *  - `x-service-key`: server-to-server automation.
 */
export function requireAdmin(req, res, next) {
  const serviceKey = req.get('x-service-key') || '';
  if (isServiceKeyValid(serviceKey)) {
    req.admin = { subject: 'service', via: 'service-key' };
    return next();
  }

  const token = req.get('x-admin-token') || '';
  const verified = verifyAdminToken(token);
  if (!verified) {
    return next(new ApiError(401, 'Admin authorization required. Please sign in again.'));
  }
  req.admin = { subject: verified.subject, via: 'admin-token' };
  return next();
}

/** Per-route sliding window limiter; returns 429 with Retry-After. */
export function rateLimit(bucket, maxRequests, windowMs) {
  return (req, res, next) => {
    const result = checkRateLimit(req, bucket, maxRequests, windowMs);
    if (result.allowed) return next();
    res.setHeader('Retry-After', String(result.retryAfterSec));
    return next(
      new ApiError(
        429,
        `Too many requests. Please wait ${result.retryAfterSec}s and try again.`
      )
    );
  };
}

export function notFoundHandler(req, res, next) {
  next(new ApiError(404, 'Endpoint not found.'));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = Number(err?.status) || 500;

  if (status >= 500) {
    console.error('[api] Unhandled error:', err?.message || err);
  }

  // Never leak stack traces or MongoDB internals to clients.
  const message =
    status >= 500 && isProduction
      ? 'Something went wrong. Please try again.'
      : err?.message || 'Unexpected error.';

  if (res.headersSent) return;

  res.status(status).json({
    error: message,
    ...(err?.details ? { details: err.details } : {}),
  });
}
