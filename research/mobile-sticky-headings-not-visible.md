# Research: Sticky Headings Not Visible on Mobile (after null-guard changes)

**Date:** 2026-08-15
**Plugin:** `sticky-headings-no-flicker` v2.1.3
**Scope:** Research only — no files modified.
**Symptom:** Plugin loads on mobile, but the sticky headings bar never appears (in reading/preview mode, the mobile default).

---

## TL;DR — Root cause

The sticky header is **mounted** on mobile, but it is **never fed any headings**, so the Svelte `{#if (forceRenderingHeadings || headings).length > 0}` guard (StickyHeader.svelte:70) stays false and the whole bar (including the shadow) is not rendered.

The single gatekeeper that decides whether headings ever reach the component is **`getScroller(view)`**:

- `src/utils/obsidian.ts:41-46` — in preview mode it returns `view?.previewMode?.renderer?.previewEl ?? null`.
- `view.previewMode.renderer` is an **undocumented internal** that is not guaranteed to exist on mobile (and `previewEl` is not necessarily the reading-view scroll container on mobile).
- When it returns `null`, **both** `handleComponentUpdate` (plugin.ts:260) and `updateHeadings` (plugin.ts:224-229) take the `else` branch and **never call `setHeadingsInView`**.
- `setHeadingsInView` is the **only** place that calls `item.headingEl.updateHeadings(...)` (plugin.ts:323). Without it, the Svelte `headings` prop stays `[]` → nothing renders.

So: **the null guards didn't "break" a working path — they converted a would-be crash into a silent no-op.** Before the guards, if `renderer.previewEl` was missing, `getScroller` would throw and the whole update would fail loudly. Now it returns `null` and the pipeline silently short-circuits. Either way the headings never render; the guards just made it quieter.

---

## Full trace — mobile reading/preview mode

Mobile default view is **reading (preview) mode**, so `isEditMode(view)` is `false` (obsidian.ts:38-39, because `currentMode.type === 'preview'`).

### 1. `onload()` → `checkFileResolveMap()` → `initStickyHeaderComponent(view)` (plugin.ts:182)

- `view.previewMode.containerEl` **is** public API and exists on mobile → the preview Svelte component **does mount** (stickyHeader.ts:45-60). ✓
- `view.editMode.editorEl` is null in preview → guarded, no source component. ✓
- `retrieveHeadings` → `getShownHeadings` → `getHeadingsWithOffsetPreview` (getShownHeadings.ts:7-41):
  - `view?.previewMode?.renderer?.sections` — if missing, **fallback returns `offset: -boundaryOffset` for every heading** (getShownHeadings.ts:18-25). With default `boundaryOffset: '0px'` → `getBoundaryOffset` returns `0` → **all offsets = 0**.

### 2. `handleComponentUpdate(view)` (plugin.ts:233)

- `const scroller = getScroller(view);` → **`null` on mobile if `renderer.previewEl` is missing.**
- `if (scroller) { ... } else { item.scrollListener = null; }` (plugin.ts:260-277) → **else branch: no scroll listener, no `setHeadingsInView`.**
- `this.updateHeadings(item.file, item.view, item)` (plugin.ts:278) → `updateHeadings` (plugin.ts:223):
  - `const scroller = getScroller(view);` → **`null` again.**
  - `if (scroller) { this.setHeadingsInView(...) } else { this.statusBarItemEl?.hide(); }` (plugin.ts:224-229) → **else branch: `setHeadingsInView` never runs.**

### 3. Result

- `item.headingEl.updateHeadings(...)` is **never called** → Svelte `headings` stays `[]`.
- `StickyHeader.svelte:70` `{#if (forceRenderingHeadings || headings).length > 0}` → **false** → nothing renders.
- Even the `.sticky-headings-shadow` (StickyHeader.svelte:119) is inside the same `{#if settings.mode !== 'disable'}` block but the shadow is gated by the same outer `{#if}`? No — the shadow is a sibling, but it's inside `{#if settings.mode !== 'disable'}` only, so the shadow WOULD render. However the shadow has `opacity: 0 !important` (StickyHeader.svelte:137), so it's invisible anyway. The visible bar is gated by the `headings.length > 0` check.

---

## Secondary contributors (make it worse, but not the root cause)

### A. `stuckHeaderHeight = 0` + `scrollTop = 0` edge case (plugin.ts:286-315)

Even if `getScroller` returned a valid element, `setHeadingsInView` does:

```js
const stuckHeaderHeight = getContainerEl(scroller)?.clientHeight || 0;  // plugin.ts:287
const headingsInView = headings.filter(h => h.offset < scrollTop + stuckHeaderHeight);  // plugin.ts:315
```

