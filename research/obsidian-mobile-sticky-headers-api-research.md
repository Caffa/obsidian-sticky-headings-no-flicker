# Obsidian Mobile Plugin Development: Sticky Headers API Research

**Date:** 2026-08-26
**Scope:** Correct public APIs for mode detection, mobile scroll containers, scroll-listener attachment, platform detection, common mobile failure patterns, and mobile testing/debugging.
**Method:** Official `obsidian.d.ts` typings (unpkg latest), official developer docs (raw GitHub), reverse-engineered internal typings (`obsidian-typings`), and three reference implementations (zhouhua/obsidian-sticky-headings, omeyenburg/obsidian-scrolling, designdebt.club article).

---

## TL;DR (answers up front)

1. **Mode detection:** Use the **public** `view.getMode()` → `'source' | 'preview'` (type `MarkdownViewModeType`). `view.currentMode` is public but only exposes `getScroll()/applyScroll()/get()/set()`; `view.editMode`/`view.previewMode` are **internal** (not in official typings). For "is this the editor (source or live preview)" logic, the reference plugin uses `view.currentMode.type !== 'preview'` (internal `type` field) — but `getMode()` is the only fully public, stable check.
2. **`view.editor.cm` and `view.previewMode.renderer.previewEl` are NOT public.** They are internal/unofficial. They work at runtime on both desktop and mobile (the zhouhua sticky-headings plugin relies on exactly these), but you must guard them with fallbacks and null-checks. Recommended fallback selectors: `.cm-scroller` (edit), `.markdown-preview-view` / `.markdown-reading-view` (preview), `.view-content` (generic ancestor scroller).
3. **Attach scroll listeners to the actual scroller, in the capture phase.** The reference plugin attaches to `view.contentEl` with `addEventListener('scroll', fn, true)` (capture) and then resolves the real scroller via `event.target.closest('.view-content')`. Attaching to an ancestor with capture is the robust pattern because the scroller element can be recreated (lazy DOM). `window` scroll does NOT work (the markdown view is a div, not the window).
4. **Platform detection:** Use `Platform.isMobile`, `Platform.isIosApp`, `Platform.isAndroidApp`, `Platform.isPhone`, `Platform.isTablet`, `Platform.isDesktopApp`, etc. (all public). CSS: the app adds `.is-mobile` / `.is-phone` / `.is-tablet` / `.is-ios` / `.is-android` classes to the root — use these for CSS-only behavior. `this.app.isMobile` also exists (used for emulation toggle).
5. **Common mobile failure patterns:** "Failed to load plugin" (Node/Electron APIs unavailable, regex lookbehind on old iOS, top-level `require` of Node modules, missing `isDesktopOnly`), null internal APIs (`.cm`/`.previewEl` not yet created — lazy DOM), scroll container differences, safe-area insets, and the fact that mobile uses a Capacitor webview (no Node.js).
6. **Testing/debugging:** `this.app.emulateMobile(true)` in DevTools console; Android via `chrome://inspect` (USB debugging); iOS 16.4+ via Safari Web Inspector; the `logstravaganza` plugin for on-device console logs.

---

## 1. Mode detection: the correct public API

### Public API (from official `obsidian.d.ts`)

```ts
export type MarkdownViewModeType = 'source' | 'preview';

export class MarkdownView extends TextFileView implements MarkdownFileInfo {
    editor: Editor;                 // public
    previewMode: MarkdownPreviewView; // public (but MarkdownPreviewView's internals are not)
    currentMode: MarkdownSubView;   // public
    getMode(): MarkdownViewModeType; // public — THE canonical mode check
    // ...
}
```

- **`view.getMode()`** returns `'source' | 'preview'` and is the **only fully public, stable** way to detect mode. Use this.
- `view.currentMode` is public but typed as `MarkdownSubView`, which only exposes `getScroll()`, `applyScroll()`, `get()`, `set()`. It does **not** expose a `type` field in the official typings.
- `view.editMode` and `view.previewMode` are **not** in the official typings at all — they are internal (confirmed by `obsidian-typings` which marks them `@unofficial`).

