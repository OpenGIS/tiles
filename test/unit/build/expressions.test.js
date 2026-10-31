import { describe, expect, it } from 'vitest';

import {
  hashExpressions,
  normaliseExpressions,
  renderExpressionsFile,
  sourceExpressionUnion,
  unionExpressions,
} from '../../../src/build/expressions.mjs';
import { BuildError } from '../../../src/build/errors.mjs';

describe('normaliseExpressions', () => {
  it('trims, deduplicates and preserves order', () => {
    expect(normaliseExpressions([' nwr/a=b ', 'nwr/c=d', 'nwr/a=b'])).toEqual([
      'nwr/a=b',
      'nwr/c=d',
    ]);
  });

  it.each([
    ['a non-array', 'nwr/a=b'],
    ['an empty array', []],
    ['an empty expression', [' ']],
    ['a non-string expression', [1]],
  ])('rejects %s', (_label, value) => {
    expect(() => normaliseExpressions(value)).toThrow(BuildError);
  });
});

describe('unionExpressions', () => {
  it('merges groups without duplicates', () => {
    expect(
      unionExpressions([
        ['nwr/amenity=shelter', 'nwr/tourism=viewpoint'],
        ['nwr/tourism=viewpoint', 'nwr/amenity=toilets'],
      ]),
    ).toEqual(['nwr/amenity=shelter', 'nwr/tourism=viewpoint', 'nwr/amenity=toilets']);
  });

  it('rejects an empty group', () => {
    expect(() => unionExpressions([[]])).toThrow(BuildError);
  });
});

describe('sourceExpressionUnion', () => {
  it('merges POI, route and path expressions without duplicates', () => {
    const sources = {
      pois: { expressions: ['nwr/tourism=viewpoint', 'nwr/amenity=shelter'] },
      routes: { expressions: ['r/route=*hiking*', 'r/route=*bicycle*'] },
      paths: {
        expressions: ['r/route=*hiking*', 'w/highway=path', 'w/highway=footway'],
      },
    };

    expect(sourceExpressionUnion(sources)).toEqual([
      'nwr/tourism=viewpoint',
      'nwr/amenity=shelter',
      'r/route=*hiking*',
      'r/route=*bicycle*',
      'w/highway=path',
      'w/highway=footway',
    ]);
  });

  it('preserves source order while removing repeated expressions', () => {
    const sources = {
      routes: { expressions: ['r/route=*hiking*', 'r/route=*foot*'] },
      paths: { expressions: ['r/route=*foot*', 'w/highway=track'] },
    };

    expect(sourceExpressionUnion(sources)).toEqual([
      'r/route=*hiking*',
      'r/route=*foot*',
      'w/highway=track',
    ]);
  });
});

describe('expression files', () => {
  it('renders one expression per line with a trailing newline', () => {
    expect(renderExpressionsFile(['nwr/a=b', 'nwr/c=d'])).toBe('nwr/a=b\nnwr/c=d\n');
  });

  it('hashes the rendered union stably', () => {
    const first = hashExpressions(['nwr/a=b', 'nwr/c=d']);
    const second = hashExpressions([' nwr/a=b ', 'nwr/c=d', 'nwr/a=b']);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the hash when the union changes', () => {
    expect(hashExpressions(['nwr/a=b'])).not.toBe(hashExpressions(['nwr/a=c']));
  });
});
