# Consolidated Audit — obsidian-sticky-headings-no-flicker

**Date:** 2026-08-17
**Scope:** All files under `src/`, `styles.css`, `package.json`, `manifest.json`
**Plugin:** Sticky Headings (No Flicker) v2.1.3, `isDesktopOnly: false` (mobile-enabled)
**Method:** Static source review. Findings cross-referenced against the existing `research/*.md` audits and `learning-log.md`.

---

## Executive summary

The plugin has a correct high-level architecture (fast scroll path with cached titles + a content-equality guard in `StickyHeaderComponent.updateHeadings` that prevents Svelte `$set` storms). However it contains **one outright broken feature** (heading click / quick-navigation never scrolls because a `MutationObserver` promise never resolves), **several mobile scroll-container failures**, and **layout-thrash / compositing cost on the scroll path**. The most expensive thing on every 50 ms scroll tick is a synchronous, per-heading DOM/layout read loop.

Sorted by severity: 1 critical, 4 high, 8 medium, 5 low.

---

## 1. Core logic bugs / correctness

### CRITICAL — `predictHeadingsHeight` promise never resolves; click-navigation dead on arrival

**Files:** `src/plugin.ts:150-180`

```ts
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
```

**Bug:** When Svelte re-renders the shadow `{#each expectedHeadings}` (in `StickyHeader.svelte:126-131`), the `childList` mutation record's `record.target` is the **parent container** (`.sticky-headings-container`), _not_ the newly-added `.sticky-headings-shadow-item`. The check `record.target.classList.contains('sticky-headings-shadow-item')` therefore almost never matches (a shadow-item only becomes a `record.target` if _it_ later gains children — which the initial add does not produce).

**Why it matters:** `predictHeadingsHeight` returns a `Promise` that **never resolves**. In `showSuggester` (`plugin.ts:135-143`) the `await this.predictHeadingsHeight(index)` hangs, so **the quick-navigate modal closes but nothing scrolls**. The `MutationObserver` is never `disconnect()`ed → it keeps observing the shadow subtree forever (memory + CPU leak that fires on every subsequent shadow re-render).

**Fix:** Resolve based on `record.addedNodes` (or any childList mutation of the shadow), not on `record.target`:

```ts
const observer = new MutationObserver(records => {
  for (const record of records) {
    const added = Array.from(record.addedNodes as NodeList);
    if (added.some(n => n instanceof HTMLElement && n.classList.contains('sticky-headings-shadow-item'))) {
      observer.disconnect();
      resolve(target.clientHeight || 0);
    }
  }
});
```

Better still, avoid the observer entirely: Svelte's `tick()` (await `import { tick } from 'svelte'`) after `$set({ expectedHeadings })` guarantees the DOM is updated, then read `target.clientHeight`. That removes the magic timing _and_ the leak.

### HIGH — `getExpectedHeadings` closure vs `item.headings` desync (stale expected-headings)

**Files:** `src/plugin.ts:193-200, 307-315`; `src/utils/makeExpectedHeadings.ts:4-21`; `src/stickyHeader.ts:85-92`

**Bug:** `item.getExpectedHeadings` is created **once** (init / layout-change / resolve) and captures the _array reference_ passed to `makeExpectedHeadings`. But `setHeadingsInView` replaces `item.headings` with a **new array** on every scroll tick (`plugin.ts:315`), without updating the closure. So `item.getExpectedHeadings(index)` keeps reading the **original init-time array** — which may carry stale titles/offsets after a content edit, even though the visible bar shows fresh ones.

**Why it matters:** The equality guard in `StickyHeaderComponent.updateHeadings` (`stickyHeader.ts:85-92`) deliberately relies on a stable `getExpectedHeadings` reference (per `learning-log.md`) — recreating the closure on each scroll tick would reintroduce flicker. But the result is that the _expected-headings preview_ (the shadow shown when clicking a heading) is computed from a desynced array. Titles are mostly masked by the `titleMap` cache, but offsets and heading membership can be stale after content changes.

