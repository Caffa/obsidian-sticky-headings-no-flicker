import { Platform } from 'obsidian';
import type { MarkdownView } from 'obsidian';
import type { ISetting } from '../types';

/**
 * Pure core of the sticky-header top computation.
 *
 * Container-relative semantics: the returned `top` is the user nudge alone,
 * measured against the CSS containing block the header actually renders
 * against (`main.parentElement`, made `position: relative` inline). The rect
 * heights exist ONLY as a degeneracy guard: a zero height means a hidden or
 * detached leaf, and returning `null` tells callers to keep their last good
 * value instead of clobbering it.
 *
 * WHY container-relative and not anchor-vs-container delta: a
 * delta-dependent formula `max(0, nudge − delta)` saturates whenever a
 * note-toolbar or theme pushes the container down by ≥ nudge — every slider
 * value clamps to 0 and the setting appears dead. It also makes the visual
 * anchor depend on whichever element the delta happened to be measured
 * against at runtime, so the header jumps between anchors when deltas change
 * (tab switches, edit/preview toggles). Anchoring purely on the containing
 * block with a user offset is delta-independent: same slider value, same
 * position, everywhere.
 *
 * Never import `obsidian` here: this function is unit-tested with bun.
 */
export function computeTopFromRects(anchorHeight: number, containerHeight: number, userNudge: number): number | null {
  if (anchorHeight === 0 || containerHeight === 0) {
    return null;
  }
  return Math.max(0, Math.round(userNudge));
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

  // Degenerate rects (zero height — hidden or detached leaf) bail out so
  // hidden leaves stay silent and keep their last good value.
  if (anchorRect.height === 0 || containerRect.height === 0) {
    return null;
  }

  return computeTopFromRects(anchorRect.height, containerRect.height, userNudge);
}