### What the reference plugin actually does

The zhouhua/obsidian-sticky-headings plugin (the closest analog to your project) uses **internal** fields for finer-grained logic:

```ts
// src/utils/obsidian.ts
export const isEditSourceMode = (view: MarkdownView) =>
    view.editMode.sourceMode && view.currentMode.type !== 'preview';
export const isEditMode = (view: MarkdownView) =>
    view.currentMode.type !== 'preview';
```

Note it reads `view.currentMode.type` (internal) and `view.editMode.sourceMode` (internal). This distinguishes "source mode" from "live preview" (both are the editor). If you only need "editor vs reading view", `getMode()` is sufficient and safer.

**Recommendation:** Use `view.getMode() === 'source'` for the coarse check. If you need to distinguish source vs live-preview, you must reach into internals (`view.currentMode.type`), which is what the reference plugin does — accept the fragility and guard it.

---

## 2. `view.editor.cm` and `view.previewMode.renderer.previewEl` on mobile

### These are internal, not public

- **`view.editor.cm`** — `editor` is public (`Editor`), but `.cm` is **not** in the official typings. `obsidian-typings` confirms the internal structure: `MarkdownBaseView.cm: EditorView` (a CodeMirror 6 `EditorView`), and `cm.scrollDOM` is the CM6 scroller element. It is marked `@unofficial`.
- **`view.previewMode.renderer.previewEl`** — `previewMode` is public, but `.renderer` is **not**. `obsidian-typings` confirms `MarkdownPreviewView.renderer: ReadViewRenderer` (internal) and `ReadViewRenderer.previewEl: HTMLElement` (internal). Both marked `@unofficial`.

### Are they reliable on mobile?

**At runtime, yes — they work on both desktop and mobile.** The zhouhua sticky-headings plugin uses exactly these:

```ts
// src/utils/obsidian.ts
export const getScroller = (view: MarkdownView) =>
    isEditMode(view) ? view.editor.cm.scrollDOM : view.previewMode.renderer.previewEl;
```

This is a published, widely-used plugin that works on mobile. So the pattern is proven. **However**, because they are internal:
- They can change/break without notice (Obsidian does not guarantee them).
- They may be `null`/`undefined` at certain lifecycle moments (lazy DOM creation — see §5).
- TypeScript will not type them without `@ts-ignore` or the `obsidian-typings` package.

### Recommended fallbacks

The designdebt.club article (Dale de Silva) recommends the DOM-selector approach as a robust alternative:

```ts
// Edit mode: the CM6 scroller
const scrollableEl = contentEl.closest('.cm-scroller');
scrollableEl.addEventListener('scroll', handleScrolling);
```

The zhouhua plugin also uses `.view-content` as a generic ancestor scroller and `.markdown-reading-view, .markdown-source-view` for container detection:

```ts
export const getContainerEl = (el) =>
    el.closest('.markdown-reading-view, .markdown-source-view')
      ?.querySelector('.sticky-headings-root');
```

**Recommended fallback chain for the scroller element:**
1. Edit mode: `view.editor.cm?.scrollDOM` → fallback `view.contentEl.querySelector('.cm-scroller')`.
2. Preview mode: `view.previewMode?.renderer?.previewEl` → fallback `view.contentEl.querySelector('.markdown-preview-view, .markdown-reading-view')`.
3. Generic ancestor: `view.contentEl` (or `.view-content`) — always exists, and you can attach a capture-phase listener here (see §3).

**Key insight from the designdebt article:** `position: sticky` does NOT work in Obsidian because the markdown view is a scrolling **div**, not the window. And `window.scrollY` is always 0. You must read `scrollTop` from the actual scroller element.

---

## 3. Attaching scroll listeners on mobile

### Attach to the actual scroller, in the capture phase

The zhouhua plugin's pattern (proven on mobile):

```ts
// In handleComponentUpdate:
const scroller = getScroller(view); // view.editor.cm.scrollDOM OR view.previewMode.renderer.previewEl
// ...
item.view.contentEl.addEventListener('scroll', newScrollListener, true); // capture = true
```