**Fix:** Make `makeExpectedHeadings` read headings _lazily_ instead of capturing the array — e.g. `(index) => trivial(item.headings.slice(0, index), ...)`, or expose a getter on `FileResolveEntry` (`getHeadings: () => this.headings`) so the closure always sees the current array while keeping reference stability.

### HIGH — `handleResolve` async races / last-writer-wins

**Files:** `src/plugin.ts:356-375`

**Bug:** `handleResolve` is `async` and calls `await this.retrieveHeadings(...)` per matching leaf inside a `for...of` loop, mutating shared `item.headings`/`item.getExpectedHeadings` without cancellation or ordering. Rapid edits / multi-pane files can interleave resolves; the last promise to settle wins, which may not correspond to the newest content.

**Why it matters:** Stale titles/offsets can briefly render after a keystroke until the next resolve; on a busy vault this can manifest as the sticky bar showing an outdated heading.

**Fix:** Track a per-leaf revision counter and ignore stale resolves (`if (revision !== this.revOf(id)) return;`), or coalesce resolves with a microtask/`requestIdleCallback`.

### MEDIUM — `scrollTo` smooth-mode animation race; no cancellation of prior animation

**Files:** `src/ui/StickyHeader.svelte:40-60`; `src/utils/scroll.ts:1-31`

**Bug:** `animateScroll` returns a cancel function (`scroll.ts:28-30`), but `scrollTo` **ignores it**. If the user clicks heading A then quickly heading B, two `requestAnimationFrame` loops run concurrently on the same scroller, each computing `target.scrollTop + (to - target.scrollTop) * ease` — they fight each other. Also `forceRenderingHeadings` is a **single shared variable**; the second click overwrites it, and the _first_ animation's `onComplete` then sets `headings = forceRenderingHeadings` from the second click's value.

**Why it matters:** Jerky/broken scroll on rapid clicks, and the "suppress scroll flicker" mechanism can show the wrong heading set when animations interleave.

**Fix:** Keep a reference to the current animation's cancel fn (e.g. `this.activeScroll?.()` then `this.activeScroll = animateScroll(...)`) and cancel before starting a new one. Snapshot `forceRenderingHeadings` per-invocation rather than sharing one variable.

### MEDIUM — `predictHeadingsHeight` hardcoded `delay(20)` depends on render flush timing

**Files:** `src/ui/StickyHeader.svelte:32-38`

```ts
const calculateExpectedHeight = async (index: number) => {
  expectedHeadings = getExpectedHeadings(index);
  await delay(20); // fixme: Is there a better way ... after Shadow has rendered?
  return shadow?.clientHeight || 0;
};
```

**Bug:** The code relies on Svelte's async render having flushed within 20 ms. On a slow machine or with many expected headings, 20 ms can be insufficient → `clientHeight` returns the stale/old value → the scroll target (`heading.offset - expectedHeight`) is wrong and the heading lands hidden under the sticky bar. The `fixme` comments acknowledge this is a hack. Use `await tick()` from Svelte instead of `delay(20)`.

### LOW — `handleScrollClick` vs `showSuggester` use inconsistent scroll math

**Files:** `src/ui/StickyHeader.svelte:62-66` vs `src/plugin.ts:135-143`

**Bug:** Click path: `top = heading.offset - expectedHeight` (no extra margin). Suggester path: `top = offset - height - 4`. Two code paths compute the destination slightly differently → the heading lands at different visual positions depending on how you navigate.

**Fix:** Unify the math (single helper that subtracts the sticky-bar height + a small margin).

### LOW — `filename` captured once, stale after rename

**Files:** `src/ui/StickyHeader.svelte:21`

```ts
const filename = view.getFile()?.basename;
```

**Bug:** Captured at component construction. A file rename that does not trigger a layout-change/component re-init leaves the stale filename shown in the sticky bar.

**Fix:** Read `view.getFile()?.basename` reactively (e.g. recompute in `$:` on a `view`/`file` prop change).

### LOW — cross-leaf shared lodash throttle coalescing

**Files:** `src/plugin.ts:36-48`

