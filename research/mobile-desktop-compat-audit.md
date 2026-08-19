# Mobile vs Desktop Compatibility Audit — Sticky Headings Plugin

Date: 2026-08-17
Scope: `src/plugin.ts`, `src/stickyHeader.ts`, `src/ui/StickyHeader.svelte`, `src/utils/obsidian.ts`, `src/utils/getShownHeadings.ts`, `src/utils/scroll.ts`, `styles.css`

This audit focuses on real Obsidian mobile/desktop differences: missing scroll containers, `previewEl` vs `containerEl`, `editor.cm.scrollDOM` availability, touch vs pointer events, fallback paths, hardcoded desktop assumptions, lazy DOM creation, performance on slower devices, and the dual Svelte mount in `stickyHeader.ts`.

---

## Findings

### 1. `getScroller` returns `null` on mobile in edit mode → sticky header never updates

**File/line:** `src/utils/obsidian.ts:41-49`

```ts
export const getScroller = (view: MarkdownView): HTMLElement | null => {
  if (isEditMode(view)) {
    return view?.editor?.cm?.scrollDOM ?? null; // <-- null on mobile
  }
  return view?.previewMode?.containerEl ?? view?.previewMode?.renderer?.previewEl ?? null;
};
```

**Risk:** On mobile, `view.editor.cm` is frequently `undefined` until the editor is fully mounted, and `cm.scrollDOM` is an internal CodeMirror 6 field that is not guaranteed to exist on the mobile editor. When it returns `null`, `plugin.ts` takes the `else` branch in `handleComponentUpdate` (lines 275-279) and **never attaches a scroll listener**, so the sticky header never updates as the user scrolls. The code already has a fallback for preview mode (`previewEl`) but **no fallback for edit mode**.

**Why it matters:** This is the single most likely cause of "sticky header frozen / not visible on mobile" — the scroll listener is simply never attached, so `setHeadingsInView` is never called on scroll.

**Fix:** Add a fallback chain for edit mode, mirroring the preview fallback:

```ts
if (isEditMode(view)) {
  return (
    view?.editor?.cm?.scrollDOM ??
    view?.editMode?.containerEl?.querySelector('.cm-scroller') ??
    view?.editMode?.containerEl ??
    null
  );
}
```

**Test:** Unit-test `getScroller` with a mock view where `editor.cm` is `undefined` but `editMode.containerEl` exists; assert it returns the container rather than `null`. Also add an integration check that a scroll listener is attached when `getScroller` returns the fallback.

---

### 2. `updateHeadings` fallback uses `contentEl` which is NOT the scroll container

**File/line:** `src/plugin.ts:223-233`

```ts
updateHeadings(file, view, item) {
  const scroller = getScroller(view);
  if (scroller) {
    this.setHeadingsInView(scroller, item);
  } else {
    // On mobile the internal previewEl may be missing; still render headings
    // using the view content container as a fallback reference.
    this.setHeadingsInView(item.view.contentEl, item);   // <-- contentEl is not a scroller
  }
}
```

**Risk:** `view.contentEl` is the outer content wrapper, not the element that actually scrolls. `setHeadingsInView` reads `scroller.scrollTop` (line 288) and `scroller.clientHeight` (line 289). On a non-scrolling element, `scrollTop` is always `0` and `clientHeight` is the full content height, so the "in view" computation (`heading.offset < scrollTop + stuckHeaderHeight`, line 317) collapses to `offset < 0` → **no headings ever shown** (except the forced first one at line 320). The fallback "works" only in the sense that it doesn't crash; it renders the wrong result.

**Why it matters:** The fallback path is explicitly intended for mobile but computes against the wrong element, producing a broken/empty sticky header.

**Fix:** In the fallback, find the real scroller inside the view (e.g. `.cm-scroller` in edit mode, `.markdown-preview-view` / `previewEl` in preview) rather than using `contentEl`. If no scroller can be found, skip the update instead of computing against `contentEl`.
**Test:** Add a test that `updateHeadings` with a mock view lacking a scroller does not call `setHeadingsInView` with `contentEl`; assert it either finds a nested scroller or bails.

