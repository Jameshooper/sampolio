import { z } from 'zod';

/**
 * Avatar upload payload: a small processed image as a base64 data-URI, produced
 * client-side by the avatar editor (crop → 256×256 WebP, JPEG/PNG fallbacks).
 * The server decodes it and stores the plain binary at data/users/{id}/avatar.webp
 * (see setUserAvatar in src/lib/db/users.ts). Cap keeps the payload sane
 * (~220KB binary); the editor targets far smaller output.
 */
export const avatarDataUriSchema = z
  .string()
  .regex(/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/, 'Invalid image data')
  .max(300_000, 'Image is too large');

/** Decode an avatar data-URI (already schema-validated) into raw image bytes. */
export function avatarDataUriToBuffer(dataUri: string): Buffer {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  return Buffer.from(base64, 'base64');
}