**Bug:** `detectPosition` is a single plugin-level throttled function shared by all leaves. lodash throttle's trailing call uses the **last** invocation's args. Scrolling leaf A then leaf B within the 50 ms window can apply B's item/scroller to A's trailing update, or drop A's update.

**Why it matters:** Cross-pane scroll position can momentarily be misattributed to the wrong file's sticky header.

**Fix:** Make the throttle per-leaf (store a throttled fn on `FileResolveEntry`) or key the throttled call by leaf id.

---

## 2. Mobile / desktop compatibility

### HIGH — scroll container detection fails on mobile; sticky bar stuck at first heading

**Files:** `src/utils/obsidian.ts:41-49`; `src/plugin.ts:228-231, 286-288, 262-279`

```ts
export const getScroller = view =>
  isEditMode(view)
    ? (view?.editor?.cm?.scrollDOM ?? null)
    : (view?.previewMode?.containerEl ?? view?.previewMode?.renderer?.previewEl ?? null);
```

and the fallback in `updateHeadings` / `handleComponentUpdate`:

```ts
this.setHeadingsInView(item.view.contentEl, item);
```

**Bug:** On Obsidian **mobile**, the actual scrolling container is frequently an _outer_ element (`.workspace-leaf-content` / body), while `previewMode.containerEl` and `view.contentEl` may never scroll — their `scrollTop` stays `0`. The plugin then reads `const { scrollTop } = scroller` (`plugin.ts:288`) and filters `heading.offset < 0 + stuckHeaderHeight` → the sticky bar is permanently stuck showing the first heading and never advances. The `contentEl` fallback in `updateHeadings` (`plugin.ts:230`) is the same non-scrolling element.

**Why it matters:** The plugin advertises `isDesktopOnly: false`; on mobile reading mode the core feature silently degrades.

**Fix:** Resolve the real scroll container by walking up from the view: find the first ancestor with `scrollTop` capability (`el.scrollTop > 0` on scroll, or `overflow-y: auto/scroll` / `scrollHeight > clientHeight`), and read scroll position from that element. Add a `scroll` listener on the actual scroller, not just `contentEl`.

### HIGH — `addStickyHeader` mounts Svelte components with no null guard on targets

**Files:** `src/stickyHeader.ts:41-68`

```ts
const previewContentEl = view.previewMode.containerEl;
const sourceContentEl = view.editMode.editorEl;
this.stickyHeaderComponents = [
  new StickyHeader({ target: previewContentEl, ... }),
  new StickyHeader({ target: sourceContentEl, ... }),
];
```

**Bug:** The comment claims "Mobile views may lazily create these containers," but there is **no null check** before `new StickyHeader({ target: ... })`. Svelte throws `target must be a DOM element` if either element is `null`. If Obsidian mobile ever yields a `null` `editorEl` in reading mode (or a lazy DOM container not yet attached), the whole `onload` / `initStickyHeaderComponent` path can crash.

**Why it matters:** Mobile + reading mode is exactly the lazy-DOM case; a crash here prevents the plugin from loading.

**Fix:** Guard before mounting:

```ts
const previewEl = view.previewMode.containerEl;
const sourceEl = view.editMode.editorEl;
const targets = [previewEl, sourceEl].filter(Boolean) as HTMLElement[];
this.stickyHeaderComponents = targets.map(target => new StickyHeader({ target, props: {...} }));
```

and only mount the component for the _current_ mode (desktop perf win too).

### MEDIUM — `getHeadingsWithOffsetPreview` fabricates offsets when `sections` is missing

**Files:** `src/utils/getShownHeadings.ts:16-26`

```ts
const sections = view?.previewMode?.renderer?.sections;
if (!sections) {
  return headings.map((heading, index) => ({
    ...heading,
    offset: index * 32 - boundaryOffset,   // fabricated
    ...
  }));
}
```