---

### 3. Scroll listener attached to `contentEl` with capture — wrong element on mobile

**File/line:** `src/plugin.ts:265-273`

```ts
const newScrollListener = (event: Event) => {
  this.detectPosition(event, scroller, item);
};
if (item.view.contentEl) {
  item.view.contentEl.addEventListener('scroll', newScrollListener, true);
}
```

**Risk:** The listener is attached to `view.contentEl` (capture phase), but the actual scroll events fire on the scroller (`cm.scrollDOM` / `previewEl`). On desktop this often still works because the scroller is a descendant of `contentEl` and capture-phase listeners on an ancestor receive bubbled scroll events. On mobile, where the scroller may be a different subtree or where `contentEl` is not an ancestor of the real scroller, the listener may never fire. Additionally, `detectPosition` (lines 36-48) requires `target.closest('.view-content')` to be truthy — if the scroll target isn't inside `.view-content`, the update is silently skipped.

**Why it matters:** Even when `getScroller` succeeds, the listener may be attached to the wrong element, so the header still doesn't track scroll on mobile.

**Fix:** Attach the scroll listener directly to the scroller returned by `getScroller` (the element that actually scrolls), not to `contentEl`. Keep the capture flag only if needed for the scroller's own children.
**Test:** Integration test: dispatch a `scroll` event on the scroller element and assert `setHeadingsInView` is invoked; then dispatch on `contentEl` and assert it is _not_ the sole trigger.

---

### 4. Dual Svelte mount in `stickyHeader.ts` — double rendering + missing overlay on mobile

**File/line:** `src/stickyHeader.ts:31-69`

```ts
const previewContentEl = view.previewMode.containerEl;
const sourceContentEl = view.editMode.editorEl;
this.stickyHeaderComponents = [
  new StickyHeader({ target: previewContentEl, ... }),
  new StickyHeader({ target: sourceContentEl, ... }),
];
```

**Risk:** Two Svelte components are always mounted — one into `previewMode.containerEl`, one into `editMode.editorEl`. On mobile these containers are **lazily created**; `view.editMode.editorEl` may be `undefined`/detached at mount time, so the second component either throws or mounts into a detached node that is never shown. Meanwhile `updateHeadings` (lines 97-99) calls `$set` on **both** components, so the visible one renders twice per update (double DOM work on a slow device). The comment at lines 38-40 acknowledges mobile laziness but does not guard against a missing target.

**Why it matters:** (a) Double rendering = wasted work on mobile; (b) if `editorEl` is missing, the component mounts into a detached node and the sticky overlay is invisible in edit mode on mobile; (c) `new StickyHeader({ target: undefined })` can throw and break `addStickyHeader`.

**Fix:** Guard each mount: only create the component if the target exists, and re-create it lazily when the target appears (e.g. on `layout-change`). Track which components are actually mounted and only `$set` on mounted ones.

```ts
const targets = [view.previewMode.containerEl, view.editMode.editorEl].filter(Boolean);
this.stickyHeaderComponents = targets.map(target => new StickyHeader({ target, ... }));
```

**Test:** Unit-test `addStickyHeader` with a mock view where `editMode.editorEl` is `undefined`; assert it does not throw and mounts only the preview component. Test that `updateHeadings` does not `$set` on a destroyed/missing component.

---

### 5. `predictHeadingsHeight` MutationObserver never resolves on mobile → stuck promise

**File/line:** `src/plugin.ts:150-180`

```ts
return new Promise<number>(resolve => {
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if ((record.target as HTMLElement).classList?.contains('sticky-headings-shadow-item')) {
        observer.disconnect();
        resolve(target.clientHeight || 0);
      }
    }
  });
  observer.observe(target, { subtree: true, childList: true });
  item.headingEl.predictHeadingsHeight(item.getExpectedHeadings(index));
});
```

