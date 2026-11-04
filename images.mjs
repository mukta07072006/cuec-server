/**
 * Image sniffing/validation. The declared MIME type is never trusted: magic
 * bytes decide whether a file really is a JPEG, PNG or WebP, and the dimensions
 * are read from the headers so tiny placeholder crops get rejected.
 */

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MIN_MEMBER_PHOTO_DIMENSION = 200;

const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/;

/** Parses `data:image/png;base64,...` into bytes + declared mime. */
export function parseDataUrl(raw) {
  if (typeof raw !== 'string') return null;
  const match = DATA_URL_PATTERN.exec(raw.trim());
  if (!match) return null;
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  return { mime: match[1], buffer };
}

export function isRealImage(bytes, mime) {
  if (!bytes || bytes.length < 12) return false;
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mime === 'image/webp') {
    return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

/** Reads width/height from PNG, WEBP (VP8/VP8L/VP8X) or JPEG headers. */
export function readImageDimensions(bytes, mime) {
  try {
    if (mime === 'image/png') {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mime === 'image/webp') {
      const chunk = bytes.toString('ascii', 12, 16);
      if (chunk === 'VP8 ') {
        return {
          width: bytes.readUInt16LE(26) & 0x3fff,
          height: bytes.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') {
        return {
          width: 1 + bytes.readUIntLE(24, 3),
          height: 1 + bytes.readUIntLE(27, 3),
        };
      }
      return null;
    }
    if (mime === 'image/jpeg') {
      let offset = 2;
      while (offset < bytes.length - 9) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            height: bytes.readUInt16BE(offset + 5),
            width: bytes.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + length;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}