**Bug:** Relies on the **internal** `previewMode.renderer.sections` API (declared via `@ts-expect-error` in `types.d.ts`). When it's absent (mobile lazy render, plugin/theme interference, Obsidian version change), it substitutes a flat `index * 32` offset that has no relation to real document geometry — the sticky bar will highlight the wrong heading.

**Why it matters:** Silent wrong behavior exactly when the internal API is unavailable (mobile, future Obsidian updates).

**Fix:** Fall back to reading real heading positions (e.g. `querySelector` the rendered `h1..h6` in the preview and measure `offsetTop`), or gate the feature off when no real offsets are available rather than fabricating them.

### MEDIUM — duplicate always-mounted components + always-rendered shadow per view

**Files:** `src/stickyHeader.ts:41-68`; `src/ui/StickyHeader.svelte:119-132`

**Bug:** Every markdown view always mounts **two** Svelte components (source + preview) and, when `mode !== 'disable'`, **both** render their `.sticky-headings-shadow` div into the DOM (even when it has zero items). `predictHeadingsHeight` broadcasts `$set({expectedHeadings})` to **both** components, so two shadows render the expected-heading list on every click.

**Why it matters:** 2× the DOM nodes and Svelte reconciliation work per view, plus an always-live (if empty) shadow subtree — wasteful on mobile and with many open panes.

**Fix:** Mount only the component for the current mode (re-create on mode switch), and/or gate the shadow render behind `expectedHeadings.length > 0`.

### LOW — `styles.css` overrides `.view-content` globally

**Files:** `styles.css:48-49`

```css
.view-content {
  position: relative;
}
```

**Bug:** This is a global override on an Obsidian core class, affecting every plugin/theme view, not just this plugin's. It can interact badly with other UI relying on `.view-content`'s default positioning (and on mobile, with scroll stacking contexts).

**Fix:** Scope to this plugin's own container (e.g. `.sticky-headings-root` ancestor) or add the class only to the target view.

---

## 3. Performance / smoothness / rendering

### HIGH — layout thrash / forced reflow on every 50 ms scroll tick

**Files:** `src/plugin.ts:286-315` (scroll path); `src/utils/getShownHeadings.ts:10-66`; `src/utils/obsidian.ts:68-76`

**Bug:** `setHeadingsInView` (fired by the throttled scroll handler every 50 ms) synchronously:

- reads `scroller.scrollTop` and `getContainerEl(scroller)?.clientHeight` (`plugin.ts:288-289`),
- calls `getHeadings` + `getShownHeadings` (`plugin.ts:292-299`),
- which for **each heading** calls `getBoundaryOffset` → `getScroller(view).clientHeight` (`obsidian.ts:72-73`, read **inside the `map`** at `getShownHeadings.ts:52-54`) and `view.editor.cm.lineBlockAt(position.start.offset)` + `containerEl.offsetTop` (`getShownHeadings.ts:52-58`).

Reading `clientHeight`/`offsetTop`/`lineBlockAt` interleaved with prior DOM writes (the `$set` from the previous tick) causes **forced synchronous layout** each tick. For long notes (hundreds of headings) this is O(n) layout reads × 20 ticks/sec.

**Why it matters:** This is the main source of scroll jank, and it partially defeats the "no-flicker" goal (fast path is still layout-heavy).

**Fix:**

1. Hoist `getBoundaryOffset` out of the per-heading `map` — compute it once per call (it only depends on `view` + `settings`).
2. Batch reads into a single pass before any writes; avoid re-reading `scroller.clientHeight` per heading.
3. Cache `lineBlockAt` positions between ticks and recompute only when a dirty flag changes, or use CM6's `cm.viewportLineBlocks` / `cm.getCursor`-style viewport-relative read once per tick rather than per heading.

### MEDIUM — `backdrop-filter: blur(12px)` + two gradient pseudo-elements on the blur theme

**Files:** `src/ui/StickyHeader.svelte:212-242`

**Bug:** The `theme-blur` style applies `backdrop-filter: blur(12px)` **plus** a `background: linear-gradient(... transparent)` plus two `::before`/`::after` full-size gradient layers (lines 219-242). `backdrop-filter` forces the compositor to re-sample the backdrop region every frame during scroll, and the three stacked gradient layers multiply paint cost. On low-end/mobile devices this drops frames.

