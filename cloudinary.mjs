import crypto from 'node:crypto';
import {
  cloudinaryApiKey,
  cloudinaryApiSecret,
  cloudinaryCloudName,
  cloudinaryUploadPreset,
} from './config.mjs';

export function isCloudinaryConfigured() {
  return Boolean(
    cloudinaryCloudName && ((cloudinaryApiKey && cloudinaryApiSecret) || cloudinaryUploadPreset)
  );
}

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Uploads an in-memory image to Cloudinary. The API server keeps the API secret
 * server-side, so the browser never signs or talks to Cloudinary itself.
 */
export async function uploadImage({ buffer, mime, folder, square = false }) {
  if (!isCloudinaryConfigured()) {
    const error = new Error(
      'Image storage is not configured. Set CLOUDINARY_CLOUD_NAME with API credentials or an upload preset.'
    );
    error.status = 503;
    throw error;
  }

  const form = new FormData();
  form.append(
    'file',
    new Blob([buffer], { type: mime }),
    `upload.${EXTENSIONS[mime] || 'jpg'}`
  );
  form.append('folder', folder);

  if (cloudinaryApiKey && cloudinaryApiSecret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
      .createHash('sha1')
      .update(`folder=${folder}&timestamp=${timestamp}${cloudinaryApiSecret}`)
      .digest('hex');
    form.append('api_key', cloudinaryApiKey);
    form.append('timestamp', timestamp);
    form.append('signature', signature);
  } else {
    form.append('upload_preset', cloudinaryUploadPreset);
  }

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudinaryCloudName)}/image/upload`,
    { method: 'POST', body: form }
  );
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.secure_url) {
    console.error('[api] Cloudinary rejected an upload:', data?.error?.message || response.status);
    const error = new Error(
      typeof data?.error?.message === 'string'
        ? data.error.message
        : 'The image was rejected by the storage provider.'
    );
    error.status = 502;
    throw error;
  }

  const url = String(data.secure_url);
  return square
    ? url.replace('/image/upload/', '/image/upload/c_fill,g_face,w_600,h_600,f_webp,q_auto/')
    : url;
}