And the handler resolves the real scroller from the event target:

```ts
detectPosition = throttle((event, scroller, item) => {
    const target = event.target as HTMLElement | null;
    if (scroller) {
        const container = target?.closest('.view-content');
        if (container) {
            this.setHeadingsInView(scroller, item);
        }
    }
}, 50, { leading: true, trailing: true });
```

**Why capture phase + ancestor?**
- The actual scroller element (`.cm-scroller` / `.markdown-preview-view`) can be **recreated** when the view re-renders or mode changes (lazy DOM). If you attach directly to it, your listener is lost.
- Attaching to a stable ancestor (`view.contentEl` / `.view-content`) with `capture: true` means you catch scroll events from any descendant scroller, even ones created after you attach.
- The omeyenburg/obsidian-scrolling plugin does the same at the workspace level: `registerDomEvent(activeDocument, 'scroll', cb, { capture: true, passive: true })` — capture phase on a broad container.

**Recommendation:** Attach to `view.contentEl` (or `.view-content`) with `capture: true`. In the handler, read `scrollTop` from the resolved scroller (`getScroller(view)`), not from `event.target` (which may be a child). Use `registerDomEvent` (public `Component` API) so it auto-detaches on unload. Re-attach on `layout-change` / `active-leaf-change` / mode change.