**Why it matters:** The theme is a first-class option but is the most expensive rendering mode during the very action (scrolling) the plugin is always active in.

**Fix:** Keep blur radius modest and drop the redundant gradient pseudo-elements (the gradient is largely invisible under the blur), or precompute a single backdrop layer. Consider disabling the blur compositing while a scroll is actively animating.

### MEDIUM — `active-leaf-change` re-initializes every markdown leaf

**Files:** `src/plugin.ts:66-73, 378-415`

```ts
this.registerEvent(
  this.app.workspace.on('active-leaf-change', () => {
    setTimeout(() => {
      this.checkFileResolveMap();
    }, 100);
  })
);
// checkFileResolveMap -> iterateAllLeaves -> initStickyHeaderComponent(leaf.view) for EACH
```

**Bug:** Every leaf switch iterates **all** leaves and calls the async `initStickyHeaderComponent` on each markdown view (which calls `retrieveHeadings` and `handleComponentUpdate` → more heading recomputation). With several open panes this re-fetches and re-renders every view on every focus change. `metadataCache` `resolve` events then re-do much of the same per file.

**Why it matters:** Superfluous CPU/DOM churn when toggling between panes; a burst of `retrieveHeadings` (each potentially parsing uncached markdown titles) on every switch.

**Fix:** Only initialize the newly-activated leaf (track the previous leaf id); skip leaves already in `fileResolveMap` unless they're actually new or mode changed.

### MEDIUM — `markdownCache` keyed by raw heading text only; never invalidated; unbounded

**Files:** `src/plugin.ts:34, 424-435`

```ts
const cacheKey = heading.heading;             // raw text only — no file/path scope
if (cacheKey in this.markdownCache) { title = this.markdownCache[cacheKey]; }
else { title = await parseMarkdown(...); this.markdownCache[cacheKey] = title; }
```

**Bug:** (1) Key is just the heading text — two different files sharing `# Setup` collide (mostly benign for plain text, but wrong for wikilinks/embeds that resolve differently per file). (2) The cache is **never invalidated**: if a heading's markdown (e.g. a `[[link]]`) re-resolves to different content, the stale cached title persists for the session. (3) It grows unbounded for the session lifetime.

**Why it matters:** Stale rendered titles (correctness) and a growing memory footprint (long-lived desktop sessions).

**Fix:** Scope the key by file path (`${file.path}::${heading.heading}`), clear or `delete` the entry on `metadataCache` change for that file, and cap the cache size (LRU).

### MEDIUM — `onunload` does not destroy the status-bar Svelte component

**Files:** `src/plugin.ts:461-479`

**Bug:** `onunload` iterates `fileResolveMap` and destroys sticky header components, but `this.statusBarItemEl` (the `StatusBarItemComponent` Svelte instance) is never `$destroy()`ed. The `click` listener bound on `statusBarEl` (`plugin.ts:110`) is also never removed (the element is removed by Obsidian, but the component instance and its reactive subscriptions live on until GC).

**Why it matters:** Memory/event-subscription leak on plugin unload/reload during a session (a common Obsidian dev-loop and live-reload scenario).

**Fix:** In `onunload`, call `this.statusBarItemEl?.removeStickyHeader()` and `this.statusBarEl?.removeEventListener('click', ...)`.

### LOW — `getIcon(...)` recreated on every render

**Files:** `src/ui/StickyHeader.svelte:85, 109`

**Bug:** `getIcon('heading')` / `getIcon('heading-' + level)` builds a fresh SVG on each Svelte re-render (every `$set`). With the equality guard in place this is limited, but during scroll-driven updates it still allocates new nodes.

**Fix:** Cache the icon `outerHTML` strings (per level) at module/component init.

### LOW — duplicate heading computation in resolve/layout paths

**Files:** `src/plugin.ts:246-248, 280, 356-365`