**Risk:** The promise only resolves when a mutation adds a `.sticky-headings-shadow-item`. On mobile, if the shadow container is in a lazily-created/detached subtree, the mutation may never fire, leaving the promise pending forever. `showSuggester` (line 136) `await`s this before scrolling, so **heading navigation from the status bar can hang indefinitely on mobile**. There is no timeout.

**Why it matters:** A permanently-pending promise means the "Quick Navigate Headings" command and status-bar navigation silently do nothing on mobile.

**Fix:** Add a timeout (e.g. `setTimeout` that resolves with `0` after ~200ms) and also resolve immediately if `target.clientHeight > 0` before observing. Disconnect the observer on timeout.
**Test:** Unit-test that `predictHeadingsHeight` resolves (with `0`) within a bounded time when no mutation occurs.

---

### 6. `getHeadingsWithOffsetPreview` falls back to fake offsets when `sections` is missing

**File/line:** `src/utils/getShownHeadings.ts:16-26`

```ts
const sections = view?.previewMode?.renderer?.sections;
if (!sections) {
  return headings.map((heading, index) => ({
    ...heading,
    offset: index * 32 - boundaryOffset,   // <-- fake offsets
    ...
  }));
}
```

**Risk:** `view.previewMode.renderer.sections` is an internal field that is often unavailable on mobile (lazy renderer) or before the preview has rendered. The fallback fabricates `offset = index * 32`, which is unrelated to real document positions. Combined with finding #2, this produces a sticky header that highlights the wrong heading and scrolls to the wrong place.

**Why it matters:** On mobile, offsets are wrong → wrong heading shown as "current" and wrong scroll target on click.

**Fix:** When `sections` is unavailable, compute offsets from the actual DOM (e.g. `getBoundingClientRect` of each heading element) or return an empty list and retry on the next `layout-change`/`resolve` event rather than fabricating offsets.
**Test:** Test that when `sections` is missing, the function does not return fabricated `index * 32` offsets; assert it returns real DOM-derived offsets or an empty array.

---

### 7. `getHeadingsWithOffsetSource` uses `lineBlockAt` which may be undefined on mobile

**File/line:** `src/utils/getShownHeadings.ts:56-58`

```ts
const lineBlock = view?.editor?.cm?.lineBlockAt?.(position.start.offset);
const { top = 0 } = lineBlock ?? { top: 0 };
```

