import type * as NodeFs from 'fs';
import type { MarkdownView } from 'obsidian';

/** Node's fs module shape, imported type-only so nothing is required at load. */
type FsModule = typeof NodeFs;

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

const TRACE_FILENAME = 'debug-trace.jsonl';

// Directory of the file sink (the plugin folder); null disables the file trace.
let anchorDebugSinkDir: string | null = null;

// Resolved Node fs, cached after first successful require.
let fsModule: FsModule | null = null;

/**
 * Lazily resolve Node's fs. Obsidian mobile has no Node runtime — a static
 * `import from 'fs'` compiles to a top-level `require('fs')` in the CJS bundle,
 * which crashes plugin load there. This resolves only where a working `require`
 * exists (desktop) and never throws.
 */
const getFs = (): FsModule | null => {
  if (fsModule !== null) return fsModule;
  try {
    if (typeof require === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy require; a static fs import compiles to a top-level require that crashes mobile
      fsModule = require('fs') as FsModule;
    }
  } catch {
    // No Node fs reachable (mobile or sandboxed) — file tracing stays off.
    fsModule = null;
  }
  return fsModule;
};

/**
 * `existsSync` passthrough that returns false instead of throwing when Node's
 * fs isn't reachable (mobile). Used for the `debug.txt` marker check.
 */
export const nodeFileExists = (path: string): boolean => {
  const fs = getFs();
  if (fs === null) return false;
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
};

const traceFilePath = (pluginDir: string): string => `${pluginDir}/${TRACE_FILENAME}`;

const appendTrace = (payload: Record<string, unknown>): void => {
  const fs = getFs();
  if (anchorDebugSinkDir == null || fs === null) return;
  try {
    fs.appendFileSync(traceFilePath(anchorDebugSinkDir), `${JSON.stringify(payload)}\n`);
  } catch {
    // Silent — the file trace must never interfere with the plugin.
  }
};

/**
 * Enable (pluginDir) or disable (null) the file sink for anchor debug traces.
 * Truncates `${pluginDir}/debug-trace.jsonl` so each session starts clean, then
 * records a `trace-open` line. Never throws.
 */
export function configureAnchorDebugSink(pluginDir: string | null): void {
  anchorDebugSinkDir = pluginDir;
  const fs = getFs();
  if (pluginDir == null || fs === null) return;
  try {
    fs.writeFileSync(traceFilePath(pluginDir), '');
    appendTrace({ timestamp: new Date().toISOString(), event: 'trace-open', pluginDir });
  } catch {
    // Truncate failed — drop the sink instead of spamming failing appends.
    anchorDebugSinkDir = null;
  }
}

/**
 * Debug logging for sticky-header anchor computation, gated on
 * `document.body.dataset.stickyHeadingsDebug === '1'`.
 *
 * Surfaces the two things that matter when the header pins to the wrong spot:
 * what was measured (anchor + parent rects) versus what CSS actually resolves
 * against (`offsetParent`). Enable with:
 * `document.body.dataset.stickyHeadingsDebug = '1'` in the console, or drop a
 * `debug.txt` file into the plugin folder — that also mirrors every entry to
 * `debug-trace.jsonl` next to it (desktop only, see `configureAnchorDebugSink`).
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
    appendTrace({
      timestamp: new Date().toISOString(),
      event: 'anchor',
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