**Bug:** `handleComponentUpdate` calls `retrieveHeadings` (which internally calls `getShownHeadings`) and then calls `updateHeadings` → `setHeadingsInView` (which calls `getShownHeadings` again). Same for `handleResolve`. The offset computation runs twice per event.

**Fix:** Have `retrieveHeadings` reuse the offsets already computed, or return both titles and offsets in one pass.

---

## Top 5 fixes (priority order)

1. **Fix `predictHeadingsHeight` promise** (`plugin.ts:161-175`) — resolve from `record.addedNodes` (or `await tick()`) instead of the never-true `record.target.classList` check. This unblocks heading-click / quick-navigate scrolling and removes a permanent `MutationObserver` leak. _(Critical, correctness)_

2. **Fix mobile scroll-container detection** (`obsidian.ts:41-49`, `plugin.ts:228-231`) — find the real scrollable ancestor and read scroll from it, instead of assuming `contentEl`/`previewMode.containerEl` scrolls. Without this the sticky bar is frozen on mobile. _(High, mobile)_

3. **Eliminate per-tick layout thrash** (`getShownHeadings.ts`, `plugin.ts:286-315`) — hoist `getBoundaryOffset`/`clientHeight` out of the per-heading loop, batch reads, and cache `lineBlockAt` positions. This is the main scroll-smoothness win. _(High, performance)_

4. **Guard + slim the Svelte mount** (`stickyHeader.ts:41-68`) — null-check the mount targets and mount only the component for the current mode (also cuts DOM in half). Prevents a mobile reading-mode crash and reduces per-view cost. _(High, mobile/perf)_

5. **Fix the smooth-scroll animation race** (`StickyHeader.svelte:40-60`) — cancel the prior `animateScroll` before starting a new one and stop sharing a single `forceRenderingHeadings`. Prevents jerky scroll on rapid heading clicks. _(Medium, correctness/smoothness)_

---

## Appendix — files & line anchors

| Finding                              | File                                          | Lines                    |
| ------------------------------------ | --------------------------------------------- | ------------------------ |
| predictHeadingsHeight never resolves | plugin.ts                                     | 150–180                  |
| getExpectedHeadings closure desync   | plugin.ts / makeExpectedHeadings.ts           | 193–200, 307–315 / 4–21  |
| handleResolve races                  | plugin.ts                                     | 356–375                  |
| scrollTo animation race              | StickyHeader.svelte / scroll.ts               | 40–60 / 1–31             |
| delay(20) fragile                    | StickyHeader.svelte                           | 32–38                    |
| scroll math inconsistency            | StickyHeader.svelte / plugin.ts               | 62–66 / 135–143          |
| stale filename                       | StickyHeader.svelte                           | 21                       |
| shared throttle                      | plugin.ts                                     | 36–48                    |
| mobile scroll container              | obsidian.ts / plugin.ts                       | 41–49 / 228–231, 262–279 |
| null mount targets                   | stickyHeader.ts                               | 41–68                    |
| fabricated offsets                   | getShownHeadings.ts                           | 16–26                    |
| duplicate components + shadow        | stickyHeader.ts / StickyHeader.svelte         | 43–68 / 119–132          |
| global .view-content override        | styles.css                                    | 48–49                    |
| layout thrash                        | plugin.ts / getShownHeadings.ts / obsidian.ts | 286–315 / 10–66 / 68–76  |
| backdrop-filter blur                 | StickyHeader.svelte                           | 212–242                  |
| active-leaf re-init all leaves       | plugin.ts                                     | 66–73, 378–415           |
| markdownCache key/invalidation       | plugin.ts                                     | 34, 424–435              |
| onunload status bar leak             | plugin.ts                                     | 461–479                  |
| getIcon per render                   | StickyHeader.svelte                           | 85, 109                  |
| duplicate heading compute            | plugin.ts                                     | 246–248, 280, 356–365    |

---

_Note: the critical `predictHeadingsHeight` and several mobile findings were validated against the code paths and existing `research/mobile-_.md`+`performance-rendering-audit.md`; no changes were made to the repo.\*
