import { describe, expect, it, mock } from 'bun:test';
import type { MarkdownView } from 'obsidian';
import type { ISetting } from '../types';

// The `obsidian` package is typings-only (the real runtime is injected by the
// app), so stub the pieces `viewportAnchor.ts` imports before loading it.
mock.module('obsidian', () => ({
  Platform: { isMobile: false },
}));

// Dynamic import so the mock above is registered before module evaluation.
const { computeTopFromRects, computeEffectiveTop } = await import('./viewportAnchor');

const makeSettings = (overrides: Partial<ISetting> = {}): ISetting => ({
  max: 5,
  mode: 'default',
  theme: 'default',
  scrollBehaviour: 'instant',
  showIcon: true,
  autoShowFileName: true,
  showInStatusBar: true,
  boundaryOffset: '0px',
  fontSize: 12,
  desktopTopOffset: 0,
  mobileTopOffset: 0,
  desktopLeftOffset: 0,
  mobileLeftOffset: 0,
  ...overrides,
});

describe('computeTopFromRects', () => {
  it('aligned tops resolve to the user nudge', () => {
    expect(computeTopFromRects(100, 50, 100, 200, 10)).toBe(10);
  });

  it('container below the anchor by less than the nudge stays positive', () => {
    // raw = 0 - 30 + 40 = 10
    expect(computeTopFromRects(0, 100, 30, 200, 40)).toBe(10);
  });

  it('container below the anchor by more than the nudge clamps to 0', () => {
    // raw = 0 - 60 + 40 = -20
    expect(computeTopFromRects(0, 100, 60, 200, 40)).toBe(0);
  });

  it('zero anchor height is a skip signal (null)', () => {
    expect(computeTopFromRects(100, 0, 0, 200, 5)).toBeNull();
  });

  it('zero container height is a skip signal (null)', () => {
    expect(computeTopFromRects(100, 50, 0, 0, 5)).toBeNull();
  });

  it('negative raw top clamps to 0', () => {
    expect(computeTopFromRects(0, 100, 100, 200, 10)).toBe(0);
  });

  it('fractional raw tops round to the nearest integer', () => {
    expect(computeTopFromRects(100.4, 10, 50, 100, 0)).toBe(50);
    expect(computeTopFromRects(100.6, 10, 50, 100, 0)).toBe(51);
  });
});

describe('computeEffectiveTop', () => {
  it('returns null (skip) when main has no parentElement', () => {
    const view = {} as MarkdownView;
    expect(computeEffectiveTop(undefined, view, makeSettings())).toBeNull();
    expect(computeEffectiveTop({} as HTMLElement, view, makeSettings())).toBeNull();
  });
});
