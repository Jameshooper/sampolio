'use client';

import { useState } from 'react';
import { getInitials, getAvatarColor } from '@/lib/avatar-utils';

interface UserAvatarProps {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  /** Rendered pixel size (square). Defaults to 32. */
  size?: number;
  className?: string;
}

/**
 * Small circular user avatar. Renders the uploaded image when `avatarUrl` is
 * present (served by /api/avatars/[userId] with HTTP caching), falling back to
 * the user's initials on a deterministic hashed color — also used if the image
 * fails to load (deleted/broken file).
 *
 * The image is decorative next to accompanying text (`alt=""`, `aria-hidden` on
 * the fallback); the name is exposed via `title` for the standalone case.
 */
export function UserAvatar({ userId, name, avatarUrl, size = 32, className = '' }: UserAvatarProps) {
  const [errored, setErrored] = useState(false);

  // Reset the error flag when the URL changes (e.g. a new avatar was uploaded)
  // by adjusting state during render — the React-sanctioned alternative to a
  // setState-in-effect, which avoids a cascading extra render.
  const [prevUrl, setPrevUrl] = useState(avatarUrl);
  if (avatarUrl !== prevUrl) {
    setPrevUrl(avatarUrl);
    setErrored(false);
  }

  const dimension = { width: size, height: size };

  if (avatarUrl && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        title={name}
        onError={() => setErrored(true)}
        className={`rounded-full object-cover shrink-0 bg-black/5 dark:bg-white/10 ${className}`}
        style={dimension}
      />
    );
  }

  return (
    <div
      className={`rounded-full shrink-0 flex items-center justify-center font-semibold text-white select-none ${className}`}
      style={{
        ...dimension,
        background: getAvatarColor(userId),
        fontSize: Math.round(size * 0.42),
      }}
      title={name}
      aria-hidden
    >
      {getInitials(name)}
    </div>
  );
}
