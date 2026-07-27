import { describe, it, expect } from 'vitest';
import { getInitials, getAvatarColor } from './avatar-utils';

// Canvas paths (fileToNormalizedImageSrc / cropToAvatarDataUri) are browser-only
// and deliberately not unit-tested here (node env has no canvas).

describe('getInitials', () => {
  it('uses the first letter of two words', () => {
    expect(getInitials('Alex Rivera')).toBe('AR');
  });

  it('uses the single letter of a one-word name', () => {
    expect(getInitials('Cher')).toBe('C');
  });

  it('uses first + last for three or more words', () => {
    expect(getInitials('Ada Lovelace Byron')).toBe('AB');
  });

  it('returns ? for an empty or blank name', () => {
    expect(getInitials('')).toBe('?');
    expect(getInitials('   ')).toBe('?');
  });

  it('collapses extra whitespace', () => {
    expect(getInitials('  Jean   Luc   Picard  ')).toBe('JP');
  });

  it('uppercases lowercase names', () => {
    expect(getInitials('john doe')).toBe('JD');
  });
});

describe('getAvatarColor', () => {
  it('is deterministic for the same id', () => {
    expect(getAvatarColor('alice')).toBe(getAvatarColor('alice'));
  });

  it('produces a well-formed hsl string in the fixed band', () => {
    expect(getAvatarColor('alice')).toMatch(/^hsl\(\d+, 65%, 42%\)$/);
    expect(getAvatarColor('550e8400-e29b-41d4-a716-446655440000')).toMatch(/^hsl\(\d+, 65%, 42%\)$/);
    expect(getAvatarColor('')).toMatch(/^hsl\(\d+, 65%, 42%\)$/);
  });

  it('differs for different ids', () => {
    expect(getAvatarColor('alice')).not.toBe(getAvatarColor('bob'));
    expect(
      getAvatarColor('550e8400-e29b-41d4-a716-446655440000')
    ).not.toBe(getAvatarColor('6ba7b810-9dad-11d1-80b4-00c04fd430c8'));
  });
});
