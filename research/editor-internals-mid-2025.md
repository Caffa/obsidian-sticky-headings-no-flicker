# Obsidian Editor Internals — Status as of Obsidian v1.6.x / mid-2025

Research target: how `MarkdownView`'s internal structure changed and the recommended
plugin patterns for getting scroll/content containers and heading positions.

Date: 2026-08-26
Sources cross-referenced: official `obsidian-api` repo (master), installed `obsidian` npm
typings (v1.6.6), `obsidian-typings` 2.2.0, `obsidian-sample-plugin`, Obsidian forum +
GitHub discussions, this repo's own code.

---

## TL;DR

- `MarkdownView` in the **public** API still exposes exactly three navigation members:
  `editor: Editor`, `previewMode: MarkdownPreviewView`, and `currentMode: MarkdownSubView`.
  There is **no public `editMode`** and **no public `renderer`/`.renderer.sections`**.
- The **reliable, public way to detect mode** is `MarkdownView.getMode(): 'source' | 'preview'`.
  Do NOT rely on `view.currentMode.type` — `type` is NOT in the public `MarkdownSubView` type
  (only added by `obsidian-typings` and by this repo's own `types.d.ts` augmentation).
- **Scroll container** — the recommended approach:
  - Source / Live Preview: use the CodeMirror scroller `view.editor.cm.scrollDOM`
    (typed via `obsidian-typings`), falling back to a DOM query
    `view.contentEl.querySelector('.cm-scroller')`.
  - Reading / Preview: `view.previewMode.containerEl` **is itself** the scroll container
    (preview uses a single scrollable element). `view.previewMode.renderer.previewEl` is the
    internal inner element.
- **Content container**:
  - Source: `view.editMode` (internal) → `view.editMode.containerEl` is the `.cm-editor`
    element; the actual lines live in `.cm-content` / `.cm-line`.
  - Preview: `view.previewMode.containerEl` holds the rendered `.markdown-preview-view`.
- **Heading positions**: no new public API. Use `app.metadataCache` heading `Pos` +
  CodeMirror geometry (edit) or `renderer.sections` (preview, internal, is recycled).
  Positions must be recomputed each scroll (see repo `learning-log.md`).

---

## 1. What's public vs. internal (authoritative)

Official `obsidian.d.ts` (obsidian-api `master`, mirrors app ~1.7.x):

```ts
export class MarkdownView extends TextFileView implements MarkdownFileInfo {
  /** @public */
  editor: Editor;
  /** @public */
  previewMode: MarkdownPreviewView;
  /** @public */
  currentMode: MarkdownSubView;
  // ...
  /** @public */
  getMode(): MarkdownViewModeType;   // 'source' | 'preview'
}

export type MarkdownViewModeType = 'source' | 'preview';

export class MarkdownPreviewView extends MarkdownRenderer implements MarkdownSubView, MarkdownPreviewEvents {
  /** @public */
  containerEl: HTMLElement;
  // ...
  /** @public */ rerender(full?: boolean): void;
  /** @public */ getScroll(): number;       // <-- official scroll helpers
  /** @public */ applyScroll(scroll: number): void;
}

export interface MarkdownSubView {
  getScroll(): number;
  applyScroll(scroll: number): void;
  get(): string;
  set(data: string, clear: boolean): void;
}
```

**What is NOT public** (not in official `obsidian.d.ts`):
- `MarkdownView.editMode` — not in the official type. Only `obsidian-typings` (v2.2.0)
  declares it as `editMode: MarkdownEditView` (a.k.a. `MarkdownSourceView` in older docs).
- `MarkdownSourceView` — the class name no longer appears anywhere in the current official
  API or obsidian-typings; the internal editing view is `MarkdownEditView`. The old
  `MarkdownSourceView.containerEl` belongs to the deprecated **CM5** (CodeMirror 5) editor era.
- `MarkdownPreviewView.renderer` / `renderer.sections` — internal `ReadViewRenderer` only
  (see §4).
- `MarkdownSubView.type` — `MarkdownSubView` is public but does **not** declare a `type`
  member. `'source' | 'preview'` typing is only provided by `obsidian-typings` and by this
  repo's own `types.d.ts` augmentation (lines 42–52).

Source: `https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts`
(the `MarkdownView`, `MarkdownPreviewView`, `MarkdownSubView`, `MarkdownViewModeType` blocks).

---

## 2. What happened in recent updates (mid-2025 / 1.7–1.9)

- The `Editor`/mode internals moved to CM6 fully; the public surface kept
  `editor`, `previewMode`, `currentMode` and added `getMode()`.
- `MarkdownPreviewView` gained official `getScroll()` / `applyScroll()` helpers (public).
- `Editor` gained public `getScrollInfo(): { top, left }` (marked `@since 0.11.11` —
  actually public for a long time, so it is stable).
- `obsidian-typings` documents a large **internal** surface (reverse-engineered, marked
  "unstable"): `MarkdownEditView`, `ReadViewRenderer`, `BaseEditor.cm`, etc.
- No official announcement removed `previewMode`/`currentMode`; they remain the public
  entry points. What changed is that many plugins are told to prefer `getMode()` and
  DOM-query the scroller rather than poke at internal `renderer.sections`.

---

## 3. Recommended pattern: scroll & content containers

### Mode detection (public, recommended)

```ts
import { MarkdownView } from 'obsidian';
const view = app.workspace.getActiveViewOfType(MarkdownView);
const mode = view?.getMode();          // 'source' | 'preview'
const isPreview = mode === 'preview';
```

### Source / Live-Preview

Get the CodeMirror scroller. The internal `Editor.cm` is a CodeMirror 6 `EditorView` whose
`.scrollDOM` is the scrollable element. This repo's own `getScroller()` already does this,
with fallbacks:

```ts
// view.editor.cm — typed via obsidian-typings (BaseEditor.cm: EditorView)
const scroller =
  view.editor.cm?.scrollDOM ??                      // preferred: CM6 scroller
  view.editMode?.containerEl?.querySelector<HTMLElement>('.cm-scroller') ??
  view.editMode?.containerEl ??
  view.contentEl?.querySelector<HTMLElement>('.cm-scroller') ??
  null;
```

- Content container: `view.editMode.containerEl` (the `.cm-editor`); actual text lives in
  `.cm-contentContainer .cm-content .cm-line`.
- The `.cm-scroller` class is the standard CM6 scroll element (shared by Obsidian).
- For scroll positions you can also use the public `view.editor.getScrollInfo().top` instead
  of reading `scroller.scrollTop`, which is more robust.

### Preview / Reading mode

```ts
const scroller =
  view.previewMode.containerEl ??                     // the scroll container itself
  view.previewMode.renderer?.previewEl ??            // internal inner element
  view.contentEl.querySelector<HTMLElement>('.markdown-preview-view') ??
  view.contentEl.querySelector<HTMLElement>('.markdown-reading-view') ??
  null;
```

- In reading/preview, **`previewMode.containerEl` is the scroll element** — attach the
  `scroll` listener there.
- `renderer.previewEl` is the internal wrapper. `markdown-preview-view` and
  `markdown-reading-view` are CSS classes present in the DOM and can be used as stable
  DOM query fallbacks.

> Mobile note: on mobile Obsidian the `.cm-scroller`/`scrollDOM` selectors behave slightly
> differently; this repo added mobile scroller fallbacks for that reason (see
> `research/mobile-sticky-headings-not-visible.md`). Keep the fallback chain.

---

## 4. `renderer.sections` / heading positions

### Preview sections

`MarkdownPreviewView.renderer` (type `ReadViewRenderer`, internal) has:
```ts
export interface RendererSection {
  el: HTMLElement;
  html: string;      // raw rendered HTML of the section
  rendered: boolean;
}
// ReadViewRenderer:
sections: RendererSection[];
previewEl: HTMLElement;
```
- **`height` is NOT a documented field.** This repo's `types.d.ts` (lines 53–55) augments
  `RendererSection` with `height: number` and `getShownHeadings.ts` reads `sections.forEach
  (({ html, height = 0 }) => ...)` via `@ts-expect-error`. That `height` is reverse-engineered
  and fragile.
- Section HTML: heading sections start with `<h1`–`<h6`, so you can detect heading sections
  by regex on `section.html`, then accumulate `height` to derive pixel offsets.
- Because sections are **recycled** as you scroll (the renderer only keeps a window of
  rendered sections), you MUST recompute offsets on each scroll — they cannot be cached
  across scroll ticks (matches this repo's `learning-log.md` finding for CM6).

### Edit (CM6 geometry — robust)

The recommended, stable way for source mode is to map heading offsets via CodeMirror
geometry using `metadataCache` positions:
```ts
const cm = view.editor.cm;                    // EditorView (obsidian-typings)
const lineBlock = cm.lineBlockAt(pos.start.offset); // returns {top, height, ...}
const top = lineBlock.top;                    // in scroller coordinates
```
This is what `getHeadingsWithOffsetSource` does. It is far more reliable than walking DOM
`.cm-line` nodes (which CM6 virtualizes).

### Heading data (public, reliable)
```ts
const headings = app.metadataCache.getFileCache(file)?.headings ?? [];
// HeadingCache: { heading: string, level: number, position: Pos }
// position.start.offset / position.start.line
```
Positions are document-relative (character offsets / line numbers), NOT pixel offsets.

---

## 5. Newer public APIs you asked about (confirmations)

| API | Public? | Notes |
|-----|---------|-------|
| `view.editor.getScrollInfo()` | ✅ public (since 0.11.11) | returns `{ top, left }` — use for reading scroll position |
| `MarkdownView.getMode()` | ✅ public | returns `'source' \| 'preview'` — preferred over `currentMode.type` |
| `view.previewMode.containerEl` | ✅ public | scroll container in preview |
| `.markdown-source-view` (CSS) | — | present on source view root; use as DOM fallback |
| `.markdown-reading-view` (CSS) | — | present on reading view; DOM fallback |
| `.markdown-preview-view` (CSS) | — | present on preview; DOM fallback |
| `.cm-scroller` (CSS) | — | CM6 scroller element (shared) |
| `view.editor.cm` | ⚠️ internal (obsidian-typings) | `BaseEditor.cm: EditorView`; `.scrollDOM` is the scroller |
| `view.editMode` | ⚠️ internal (obsidian-typings) | `MarkdownEditView`; NOT public |
| `view.previewMode.renderer` | ⚠️ internal (obsidian-typings) | `ReadViewRenderer`; `sections` not public/stable |
| `MarkdownSourceView.containerEl` | ⛔ removed/deprecated | old CM5-era internal; no longer exists as such |

`EditorScrollInfo` also exists as a richer type `{ left, top, width, height, clientWidth,
clientHeight }` in the API — but `Editor.getScrollInfo()` returns only `{ top, left }`.

---

## 6. Implications for this plugin (`obsidian-sticky-headings-no-flicker`)

- `getScroller()` in `src/utils/obsidian.ts` already has the correct order and fallbacks.
  Consider preferring `view.editor.getScrollInfo().top` for source scroll position, and
  `view.previewMode.getScroll()` for preview, as more stable than raw `scrollTop` — but keep
  listening to the `scroll` event on the container itself to trigger updates.
- `view.editMode.sourceMode` and `view.currentMode.type !== 'preview'` (used in
  `isEditSourceMode`/`isEditMode`) rely on non-public fields. Prefer `view.getMode()`:
  - `isEditMode`  = `view.getMode() !== 'preview'`
  - `isEditSourceMode` = `view.getMode() === 'source'`
  This removes the need for the `MarkdownSubView.type` augmentation.
- `renderer.sections` usage in `getHeadingsWithOffsetPreview` is fragile; keep the DOM-based
  fallback (`getPreviewOffsetsDOM`) and, if `height` disappears, switch fully to
  `containerEl.querySelectorAll('h1…h6')` geometry.
- Reconsider `obsidian-typings` (already a dependency) — its `BaseEditor.cm`,
  `MarkdownEditView`, and `ReadViewRenderer` typings are what make the current internal
  access compile.

---

## Key URLs

- Official API d.ts: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- API changelog (1.7.x notes): https://github.com/obsidianmd/obsidian-api/blob/master/CHANGELOG.md
- Obsidian Typings (internal APIs): https://github.com/obsidian-typings/obsidian-typings
  - README: https://raw.githubusercontent.com/Fevol/obsidian-typings/master/README.md
  - Internal ReadViewRenderer docs: https://obsidian-typings.github.io/obsidian-typings/catalyst/api/obsidian/internals/ReadViewRenderer/
- Sample plugin (current src layout + AGENTS.md): https://github.com/obsidianmd/obsidian-sample-plugin
  - AGENTS.md (official plugin conventions): https://raw.githubusercontent.com/obsidianmd/obsidian-sample-plugin/master/AGENTS.md
- Developer docs: https://docs.obsidian.md
- Forum discussion on rendered HTML internals: https://forum.obsidian.md/t/how-to-get-the-rendered-markdown-html/91020
