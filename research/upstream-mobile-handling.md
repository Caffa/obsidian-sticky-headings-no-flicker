# Upstream "Another Sticky Headings" — Mobile Handling Research

Source: https://github.com/zhouhua/obsidian-sticky-headings (branch `master`, plugin id `another-sticky-headings`, version 2.1.3)
Retrieved: 2026-08-26

> **Key finding up front:** This upstream plugin is *different* from the architecture implied by the questions. It does **NOT** use `Platform.isMobile` branches anywhere, does **NOT** use `editor.cm`/`previewMode.renderer` as a *render* API (it only reads CM's scroll DOM / preview element), does **NOT** special-case mobile CSS, and mounts **two** Svelte components (one for edit/source, one for preview) per view. Mobile is effectively only acknowledged via `isDesktopOnly: false` in manifest.json and two open feature-request issues.

---

## 1. Whether it uses `Platform.isMobile` branches

**No.** No file in the repo branches on `Platform.isMobile` (or `Platform.isDesktop`). I searched the full source tree and the complete issue list; the only place "mobile" appears is:
- `manifest.json` → `"isDesktopOnly": false` (simply claims mobile support, nothing more)
- Two open FR issues (see §7)

The plugin logic is mode-based, not device-based. The relevant runtime branch is **editor mode vs. preview mode** via `isEditMode` / `isEditSourceMode`, never desktop-vs-mobile.

---

## 2. How `getScroller` detects the scroll container

File: `src/utils/obsidian.ts`

```ts
export const isEditSourceMode = (view: MarkdownView) =>
  view.editMode.sourceMode && view.currentMode.type !== 'preview';

// used to check if we are in source mode OR live preview
export const isEditMode = (view: MarkdownView) => view.currentMode.type !== 'preview';

export const getScroller = (view: MarkdownView) =>
  isEditMode(view) ? view.editor.cm.scrollDOM : view.previewMode.renderer.previewEl;

export const getContainerEl = (el: HTMLElement | Element) =>
  el.closest('.markdown-reading-view, .markdown-source-view')?.querySelector('.sticky-headings-root');
```

Notes:
- It **does** touch internal APIs: `view.editor.cm.scrollDOM` (CodeMirror's scroll element) for edit mode, and `view.previewMode.renderer.previewEl` for preview mode. But it does **not** call `editor.cm` for rendering or `previewMode.renderer.render()` — only to grab the scroll container element.
- The scroller is chosen purely by **edit mode**, not by platform. There is no `Platform.isMobile` branch to pick a different scroller. Both mobile and desktop would use the same `view.editor.cm.scrollDOM` / `view.previewMode.renderer.previewEl` code paths.
- `getContainerEl` finds `.sticky-headings-root` inside the `markdown-reading-view` / `markdown-source-view` ancestor — again nothing mobile-specific.

The Svelte component also calls the same `getScroller(view)` (`src/ui/StickyHeader.svelte` imports it from `src/utils/obsidian`).

---

## 3. Whether it mounts one or two Svelte components

**Two** Svelte components per leaf — one targeted at the preview element, one at the edit/source element.

File: `src/stickyHeader.ts`

```ts
import StickyHeader from './ui/StickyHeader.svelte';

export default class StickyHeaderComponent {
  stickyHeaderComponents!: [StickyHeader, StickyHeader];

  addStickyHeader(view: MarkdownView, settings: ISetting) {
    const previewContentEl = view.previewMode.containerEl;
    const sourceContentEl = view.editMode.editorEl;
    this.stickyHeaderComponents = [
      new StickyHeader({
        target: previewContentEl,
        props: { headings: [], editMode: false, view, getExpectedHeadings: () => [], settings, showFileName: false, expectedHeadings: [] },
      }),
      new StickyHeader({
        target: sourceContentEl,
        props: { headings: [], editMode: false, view, getExpectedHeadings: () => [], settings, showFileName: false, expectedHeadings: [] },
      }),
    ];
  }

  removeStickyHeader() {
    this.stickyHeaderComponents.forEach(component => component.$destroy());
  }

  updateHeadings(headings, getExpectedHeadings, showFileName, view) {
    this.stickyHeaderComponents.forEach(component =>
      component.$set({ headings, getExpectedHeadings, showFileName, view })
    );
  }
  predictHeadingsHeight(headings) {
    this.stickyHeaderComponents.forEach(component => component.$set({ expectedHeadings: headings }));
  }
  updateEditMode(editMode) {
    this.stickyHeaderComponents.forEach(component => component.$set({ editMode }));
  }
  updateSettings(settings) {
    this.stickyHeaderComponents.forEach(component => component.$set({ settings }));
  }
}
```

This is confirmed by a PR titled **"Add Svelte components separately for preview mode and edit mode"** in the repo history.

---

## 4. Internal APIs (`editor.cm`, `previewMode.renderer`)

- `view.editor.cm` — **used** to reach `cm.scrollDOM` (scroll element) in `getScroller`, and in `getHeadingsWithOffsetSource` (`src/utils/getShownHeadings.ts`) via `view.editor.cm.lineBlockAt(position.start.offset)` to compute heading offsets.
- `view.previewMode.renderer` — **used** only to reach `renderer.previewEl` (the scroll element). It does **not** call `renderer.render()`.
- `view.previewMode.containerEl`, `view.editMode.editorEl`, `view.editMode.containerEl` — used as Svelte mount targets and offset lookups.
- `MarkdownRenderer.render(app, ...)` — used in `parseMarkdown` for heading title rendering, with an `activeView` context (a documented internal API, `MarkdownRenderer.render(app, source, el, sourcePath, component)`).

So the answer to "does it use internal APIs like editor.cm or previewMode.renderer" is **yes**, but only for scroll-container / geometry, not for invoking rendering.

---

## 5. CSS differences for mobile

**None.** `styles.css` (1,162 bytes) is short and has **no** `@media` queries, no `is-mobile` / `is-ios` overrides, and no viewport-width rules. Full content:

```css
/* @settings ... (settings definitions) */
:root {
  --sticky-header-indent-width: 1em;
  --sticky-header-verticle-offset: 0px;
  --sticky-header-float-background-color: #000;
  --sticky-header-float-text-color: #fff;
}
.view-content {
  position: relative;
}
```

Additional CSS lives inside the Svelte component's `<style>` block (see `src/ui/StickyHeader.svelte`). Key layout rules there:
- `.sticky-headings-root` is `position: absolute; top: 0; width: 100%; z-index: 1; padding: 0 var(--file-margins); padding-top: var(--sticky-header-verticle-offset);`
- `.sticky-headings-container { max-width: min(var(--file-line-width), var(--max-width)); margin: 0 auto; font-size: 12px; }`
- Themes: `flat` (solid `--background-primary`), `blur` (`backdrop-filter`), `float` (rounded pill with `--sticky-header-float-*` colors).
- A `.sticky-headings-shadow` clone (opacity 0, pointer-events none) is used for height prediction.

No mobile-specific rules anywhere.

---

## 6. `manifest.json` and `esbuild.config.mjs`

`manifest.json`:
```json
{
  "id": "another-sticky-headings",
  "name": "Another Sticky Headings",
  "version": "2.1.3",
  "minAppVersion": "1.5.3",
  "description": "Display headings tree during editing and preview to indicate the current position.",
  "author": "Zhou Hua",
  "authorUrl": "https://zhouhua.site",
  "isDesktopOnly": false
}
```
`isDesktopOnly: false` → packaged for mobile, but no actual mobile handling.

`esbuild.config.mjs`: standard Obsidian plugin build with `esbuild-svelte` (`compilerOptions: { css: 'injected' }`, `sveltePreprocess()`), entry `main.ts`, externals `obsidian`, `electron`, and the CodeMirror/Lezer packages. Nothing mobile-specific. `main.ts` is just `import Plugin from './src/plugin'; export default Plugin;`.

---

## 7. Issues / PRs mentioning mobile

Search `repo:zhouhua/obsidian-sticky-headings` for "mobile" → 2 hits, both **open** feature requests (no PRs, no code changes, no maintainer response visible):

- **Issue #51 — "[FR] For mobile: to hide sticky heading when onscreen keyboard is shown"** (open, 2025-08-21, +1 reaction). Wants the sticky bar hidden while the virtual keyboard is up to reclaim vertical space; currently it is always shown.
- **Issue #50 — "[FR] don't cover heading you've jumped to on Mobile"** (open, 2025-08-16). After tapping a heading link on mobile, the jumped-to heading sits at the top of the screen but is **covered by the sticky bar**, because Obsidian doesn't account for the reduced usable height. Wants the scroller to scroll slightly further down.

Other relevant-but-not-mobile issues found via keyword search:
- **#38 "Clicked Heading Is Placed In Middle Of Screen Due To `setEphemeralState`"** — about scroll/jump behavior (not mobile-specific).
- **#22 / #36 "Refactoring Scrolling Behaviour (WIP)"** PRs — the scroll/jump architecture, not mobile-specific.

So: mobile is acknowledged only through `isDesktopOnly: false` and two open FRs; the plugin has **no** mobile-specific runtime code, no `Platform.isMobile`, and no mobile CSS.

---

## Summary table

| Question | Answer |
|---|---|
| `Platform.isMobile` branches | **No** — nowhere in the codebase |
| `getScroller` detection | `isEditMode(view) ? view.editor.cm.scrollDOM : view.previewMode.renderer.previewEl` — mode-based, platform-agnostic |
| Svelte mounts | **Two** (one on `previewMode.containerEl`, one on `editMode.editorEl`), managed in `StickyHeaderComponent` |
| Internal APIs used | `editor.cm.scrollDOM`, `editor.cm.lineBlockAt()`, `previewMode.renderer.previewEl` (scroll container only), `MarkdownRenderer.render` (title rendering). No renderer call for the sticky bar itself |
| Mobile CSS | **None** — no `@media`, no `.is-mobile`, no mobile theme rules |
| Mobile issues/PRs | Only 2 open FRs: #50 (heading covered after jump) and #51 (hide on keyboard); no mobile PRs |

## Files reviewed
- `src/utils/obsidian.ts` — `getScroller`, `getContainerEl`, `isEditMode`, `isEditSourceMode`, `parseMarkdown`
- `src/utils/getShownHeadings.ts` — `getHeadingsWithOffsetSource` (uses `cm.lineBlockAt`)
- `src/utils/scroll.ts` — `animateScroll`
- `src/stickyHeader.ts` — two-component mount
- `src/ui/StickyHeader.svelte` — component markup + styles
- `src/plugin.ts` — plugin lifecycle, scroll listener wiring
- `styles.css`, `manifest.json`, `esbuild.config.mjs`
- GitHub issues/PRs search
