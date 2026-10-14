import { Platform } from 'obsidian';
import type { MarkdownView } from 'obsidian';
import type { ISetting } from '../types';

/**
 * Pure core of the sticky-header top computation.
 *
 * Returns `null` as a skip signal when either rect is degenerate (zero height —
 * hidden or detached leaf), so callers keep their last good value instead of
 * clobbering it with a fallback. Never import `obsidian` here: this function
 * is unit-tested with bun.
 */
export function computeTopFromRects(
  anchorTop: number,
  anchorHeight: number,
  containerTop: number,
  containerHeight: number,
  userNudge: number
): number | null {
  if (anchorHeight === 0 || containerHeight === 0) {
    return null;
  }
  return Math.max(0, Math.round(anchorTop - containerTop + userNudge));
}

export function computeEffectiveTop(
  main: HTMLElement | undefined,
  view: MarkdownView,
  settings: ISetting
): number | null {
  const userNudge = Platform.isMobile ? settings.mobileTopOffset : settings.desktopTopOffset;

  if (!main?.parentElement) {
    return null;
  }

  const anchorRect = view.contentEl.getBoundingClientRect();
  const containerRect = main.parentElement.getBoundingClientRect();

  // Debug signal when the clamp engages (raw value was negative).
  const rawTop = anchorRect.top - containerRect.top + userNudge;
  if (rawTop < 0 && document.body.dataset.stickyHeadingsDebug === '1') {
    console.debug('[sticky-headings] effective top clamped to 0, raw was negative:', rawTop);
  }

  return computeTopFromRects(anchorRect.top, anchorRect.height, containerRect.top, containerRect.height, userNudge);
}
