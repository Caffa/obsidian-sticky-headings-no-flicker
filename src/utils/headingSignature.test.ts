import { describe, expect, it } from 'bun:test';
import type { HeadingCache } from 'obsidian';
import { computeOffsetSignature } from './headingSignature';

const makeHeading = (line: number, offset: number): HeadingCache => ({
  heading: 'Test',
  level: 1,
  position: {
    start: { line, col: 0, offset },
    end: { line, col: 4, offset: offset + 4 },
  },
});

describe('computeOffsetSignature', () => {
  it('returns empty string for null, undefined, or empty arrays', () => {
    expect(computeOffsetSignature(null)).toBe('');
    expect(computeOffsetSignature(undefined)).toBe('');
    expect(computeOffsetSignature([])).toBe('');
  });

  it('serialises a single heading as "line:offset"', () => {
    expect(computeOffsetSignature([makeHeading(0, 12)])).toBe('0:12');
  });

  it('joins multiple headings with newlines', () => {
    const headings = [makeHeading(0, 12), makeHeading(5, 80)];
    expect(computeOffsetSignature(headings)).toBe('0:12\n5:80');
  });

  it('changes when offsets shift', () => {
    const before = [makeHeading(0, 12), makeHeading(5, 80)];
    const after = [makeHeading(0, 25), makeHeading(5, 93)];
    expect(computeOffsetSignature(before)).not.toBe(computeOffsetSignature(after));
  });

  it('is stable for identical inputs', () => {
    const headings = [makeHeading(2, 40), makeHeading(8, 120)];
    expect(computeOffsetSignature(headings)).toBe(computeOffsetSignature(headings));
  });

  it('falls back to -1:-1 and stays length-sensitive when position is missing', () => {
    const withoutPosition = { heading: 'No position', level: 2 } as unknown as HeadingCache;
    expect(computeOffsetSignature([withoutPosition])).toBe('-1:-1');
    expect(computeOffsetSignature([withoutPosition, withoutPosition])).toBe('-1:-1\n-1:-1');
  });
});