**Risk:** `view.editor.cm` may be `undefined` on mobile (see finding #1). The optional chaining prevents a crash, but then `lineBlock` is `undefined` and `top` defaults to `0` for **every** heading. All headings get offset `0 + containerEl.offsetTop - boundaryOffset`, so the "in view" filter (`offset < scrollTop + stuckHeaderHeight`) treats every heading as in view at the top → the wrong heading is shown.

**Why it matters:** In edit/source mode on mobile, the sticky header shows the wrong heading because all offsets collapse to the same value.

**Fix:** If `view.editor.cm` is unavailable, fall back to measuring heading positions from the DOM (e.g. `view.editor.cm` → `view.editMode.containerEl.querySelectorAll('.cm-line')` and compute `offsetTop`), or skip the update and retry.
**Test:** Test with a mock view where `editor.cm` is `undefined`; assert offsets are not all identical (or that the function returns an empty list rather than degenerate offsets).

---

### 8. `animateScroll` writes `scrollTop` directly — no touch/pointer handling, no `scrollTo` fallback

**File/line:** `src/utils/scroll.ts:1-31`

```ts
const scrollTop = target.scrollTop + (to - target.scrollTop) * ease;
target.scrollTop = scrollTop;
```

**Risk:** (a) Setting `scrollTop` directly on a CodeMirror `scrollDOM` works on desktop but can fight the mobile editor's own scroll handling / momentum; (b) there is no `behavior` handling and no fallback to `target.scrollTo({ top, behavior })`; (c) `requestAnimationFrame` on a slow mobile device with a long 1000ms duration can drop frames and feel janky; (d) if `target` is `null` (from finding #1), `target.scrollTop` throws — though callers guard with `if (!scroller) return` in `showSuggester` (line 138) and `if (!scrollerSource) return` in `StickyHeader.svelte` (line 42).

**Why it matters:** Smooth-scroll navigation can be janky or non-functional on mobile, and the direct `scrollTop` write bypasses the editor's scroll normalization.

**Fix:** Prefer `target.scrollTo({ top, behavior: 'smooth' })` when available, and only fall back to the rAF loop when `scrollTo` is unsupported. Add a guard for `target` being null. Consider reducing the default duration on mobile.
**Test:** Unit-test that `animateScroll` calls `scrollTo` when available and falls back to the rAF loop otherwise; test that it no-ops (does not throw) when `target` is null.

---

### 9. `getContainerEl` assumes a `.markdown-reading-view` / `.markdown-source-view` ancestor

**File/line:** `src/utils/obsidian.ts:51-52`

```ts
export const getContainerEl = el =>
  el.closest('.markdown-reading-view, .markdown-source-view')?.querySelector('.sticky-headings-root');
```

**Risk:** On mobile, the view wrapper classes can differ (e.g. `.markdown-preview-view` inside a different container, or the reading view not having `.markdown-reading-view` on the same ancestor). If `closest` returns `null`, `stuckHeaderHeight` in `setHeadingsInView` (line 289) becomes `0`, so the "in view" boundary is wrong and the header may not stick at the correct offset.

**Why it matters:** Wrong sticky boundary → header overlaps content or doesn't stick on mobile.

**Fix:** Make the selector more robust (also match `.markdown-preview-view`, `.cm-editor`, `.view-content`) or fall back to `document.querySelector('.sticky-headings-root')` scoped to the view.
**Test:** Test `getContainerEl` with a mock DOM that lacks `.markdown-reading-view` but has `.markdown-preview-view`; assert it still finds the root.

---

### 10. `parseMarkdown` uses `getActiveViewOfType` — wrong view on mobile with multiple panes

**File/line:** `src/utils/obsidian.ts:16-28`

```ts
const activeView = app.workspace.getActiveViewOfType(MarkdownView);
...
return MarkdownRenderer.render(app, '# ' + markdown, div, '', activeView)...
```

**Risk:** `getActiveViewOfType` returns the _currently active_ view, not necessarily the view being processed. In `retrieveHeadings` (plugin.ts:417-443), titles are parsed for a specific `view`, but `parseMarkdown` ignores that view and uses the active one. On mobile with split panes or when the active leaf differs from the one being updated, titles render with the wrong context (or fail if no active markdown view). This is a correctness bug that's more likely to surface on mobile where the active view can change rapidly.

**Why it matters:** Wrong/empty heading titles in the sticky header on mobile.

**Fix:** Pass the target `view` into `parseMarkdown` and use it instead of `getActiveViewOfType`.
**Test:** Test `parseMarkdown` with an explicit view argument; assert it uses that view, not the active one.

---

### 11. `styles.css` only sets `.view-content { position: relative }` — no mobile-specific layout

**File/line:** `styles.css:48-50`

```css
.view-content {
  position: relative;
}
```

**Risk:** The sticky overlay uses `position: absolute; top: 0` (StickyHeader.svelte:147-156) and relies on `.view-content` being the positioning context. On mobile, the reading view's scroll container may be a different element (`.markdown-preview-view`), so the absolute overlay can be positioned relative to the wrong ancestor or not stick at all. There is no `@media` handling for narrow screens, and the `float` theme uses `padding: 10px 20%` (line 245) which is hostile on a phone-width viewport (20% of a 360px screen = 72px each side, leaving ~216px for content).

**Why it matters:** Overlay positioning and the float theme are broken/ugly on mobile.

**Fix:** Add mobile media queries (e.g. `@media (max-width: 600px)`) to reduce float padding, and ensure the positioning context is set on the actual mobile scroll container (`.markdown-preview-view`, `.cm-editor`).
**Test:** Visual test on a narrow viewport; assert the overlay stays within the viewport and the float theme doesn't overflow.

---

### 12. `detectPosition` requires `.view-content` ancestor — silently skips on mobile

**File/line:** `src/plugin.ts:36-48`

```ts
const container = target?.closest('.view-content');
if (container) {
  this.setHeadingsInView(scroller, item);
}
```

**Risk:** If the scroll event's `target` is not inside `.view-content` (which can happen on mobile where the scroller is `.cm-scroller` or `.markdown-preview-view` and the event target is a child of a different wrapper), the update is silently skipped. Combined with finding #3, this means scroll tracking can be entirely dead on mobile.

**Why it matters:** Sticky header never updates on scroll on mobile.

**Fix:** Remove the `.view-content` gate or broaden it to also accept `.cm-scroller`, `.markdown-preview-view`, and the scroller itself. Alternatively, call `setHeadingsInView` directly from the scroll listener without the `closest` check.
**Test:** Test `detectPosition` with a target that is a `.cm-scroller` child (no `.view-content` ancestor); assert the update still runs.

---

### 13. `handleComponentUpdate` re-runs `retrieveHeadings` (async, parseMarkdown) on every layout change

**File/line:** `src/plugin.ts:235-284`

```ts
const headings = await this.retrieveHeadings(item.file, view);
item.headings = headings;
item.getExpectedHeadings = makeExpectedHeadings(headings, ...);
```

**Risk:** `retrieveHeadings` calls `getShownHeadings` (which reads `sections`/`lineBlockAt`) and `parseMarkdown` (which calls `MarkdownRenderer.render`) for every heading. On mobile, `layout-change` fires frequently (keyboard open/close, pane resize, orientation change), and each invocation re-renders markdown for every heading. This is heavy on a slow device and can cause visible jank/flicker — the exact problem this plugin is named for.

**Why it matters:** Performance on slower mobile devices; repeated markdown rendering on every layout change.

**Fix:** Cache parsed titles (already partially done via `markdownCache` in `retrieveHeadings`, but `getShownHeadings` offsets are recomputed every time). Debounce `handleComponentUpdate` and skip re-parsing titles when the file hasn't changed (only recompute offsets).
**Test:** Add a test that `handleComponentUpdate` does not re-parse titles when the file content is unchanged.

---

### 14. `onload` uses `setTimeout(..., 100)` for `active-leaf-change` — race on slow mobile

**File/line:** `src/plugin.ts:66-73`

```ts
this.app.workspace.on('active-leaf-change', () => {
  setTimeout(() => {
    this.checkFileResolveMap();
  }, 100);
});
```

**Risk:** The hardcoded 100ms delay assumes the editor mounts within 100ms. On a slow mobile device, `cm.editor` may not be ready in 100ms, so `getScroller` returns `null` and the scroll listener is never attached (finding #1). The comment even says "timeout to wait for cm.editor to load" — a fixed timeout is fragile on mobile.

**Why it matters:** On slow devices, the sticky header may never initialize because the editor isn't ready when the timeout fires.

**Fix:** Instead of a fixed timeout, retry until `getScroller(view)` returns a non-null value (with a bounded number of attempts), or hook into `layout-change`/`editor` ready events.
**Test:** Test that initialization retries when the editor is not ready at 100ms.

---

## Summary of highest-priority fixes

1. **#1 + #3 + #12** — `getScroller` returns null on mobile edit mode, listener attached to wrong element, and `.view-content` gate skips updates → scroll tracking dead on mobile. Fix the scroller fallback chain and attach the listener to the real scroller.
2. **#4** — Dual Svelte mount can throw/mount into detached nodes and double-renders on mobile. Guard targets and only `$set` mounted components.
3. **#5** — `predictHeadingsHeight` promise can hang forever on mobile. Add a timeout.
4. **#2 + #6 + #7** — Fallback paths compute against the wrong element or fabricate offsets → wrong heading shown. Fix fallbacks to use real DOM measurements or bail.
5. **#11** — No mobile CSS; float theme hostile on narrow screens.