- `getContainerEl` (obsidian.ts:48-49) looks for `.sticky-headings-root` inside `scroller.closest('.markdown-reading-view, .markdown-source-view')`. If `scroller` is `renderer.previewEl` and that element is **not** a descendant of `.markdown-reading-view` (or the root isn't found), `getContainerEl` returns `null` → `stuckHeaderHeight = 0`.
- With all fallback offsets = 0 and `scrollTop = 0` (top of page, where you are on first open): `0 < 0` is **false** → `headingsInView` is **empty** → `findalHeadings` empty → `updateHeadings([])` → nothing renders **until the user scrolls**.
- When the user does scroll, all headings have offset 0, so **all** are "in view" → the bar shows the wrong (top-level) heading set. So even a "working" scroller produces wrong behavior with the fallback offsets.

### B. Fallback offsets of 0 (getShownHeadings.ts:18-25)

`offset: -boundaryOffset` (= 0) for every heading when `sections` is missing. This is a degenerate value that breaks the `offset < scrollTop + stuckHeaderHeight` filter (see A). It should not be used as a "safe" fallback — it makes every heading appear at the same position.

### C. CSS positioning (styles.css:48-50, StickyHeader.svelte:147-156)

`.sticky-headings-root` is `position: absolute; top: 0; z-index: 1;` and relies on `.view-content { position: relative; }`. On mobile the reading view's stacking/scroll context can differ (top bar, safe-area insets, `--sticky-header-verticle-offset`). This is a **secondary** issue — it only matters once the component actually renders. If the component renders but is positioned off-screen or behind the top bar, this is the cause; but the primary symptom (nothing at all) points to the `{#if}` guard, not CSS.

---

## Prioritized fixes (do NOT modify files in this task — proposals only)

### Fix 1 (HIGHEST IMPACT) — Make `getScroller` robust for preview mode
`src/utils/obsidian.ts:41-46`

Fall back to a reliable scroll container when `renderer.previewEl` is missing. On mobile the reading-view scroll container is typically `view.previewMode.containerEl` (the `.markdown-preview-view` element) or `.view-content`.

```ts
export const getScroller = (view: MarkdownView): HTMLElement | null => {
  if (isEditMode(view)) {
    return view?.editor?.cm?.scrollDOM ?? null;
  }
  // preview mode
  return (
    view?.previewMode?.renderer?.previewEl ??
    view?.previewMode?.containerEl ??          // <-- reliable public API fallback
    view?.contentEl?.querySelector('.markdown-preview-view') ??
    null
  );
};
```

This alone should restore the update pipeline on mobile: `setHeadingsInView` will run, headings will reach the Svelte component, and the `{#if}` guard will pass.

### Fix 2 — Don't gate the whole update on `getScroller`
`src/plugin.ts:223-231` (`updateHeadings`) and `src/plugin.ts:260-277` (`handleComponentUpdate`)

If `getScroller` returns null, still attempt to render headings rather than silently hiding the status bar and skipping `setHeadingsInView`. Options:
- Call `setHeadingsInView` with a fallback element (e.g. `view.contentEl`) when `scroller` is null, so the component at least receives headings.
- Or, in `updateHeadings`, always call `item.headingEl.updateHeadings(...)` even when `scroller` is null (the Svelte component can render with whatever headings it has).

### Fix 3 — Fix the `stuckHeaderHeight = 0` / `scrollTop = 0` edge case
`src/plugin.ts:286-315`

When `stuckHeaderHeight` is 0 (root not found), don't filter out every heading at `scrollTop = 0`. Guard the filter so at least the first heading is always included:

```js
const stuckHeaderHeight = getContainerEl(scroller)?.clientHeight || 0;
const headingsInView = headings.filter(h => h.offset < scrollTop + stuckHeaderHeight);
// if nothing is "in view" but we're at the top, include the first heading
const effective = headingsInView.length ? headingsInView : (scrollTop <= 0 ? [headings[0]] : headingsInView);
```

### Fix 4 — Make the preview offset fallback non-degenerate
`src/utils/getShownHeadings.ts:18-25`

Instead of `offset: -boundaryOffset` (= 0) for every heading when `sections` is missing, compute a monotonic fallback (e.g. `index * someStep`) or return `[]` and let the caller handle it. A flat `0` for all headings breaks the `offset < scrollTop + stuckHeaderHeight` filter (all or none).

### Fix 5 — Verify CSS on mobile (only after Fix 1-4)
`styles.css:48-50`, `StickyHeader.svelte:147-156`

Once the component renders, confirm `.sticky-headings-root` is visible on mobile:
- Ensure `.view-content { position: relative; }` applies to the mobile reading view (it may need `.markdown-preview-view` too).
- Check `--sticky-header-verticle-offset` (default 0) doesn't push the bar under the mobile top bar.
- Check `z-index: 1` isn't below the mobile top bar / safe-area overlay.

---

## How to confirm on mobile (console logs)

The plugin already logs `console.debug('mounted svelte component')` (StickyHeader.svelte:25) and `console.warn(...)` on failures. To confirm the diagnosis, capture mobile console output:

### Android
1. Enable Developer Options → USB debugging on the phone.
2. Connect via USB, open `chrome://inspect/#devices` in desktop Chrome.
3. Select the Obsidian WebView → read the console.
4. Look for: `mounted svelte component` (confirms mount) and any `Failed to ...` warnings.

### iOS (iOS 16.4+)
1. Settings → Safari → Advanced → enable "Web Inspector".
2. Connect via USB, open Safari → Develop → select the Obsidian WebView.
3. Read the console.

### Quick in-app check (no cable)
Add a temporary `console.log` in `getScroller` (obsidian.ts:41) and in `handleComponentUpdate` (plugin.ts:260) logging the scroller value, then open a note in reading mode on mobile. If `getScroller` logs `null`, the diagnosis is confirmed.

**Expected observations if diagnosis is correct:**
- `mounted svelte component` appears (component mounts).
- `getScroller` returns `null` in preview mode.
- No `updateHeadings` calls reach the Svelte component (headings stay `[]`).

---

## Sources / references

- Original plugin (zhouhua/obsidian-sticky-headings) — same `getScroller`/`renderer.previewEl` pattern, but no null guards: https://github.com/zhouhua/obsidian-sticky-headings
- Obsidian API types (`node_modules/obsidian/obsidian.d.ts`): `MarkdownPreviewView.containerEl` is public; `renderer`/`previewEl`/`sections` are **not** in the public API.
- Prior research: `research/mobile-plugin-load-failure-causes.md` (internal-API timing fragility on mobile).
- Prior research: `research/flickering-headings-fix.md` (offset recompute + equality-guard architecture).
