import { describe, expect, it } from 'vitest';

import { parseRange } from '../../dev/vite-plugin-pmtiles.mjs';

describe('parseRange', () => {
  it('returns null when there is no Range header', () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('', 1000)).toBeNull();
  });

  it('parses a normal range', () => {
    expect(parseRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
  });

  it('parses an open-ended range', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range', () => {
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRange('bytes=-2000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('rejects a multi-range request', () => {
    expect(parseRange('bytes=0-1,4-5', 1000)).toEqual({ invalid: true });
  });

  it('rejects a start beyond the file size', () => {
    expect(parseRange('bytes=1000-', 1000)).toEqual({ invalid: true });
    expect(parseRange('bytes=2000-3000', 1000)).toEqual({ invalid: true });
  });

  it('rejects a start greater than the end', () => {
    expect(parseRange('bytes=500-100', 1000)).toEqual({ invalid: true });
  });

  it('clamps an end beyond the file size', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('rejects every range for a zero-size file', () => {
    expect(parseRange(undefined, 0)).toBeNull();
    expect(parseRange('bytes=0-', 0)).toEqual({ invalid: true });
    expect(parseRange('bytes=-1', 0)).toEqual({ invalid: true });
  });
});
