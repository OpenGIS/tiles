import { describe, expect, it } from 'vitest';

import { sha256Text } from '../../../src/build/fs.mjs';

describe('sha256Text', () => {
  it('returns a hexadecimal digest synchronously', () => {
    const digest = sha256Text('abc');

    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(digest).toHaveLength(64);
  });
});
