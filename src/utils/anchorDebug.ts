import type { MarkdownView } from 'obsidian';

export type AnchorTrigger =
  | 'mount'
  | 'settings'
  | 'nudge'
  | 'parent-change'
  | 'ro'
  | 'win-resize'
  | 'vv-resize'
  | 'settle-300'
  | 'settle-1000'
  | 'refreshAnchor'
  | 'main-bind';

const isAnchorDebugEnabled = () => document.body.dataset.stickyHeadingsDebug === '1';

const classSnippet = (el: Element | null | undefined, maxLength = 80): string => {
  const value = el?.className ?? '';
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
};

/**
 * Debug logging for sticky-header anchor computation, gated on
 * `document.body.dataset.stickyHeadingsDebug === '1'`.
 *
 * Surfaces the two things that matter when the header pins to the wrong spot:
 * what was measured (anchor + parent rects) versus what CSS actually resolves
 * against (`offsetParent`). Enable with:
 * `document.body.dataset.stickyHeadingsDebug = '1'` in the console.
 */
export function logAnchor(
  trigger: AnchorTrigger,
  main: HTMLElement | undefined,
  view: MarkdownView | undefined,
  prevTop: number | null,
  nextTop: number | null
): void {
  if (!isAnchorDebugEnabled()) return;
  // Skip no-op recomputes; refreshAnchor is worth seeing even when unchanged.
  if (nextTop === prevTop && trigger !== 'refreshAnchor') return;
  try {
    const contentEl = view?.contentEl;
    const anchorRect = contentEl ? contentEl.getBoundingClientRect() : null;
    const parent = main?.parentElement;
    const parentRect = parent ? parent.getBoundingClientRect() : null;
    const offsetParent = main?.offsetParent;
    console.debug('[sticky-headings] anchor', {
      trigger,
      prevTop,
      nextTop,
      anchor: anchorRect ? { top: Math.round(anchorRect.top), height: Math.round(anchorRect.height) } : null,
      parent: parent
        ? {
            class: classSnippet(parent),
            top: parentRect ? Math.round(parentRect.top) : null,
            height: parentRect ? Math.round(parentRect.height) : null,
            inlinePosition: parent.style.position || '(none)',
          }
        : null,
      offsetParentClass: classSnippet(offsetParent),
      agrees: offsetParent === parent,
    });
  } catch (error) {
    console.debug('[sticky-headings] anchor log failed:', error);
  }
}
