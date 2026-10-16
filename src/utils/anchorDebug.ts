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

// Build nonce: bump this string per trace-mechanism change so a deployed
// debug-trace.jsonl proves exactly which build wrote it.
const TRACE_BUILD = 'trace2-adapter';

// Serial line sink installed by `configureAnchorDebugSink`; null = file trace off.
let anchorDebugSink: ((line: string) => void) | null = null;

/**
 * Install the file sink for anchor debug traces (wired to the vault
 * DataAdapter in onload) and immediately emit a `trace-open` line carrying the
 * build nonce, plugin version and dir. Also logs the enablement to the console
 * once — mirroring the previous onload console.info. Never throws.
 */
export function configureAnchorDebugSink(
  sink: (line: string) => void,
  manifest?: { dir?: string; version?: string }
): void {
  anchorDebugSink = sink;
  console.info('[sticky-headings] debug.txt present — file trace enabled');
  try {
    anchorDebugSink(
      JSON.stringify({
        ts: new Date().toISOString(),
        type: 'trace-open',
        build: TRACE_BUILD,
        version: manifest?.version,
        dir: manifest?.dir,
      })
    );
  } catch {
    // Sink failures must never interfere with the plugin.
  }
}

/**
 * Mirror one trace payload through the sink as a JSONL line (the sink itself
 * appends the newline). No-op before `configureAnchorDebugSink`. Silent on
 * failure — the file trace must never interfere with the plugin.
 */
const mirrorTrace = (payload: Record<string, unknown>): void => {
  try {
    anchorDebugSink?.(JSON.stringify(payload));
  } catch {
    // Silent — the file trace must never interfere with the plugin.
  }
};

/**
 * Debug logging for sticky-header anchor computation, gated on
 * `document.body.dataset.stickyHeadingsDebug === '1'`.
 *
 * Surfaces the two things that matter when the header pins to the wrong spot:
 * what was measured (anchor + parent rects) versus what CSS actually resolves
 * against (`offsetParent`). Enable with:
 * `document.body.dataset.stickyHeadingsDebug = '1'` in the console, or drop a
 * `debug.txt` file into the plugin folder — that also mirrors every entry to
 * `debug-trace.jsonl` next to it — see `configureAnchorDebugSink`, which
 * wires the file sink through the vault DataAdapter (works on desktop and
 * mobile, no node fs involved).
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
    const anchor = anchorRect ? { top: Math.round(anchorRect.top), height: Math.round(anchorRect.height) } : null;
    const parentSummary = parent
      ? {
          class: classSnippet(parent),
          top: parentRect ? Math.round(parentRect.top) : null,
          height: parentRect ? Math.round(parentRect.height) : null,
          inlinePosition: parent.style.position || '(none)',
        }
      : null;
    const offsetParentClass = classSnippet(offsetParent);
    console.debug('[sticky-headings] anchor', {
      trigger,
      prevTop,
      nextTop,
      anchor,
      parent: parentSummary,
      offsetParentClass,
      agrees: offsetParent === parent,
    });
    mirrorTrace({
      ts: new Date().toISOString(),
      type: 'anchor',
      trigger,
      prevTop,
      nextTop,
      anchor,
      parent: parentSummary,
      offsetParentClass,
      agrees: offsetParent === parent,
    });
  } catch (error) {
    console.debug('[sticky-headings] anchor log failed:', error);
  }
}