**Mobile-specific note:** On mobile, scrolling is touch-driven. The `scroll` event still fires (it's a real DOM scroller), but you may want `passive: true` to avoid blocking touch scrolling, and consider `scrollend` (the omeyenburg plugin registers both `scroll` and `scrollend`). Throttle with `requestAnimationFrame` or a small throttle (the reference uses 50ms lodash throttle).

---

## 4. Platform detection: `Platform` vs CSS classes

### Public `Platform` object (from official `obsidian.d.ts`)

```ts
export const Platform: {
    isDesktop: boolean;      // UI in desktop mode
    isMobile: boolean;       // UI in mobile mode
    isDesktopApp: boolean;   // electron desktop app
    isMobileApp: boolean;    // capacitor-js mobile app
    isIosApp: boolean;       // iOS app
    isAndroidApp: boolean;   // Android app
    isPhone: boolean;        // mobile app, limited screen space
    isTablet: boolean;       // mobile app, large screen space
    isMacOS: boolean;        // macOS (or device pretending, e.g. iPhone/iPad)
    isWin: boolean;
    isLinux: boolean;
    isSafari: boolean;       // Safari workarounds
    resourcePathPrefix: string; // 'file:///' on mobile, 'app://random-id/' on desktop
};
```

All of these are **public** and safe to use. The official mobile-dev docs explicitly recommend:

```ts
import { Platform } from 'obsidian';
if (Platform.isIosApp) { /* ... */ }
if (Platform.isAndroidApp) { /* ... */ }
```

### CSS classes

Obsidian adds platform classes to the root element. Community sources confirm `.is-mobile`, `.is-phone`, `.is-tablet`, `.is-ios`, `.is-android` are used by themes/snippets for device-specific CSS. Use these for CSS-only behavior (e.g., safe-area padding, smaller sticky header on phones):

```css
body.is-mobile .my-sticky-header { /* mobile-specific styles */ }
body.is-phone .my-sticky-header { /* phone-specific */ }
```

### `app.isMobile`

`this.app.isMobile` is a boolean used by the official docs for the emulation toggle (`this.app.emulateMobile(!this.app.isMobile)`). It reflects the current (possibly emulated) mobile state.

**Recommendation:** Use `Platform.isMobile` / `Platform.isIosApp` / `Platform.isAndroidApp` in JS; use `.is-mobile` / `.is-phone` / `.is-tablet` in CSS. Note `Platform.isMobile` reflects the *UI mode* (so it's true under `emulateMobile(true)`), which is usually what you want for layout behavior.

---

## 5. Common mobile plugin failure patterns

### a) "Failed to load plugin" on mobile
- **Node.js / Electron APIs unavailable.** Mobile runs in a Capacitor webview with **no Node.js**. Any `require('fs')`, `require('electron')`, `process.*`, `path`, etc. — directly or via a dependency — crashes the plugin at load. The official docs list this as the #1 mobile issue. Fix: avoid Node APIs, or set `isDesktopOnly: true` in `manifest.json` to prevent mobile install.
- **Regex lookbehind** (`(?<=...)`) only works on iOS 16.4+. Older iOS throws at parse time → plugin fails to load. Use a fallback or feature-detect.
- **Top-level side effects / missing return.** A plugin whose `onload()` throws (or whose module top-level throws) shows "Failed to load plugin". The forum thread (98136) notes plugins can fail on mobile after an Obsidian update even when they log fine on desktop — often an internal API that changed. Wrap risky init in try/catch and log.

### b) Null internal APIs / lazy DOM creation
- `view.editor.cm` and `view.previewMode.renderer.previewEl` may be **null/undefined** until the editor/preview is actually created. The zhouhua plugin handles this by:
  - Waiting ~100ms after `active-leaf-change` before resolving (`setTimeout(..., 100)`).
  - Re-checking on `layout-change` and `metadataCache.resolve`.
  - Guarding with `if (scroller)` before attaching listeners.
- **Recommendation:** Always null-check `.cm` / `.renderer` / `.previewEl`; re-resolve on `layout-change` and `active-leaf-change`; attach listeners to a stable ancestor so you don't lose them when the scroller is recreated.

### c) Scrolling container differences
- The markdown view is a scrolling **div**, not the window → `window.scrollY` is always 0 and `position: sticky` doesn't work. You must read `scrollTop` from the actual scroller (`.cm-scroller` / `.markdown-preview-view`).
- On mobile the scroller may be nested differently and the touch scroll is handled by the webview. Use capture-phase listeners on an ancestor and `passive: true`.

### d) Safe-area insets
- Notches / home indicators can obscure fixed/sticky UI. Use `env(safe-area-inset-top/bottom/left/right)` in CSS. Note: `env(safe-area-inset-*)` only works when the body itself scrolls (no `height:100%`/`overflow:scroll` on parents) — a known gotcha. Community plugins (e.g., belki-tasks) expose a `--belki-mobile-safe-top` CSS variable for this. For a sticky header, add `padding-top: env(safe-area-inset-top)` on mobile.

### e) Other
- **`isDesktopOnly`** in `manifest.json` — if your plugin needs Node/Electron, set it to `true` to prevent mobile installs entirely.
- **Performance:** mobile CPUs are slower; throttle scroll handlers (rAF / 50ms throttle) and avoid layout thrash in scroll handlers.

---

## 6. Mobile testing / remote debugging

From the official "Mobile development" docs:

### Emulate mobile on desktop
Open DevTools → Console:
```ts
this.app.emulateMobile(true);   // enable
this.app.emulateMobile(false);  // disable
this.app.emulateMobile(!this.app.isMobile); // toggle
```

### Android — remote inspect
1. Enable **USB Debugging** in Android Developer settings.
2. Connect device via USB.
3. Open a Chromium browser on desktop → `chrome://inspect/`.
4. Your device appears; run full DevTools on the Obsidian webview.
- More: https://developer.chrome.com/docs/devtools/remote-debugging

### iOS — remote inspect
- Requires iOS 16.4+ and a macOS computer.
- Enable Web Inspector on the device (Settings → Safari → Advanced → Web Inspector) and in Safari on macOS (Develop menu).
- Instructions: https://webkit.org/web-inspector/enabling-web-inspector/

### On-device console without a computer
- The **`logstravaganza`** plugin (community) surfaces console/error logs in-app — recommended in the forum thread for debugging "Failed to load plugin" on mobile.
- Add `console.log()` at the start of `onload()` and each init step to bisect where it fails.

---

## Reference implementations (read these)

- **zhouhua/obsidian-sticky-headings** — the closest analog to your project. Uses `view.editor.cm.scrollDOM` / `view.previewMode.renderer.previewEl`, capture-phase scroll listeners on `view.contentEl`, `.view-content` / `.markdown-reading-view` / `.markdown-source-view` selectors, and re-resolves on `layout-change`/`active-leaf-change`.
  - https://github.com/zhouhua/obsidian-sticky-headings
  - `src/utils/obsidian.ts` (getScroller, isEditMode, getContainerEl)
  - `src/plugin.ts` (scroll listener + lifecycle)
- **omeyenburg/obsidian-scrolling** — robust scroll handling; attaches `scroll`/`scrollend`/`wheel`/`touchmove` listeners with `capture: true` on the document/workspace; uses `Platform.isMobile`/`Platform.isDesktop`; uses `@obsidian-typings` for internal APIs.
  - https://github.com/omeyenburg/obsidian-scrolling
  - `src/core/events.ts`
- **designdebt.club — "Sticky elements in Obsidian markdown views"** — explains why `position: sticky` and `window.scrollY` fail, and the `.cm-scroller` + `scrollTop` approach.
  - https://designdebt.club/sticky-elements-in-obsidian-markdown-views/

## Official docs

- Mobile development (emulation, remote debugging, platform detection, Node/Electron caveats): https://docs.obsidian.md/Plugins/Getting+started/Mobile+development
- MarkdownView API: https://docs.obsidian.md/Reference/TypeScript+API/MarkdownView
- Platform API: https://docs.obsidian.md/Reference/TypeScript+API/Platform
- MarkdownPreviewView API: https://docs.obsidian.md/Reference/TypeScript+API/MarkdownPreviewView
- Official typings source: https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts

## Internal typings (for `.cm`, `.renderer.previewEl`, `.editMode`)

- **obsidian-typings** — reverse-engineered typings for internal APIs. Confirms `MarkdownBaseView.cm: EditorView`, `MarkdownPreviewView.renderer: ReadViewRenderer`, `ReadViewRenderer.previewEl: HTMLElement`, `MarkdownView.editMode: MarkdownEditView`. All marked `@unofficial` with strong warnings to add fallbacks.
  - https://github.com/obsidian-typings/obsidian-typings
  - npm: `@obsidian-typings/obsidian-public-latest`
  - Key files (release/obsidian-public/1.13.7):
    - `src/obsidian/internals/MarkdownBaseView.d.ts` (cm, editorEl, containerEl)
    - `src/obsidian/internals/ReadViewRenderer.d.ts` (previewEl, pusherEl)
    - `src/obsidian/augmentations/views/MarkdownView.d.ts` (editMode, previewMode, currentMode)
    - `src/obsidian/augmentations/MarkdownPreviewView.d.ts` (renderer)
    - `src/obsidian/augmentations/MarkdownEditView.d.ts`

---

## Concrete recommendation for your sticky-headers plugin

1. **Mode:** `view.getMode()` for source-vs-preview. If you need source-vs-live-preview, use `view.currentMode.type !== 'preview'` (internal, guard it).
2. **Scroller resolution (with fallbacks):**
   ```ts
   function getScroller(view: MarkdownView): HTMLElement | null {
     if (view.getMode() === 'source') {
       return (view.editor as any).cm?.scrollDOM
         ?? view.contentEl.querySelector('.cm-scroller');
     }
     return (view.previewMode as any).renderer?.previewEl
       ?? view.contentEl.querySelector('.markdown-preview-view, .markdown-reading-view');
   }
   ```
3. **Scroll listener:** attach to `view.contentEl` with `capture: true` via `registerDomEvent`; read `scrollTop` from `getScroller(view)`; re-resolve on `layout-change` and `active-leaf-change`; throttle with rAF.
4. **Platform:** `Platform.isMobile` / `Platform.isIosApp` / `Platform.isAndroidApp` in JS; `.is-mobile` / `.is-phone` in CSS; add `env(safe-area-inset-top)` padding on mobile.
5. **Robustness:** null-check all internal APIs; wrap init in try/catch; avoid Node/Electron APIs; test with `emulateMobile(true)` and real devices via `chrome://inspect` / Web Inspector.
