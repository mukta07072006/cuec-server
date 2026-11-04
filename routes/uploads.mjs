import express from 'express';
import { ApiError, asyncHandler, rateLimit, requireAdmin, requireApiKey, requireTrustedOrigin } from '../http.mjs';
import { isCloudinaryConfigured, uploadImage } from '../cloudinary.mjs';
import { parseDataUrl, isRealImage, MAX_IMAGE_BYTES } from '../images.mjs';

/**
 * Browser image uploads for tournament banners. The browser sends a data URL —
 * no multipart parser and no Cloudinary credentials in the client.
 *
 * Mounted before the global JSON parser because these bodies are large; the
 * route has its own sized parser.
 */
export const uploadsRouter = express.Router();

uploadsRouter.use(requireApiKey);
uploadsRouter.use(requireTrustedOrigin);
uploadsRouter.use(rateLimit('uploads', 30, 60_000));

const ALLOWED_FOLDERS = new Set(['cu-esports-club/tournaments', 'cu-esports-club/members']);
const MAX_BANNER_BYTES = 10 * 1024 * 1024;

uploadsRouter.post(
  '/image',
  express.json({ limit: '14mb' }),
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!isCloudinaryConfigured()) {
      throw new ApiError(
        503,
        'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME with API credentials or CLOUDINARY_UPLOAD_PRESET.'
      );
    }

    const parsed = parseDataUrl(req.body?.file);
    if (!parsed) throw new ApiError(400, 'Send the image as a data URL.');
    if (!isRealImage(parsed.buffer, parsed.mime)) {
      throw new ApiError(400, 'That file is not a valid image.');
    }
    if (parsed.buffer.length > MAX_BANNER_BYTES) {
      throw new ApiError(400, 'Images must be 10 MB or smaller.');
    }

    const requestedFolder = String(req.body?.folder || '').trim();
    const folder = ALLOWED_FOLDERS.has(requestedFolder)
      ? requestedFolder
      : 'cu-esports-club/tournaments';

    const url = await uploadImage({ buffer: parsed.buffer, mime: parsed.mime, folder });
    res.json({ url });
  })
);

export { MAX_IMAGE_BYTES };
