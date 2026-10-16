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
  it('healthy rects resolve to the user nudge, independent of geometry', () => {
    expect(computeTopFromRects(50, 200, 10)).toBe(10);
    expect(computeTopFromRects(500, 400, 31)).toBe(31);
  });

  it('zero anchor height is a skip signal (null)', () => {
    expect(computeTopFromRects(0, 200, 5)).toBeNull();
  });

  it('zero container height is a skip signal (null)', () => {
    expect(computeTopFromRects(50, 0, 5)).toBeNull();
  });

  it('fractional nudges round to the nearest integer', () => {
    expect(computeTopFromRects(50, 200, 30.4)).toBe(30);
    expect(computeTopFromRects(50, 200, 30.6)).toBe(31);
  });

  it('nudge 0 resolves to 0', () => {
    expect(computeTopFromRects(50, 200, 0)).toBe(0);
  });

  it('negative nudges clamp to 0', () => {
    expect(computeTopFromRects(50, 200, -10)).toBe(0);
  });
});

describe('computeEffectiveTop', () => {
  it('returns null (skip) when main has no parentElement', () => {
    const view = {} as MarkdownView;
    expect(computeEffectiveTop(undefined, view, makeSettings())).toBeNull();
    expect(computeEffectiveTop({} as HTMLElement, view, makeSettings())).toBeNull();
  });

  it('healthy rects return the nudge even when the container sits far below the anchor', () => {
    // Note-toolbar/theme push the container 40px below the content top; the
    // slider must still win because the formula is container-relative.
    const contentEl = {
      getBoundingClientRect: () => ({ top: 300, height: 500 }),
    };
    const parent = {
      getBoundingClientRect: () => ({ top: 340, height: 460 }),
    };
    const view = { contentEl } as unknown as MarkdownView;
    const main = { parentElement: parent } as unknown as HTMLElement;
    expect(computeEffectiveTop(main, view, makeSettings({ desktopTopOffset: 31 }))).toBe(31);
  });

  it('degenerate anchor rect is a skip signal (null)', () => {
    const contentEl = {
      getBoundingClientRect: () => ({ top: 0, height: 0 }),
    };
    const parent = {
      getBoundingClientRect: () => ({ top: 0, height: 460 }),
    };
    const view = { contentEl } as unknown as MarkdownView;
    const main = { parentElement: parent } as unknown as HTMLElement;
    expect(computeEffectiveTop(main, view, makeSettings({ desktopTopOffset: 31 }))).toBeNull();
  });
});
