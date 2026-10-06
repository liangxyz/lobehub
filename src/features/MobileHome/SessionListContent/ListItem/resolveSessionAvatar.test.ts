import { DEFAULT_AVATAR } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import { resolveSessionAvatar } from './index';

describe('resolveSessionAvatar', () => {
  it('returns valid string avatar', () => {
    expect(resolveSessionAvatar('https://example.com/avatar.png')).toBe('https://example.com/avatar.png');
    expect(resolveSessionAvatar('🤖')).toBe('🤖');
  });

  it('falls back to DEFAULT_AVATAR when avatar is undefined or null', () => {
    expect(resolveSessionAvatar(undefined)).toBe(DEFAULT_AVATAR);
    expect(resolveSessionAvatar(null)).toBe(DEFAULT_AVATAR);
    expect(resolveSessionAvatar('')).toBe(DEFAULT_AVATAR);
  });

  it('handles array format safely', () => {
    expect(resolveSessionAvatar([{ avatar: 'https://example.com/custom.png' }])).toBe('https://example.com/custom.png');
    expect(resolveSessionAvatar([])).toBe(DEFAULT_AVATAR);
    expect(resolveSessionAvatar([{ avatar: '' }])).toBe(DEFAULT_AVATAR);
  });
});
