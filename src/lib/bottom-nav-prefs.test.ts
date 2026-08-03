import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BOTTOM_NAV_IDS,
  DEFAULT_BOTTOM_NAV_IDS_SIMPLE,
  MAX_BOTTOM_NAV_TABS,
  resolveBottomNavIds,
  toggleBottomNavId,
} from './bottom-nav-prefs';

describe('resolveBottomNavIds', () => {
  it('falls back to the advanced defaults when nothing is stored', () => {
    expect(resolveBottomNavIds(null, 'advanced')).toEqual([...DEFAULT_BOTTOM_NAV_IDS]);
    expect(resolveBottomNavIds(undefined, 'advanced')).toEqual([...DEFAULT_BOTTOM_NAV_IDS]);
    expect(resolveBottomNavIds(undefined, undefined)).toEqual([...DEFAULT_BOTTOM_NAV_IDS]);
  });

  it('falls back to the simple-mode defaults in simple mode', () => {
    expect(resolveBottomNavIds(null, 'simple')).toEqual([...DEFAULT_BOTTOM_NAV_IDS_SIMPLE]);
  });

  it('returns a stored list verbatim, in order', () => {
    expect(resolveBottomNavIds(['goals', 'bank', 'home'], 'advanced')).toEqual(['goals', 'bank', 'home']);
  });

  it('lets an explicit choice win in simple mode (overrides the slimmed default)', () => {
    expect(resolveBottomNavIds(['mortgage', 'playground'], 'simple')).toEqual(['mortgage', 'playground']);
  });

  it('drops unknown ids', () => {
    expect(resolveBottomNavIds(['home', 'not-a-page', 'goals'], 'advanced')).toEqual(['home', 'goals']);
  });

  it('dedupes, keeping the first occurrence', () => {
    expect(resolveBottomNavIds(['home', 'split', 'home'], 'advanced')).toEqual(['home', 'split']);
  });

  it('slices to the max tab count', () => {
    const resolved = resolveBottomNavIds(
      ['home', 'split', 'overview', 'cashflow', 'goals', 'bank'],
      'advanced',
    );
    expect(resolved).toHaveLength(MAX_BOTTOM_NAV_TABS);
    expect(resolved).toEqual(['home', 'split', 'overview', 'cashflow']);
  });

  it('falls back to the defaults when every stored id is invalid', () => {
    expect(resolveBottomNavIds(['nope', ''], 'advanced')).toEqual([...DEFAULT_BOTTOM_NAV_IDS]);
    expect(resolveBottomNavIds([], 'simple')).toEqual([...DEFAULT_BOTTOM_NAV_IDS_SIMPLE]);
  });
});

describe('toggleBottomNavId', () => {
  it('appends a new id at the end', () => {
    expect(toggleBottomNavId(['home', 'split'], 'goals')).toEqual(['home', 'split', 'goals']);
  });

  it('removes a selected id', () => {
    expect(toggleBottomNavId(['home', 'split', 'goals'], 'split')).toEqual(['home', 'goals']);
  });

  it('returns null when adding past the max', () => {
    expect(toggleBottomNavId(['home', 'split', 'overview', 'cashflow'], 'goals')).toBeNull();
  });

  it('returns null when removing the last remaining tab', () => {
    expect(toggleBottomNavId(['home'], 'home')).toBeNull();
  });
});
