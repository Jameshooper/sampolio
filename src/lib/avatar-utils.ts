/**
 * Pure + browser-only helpers for user avatars.
 *
 * `getInitials` / `getAvatarColor` are pure (unit-tested, safe on the server).
 * `fileToNormalizedImageSrc` / `cropToAvatarDataUri` touch the DOM/canvas and
 * are only ever called from the client-side avatar editor — they reference
 * `document`, `Image`, and `createImageBitmap` inside their bodies, so importing
 * this module on the server (or in a node test env) is still safe.
 */

/** Max length of the produced data URI, mirroring avatarDataUriSchema's cap. */
const MAX_DATA_URI_LEN = 300_000;

/**
 * Initials for the fallback avatar: first letter of the first + last
 * whitespace-separated words, uppercased. A single word yields its first
 * letter; an empty/blank name yields '?'.
 */
export function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].charAt(0).toUpperCase();
  const first = words[0].charAt(0);
  const last = words[words.length - 1].charAt(0);
  return (first + last).toUpperCase();
}

/**
 * Deterministic background color for the initials fallback. Hue is hashed from
 * the userId (same string hash as getCategoryColor's fallback in constants.ts);
 * fixed 65% saturation / 42% lightness keeps white text at ≥4.5:1 contrast in
 * both light and dark themes across the whole hue wheel.
 */
export function getAvatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 42%)`;
}

/** Load an image element from any src (object URL / data URI / same-origin). */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load that image. Please try a different one.'));
    img.src = src;
  });
}

/**
 * Browser-only. Normalize a picked File into an image src ready for the cropper:
 * decodes it with EXIF orientation baked in (`createImageBitmap` with
 * `imageOrientation: 'from-image'`, so phone photos aren't sideways), downscales
 * so the longest side is ≤ 2048px (keeps cropper memory sane for huge photos),
 * and re-encodes as a JPEG data URI. Falls back to a plain object URL on
 * browsers that lack the orientation option or fail to decode. Rejects
 * non-image files with a friendly message.
 */
export async function fileToNormalizedImageSrc(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file.');
  }
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = longest > 2048 ? 2048 / longest : 1;
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(bitmap, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.92);
    } finally {
      bitmap.close();
    }
  } catch {
    // Older browsers lack createImageBitmap orientation support, or the canvas
    // export failed — fall back to a plain object URL (no orientation fix).
    return URL.createObjectURL(file);
  }
}

/**
 * Browser-only. Draw react-easy-crop's pixel area onto a size×size canvas and
 * return a WebP data URI (quality 0.85), falling back to JPEG when the browser
 * can't encode WebP. Throws a friendly Error if the result exceeds the schema's
 * length cap.
 */
export async function cropToAvatarDataUri(
  imageSrc: string,
  cropAreaPixels: { x: number; y: number; width: number; height: number },
  size = 256
): Promise<string> {
  const image = await loadImage(imageSrc);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process that image. Please try a different one.');
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(
    image,
    cropAreaPixels.x,
    cropAreaPixels.y,
    cropAreaPixels.width,
    cropAreaPixels.height,
    0,
    0,
    size,
    size
  );

  let dataUri = canvas.toDataURL('image/webp', 0.85);
  if (!dataUri.startsWith('data:image/webp')) {
    // Browser couldn't encode WebP (Safari < 14) — JPEG is universally supported.
    dataUri = canvas.toDataURL('image/jpeg', 0.85);
  }

  if (dataUri.length > MAX_DATA_URI_LEN) {
    throw new Error('That image is too large to save. Please try a smaller one.');
  }

  return dataUri;
}
