# Performance & Rendering Audit — Sticky Headings (no-flicker)

Audit date: 2026-08-17
Scope: `src/plugin.ts`, `src/stickyHeader.ts`, `src/ui/StickyHeader.svelte`, `src/utils/*`, `styles.css`

Focus: scroll listener cost, throttle settings, layout thrashing, forced reflows, rAF misuse, re-render frequency, Svelte `$set` batching, DOM mutations, expensive markdown parsing, title cache correctness, flicker on jumps, hardcoded 20ms/80ms delays, MutationObserver cost, duplicated work across preview/source, CSS performance.

---

## 1. Scroll listener does full heading recompute + full Svelte re-render on every scroll tick

**File/line:** `src/plugin.ts:36-48` (throttle), `src/plugin.ts:286-344` (`setHeadingsInView`), `src/stickyHeader.ts:77-100` (`updateHeadings`)

**Problem:** The scroll handler is throttled to 50ms (leading+trailing), but every invocation runs the _entire_ pipeline synchronously on the main thread:

- `getHeadings()` (metadata cache read) — `plugin.ts:292`
- `getShownHeadings()` → for source mode calls `view.editor.cm.lineBlockAt()` per heading — `getShownHeadings.ts:56`
- builds a `Map` from all headings — `plugin.ts:306-309`
- `filter`, `trivial` recursion, `calcIndentLevels` — `plugin.ts:317-326`
- `updateHeadings()` → `headingsEqual()` then `$set` on **both** Svelte components — `stickyHeader.ts:97-99`

**Why it janks:** At 50ms throttle (20Hz) this is a full layout+render pass 20×/sec. `lineBlockAt()` forces CodeMirror to compute line geometry (a read that can trigger internal layout). The `$set` on both preview and source components re-renders the `{#each}` list even when only the _active_ heading changed. During fast scrolling this saturates the main thread and drops frames.

**Fix:**

- Raise throttle to ~100–150ms and use `{ leading: true, trailing: true }` (already set) but add a **dirty check**: only call `setHeadingsInView` when the computed "current heading index" actually changed. Cache `item.currentIndex` and skip the Svelte `$set` when unchanged (the `headingsEqual` guard in `stickyHeader.ts` already helps, but the expensive offset computation in `setHeadingsInView` runs _before_ that guard).
- Move the cheap "which heading is active" determination into the scroll handler and only do the expensive `getShownHeadings`/`lineBlockAt` recompute when the active heading index changes.

---

## 2. `getShownHeadings` recomputes offsets on every scroll — layout thrash in source mode

**File/line:** `src/utils/getShownHeadings.ts:43-78` (`getHeadingsWithOffsetSource`), called from `plugin.ts:299`

**Problem:** In source/live-preview mode, every scroll tick calls `view.editor.cm.lineBlockAt(position.start.offset)` for **every heading** in the file. `lineBlockAt` is a CodeMirror geometry query that reads the viewport/line layout.

**Why it janks:** This is a read of layout state that can force CodeMirror to recompute line positions, and it's repeated for N headings 20×/sec. It's pure layout-thrash: the offsets don't change while scrolling (only `scrollTop` changes), so recomputing them every tick is wasted work.

**Fix:** Compute heading offsets **once** per layout change (on `layout-change` / `metadataCache.resolve` / editor change), cache them in the `FileResolveEntry`, and in the scroll handler only read `scroller.scrollTop` and filter the cached offsets. Invalidate the cache only on actual layout/content changes, not on scroll.

---

## 3. `getBoundaryOffset` reads `scroller.clientHeight` on every heading computation

**File/line:** `src/utils/obsidian.ts:68-77`, called from `getShownHeadings.ts:13` and `:54`

**Problem:** When `boundaryOffset` is a percentage, `getBoundaryOffset` calls `getScroller(view)?.clientHeight` — a forced layout read — on **every** call, i.e. once per heading per scroll tick (it's inside the `headings.map` in source mode at `getShownHeadings.ts:54`).

**Why it janks:** `clientHeight` forces a synchronous layout flush. Doing it N times per scroll tick (once per heading) is a classic layout-thrash pattern.

**Fix:** Compute the boundary offset once per scroll tick (or cache it per layout change) and pass it in, rather than recomputing inside the per-heading map.

---

## 4. `parseMarkdown` runs full `MarkdownRenderer.render` per unique heading — expensive, and the cache is unbounded

**File/line:** `src/utils/obsidian.ts:16-28`, `src/plugin.ts:417-443` (`retrieveHeadings`), `src/plugin.ts:34` (`markdownCache`)

**Problem:** `retrieveHeadings` calls `parseMarkdown` for every heading not already in `this.markdownCache`. `parseMarkdown` creates a DOM div and runs Obsidian's full `MarkdownRenderer.render()` (a full markdown → HTML pipeline) just to get a title. The cache is a plain `Record<string,string>` keyed by raw heading text with **no eviction** — it grows forever across all files ever opened.

**Why it janks:** On first open of a large file, `retrieveHeadings` fires N async `MarkdownRenderer.render` calls (one per heading) — a burst of expensive work. The unbounded cache is a memory leak that grows with every unique heading string across the whole session.

**Fix:**

- Cache parsed titles **per file** (keyed by file path + heading) and evict when the file changes or the leaf closes.
- Consider a cheaper title renderer (strip markdown syntax with a regex/`marked`-lite) instead of full `MarkdownRenderer.render` for the common case, falling back to full render only when needed.

---

## 5. Title cache correctness bug — cache keyed only by heading text, not by file

**File/line:** `src/plugin.ts:424-436`

**Problem:** `cacheKey = heading.heading` (raw text only). Two different files with the same heading text (e.g. both have `# Introduction`) share the same cache entry. If one file uses markdown in the heading and the other doesn't, the wrong title is shown. Also, if a heading's markdown is edited, the stale cached title persists because the key never changes.

**Why it causes wrong rendering:** The sticky header can display a stale/incorrect title (flicker of wrong text, or a title that doesn't match the actual heading). This is a correctness bug, not just perf.

**Fix:** Key the cache by `file.path + '::' + heading.heading` (or better, by heading position/offset which is unique per file), and invalidate the entry for a file on `metadataCache.resolve`/editor change.

---

## 6. `retrieveHeadings` is called redundantly on every `handleComponentUpdate` and `handleResolve`

**File/line:** `src/plugin.ts:246` (`handleComponentUpdate`), `src/plugin.ts:362` (`handleResolve`), `src/plugin.ts:188` (`initStickyHeaderComponent`)

**Problem:** `handleComponentUpdate` (fired on every `layout-change`) calls `await this.retrieveHeadings(...)` which re-runs the full `getShownHeadings` + `parseMarkdown` pipeline. `handleResolve` (fired on every metadata resolve) does the same. `layout-change` fires frequently (pane resize, sidebar toggle, theme change, etc.).

**Why it janks:** Each layout-change triggers a full re-parse of all headings (including the expensive `MarkdownRenderer.render` for any uncached title) plus a full Svelte re-render, even when nothing about the headings changed.

**Fix:** In `handleComponentUpdate`, only recompute offsets (cheap) and skip `retrieveHeadings` if the file's headings haven't changed (compare against cached `item.headings`). Debounce `layout-change` handling.

---

## 7. Two Svelte components always mounted and always `$set` — duplicated work

**File/line:** `src/stickyHeader.ts:41-68` (mounts both preview + source), `src/stickyHeader.ts:97-99` (`$set` on both)

**Problem:** `addStickyHeader` always creates **two** `StickyHeader` components (one targeting `previewMode.containerEl`, one targeting `editMode.editorEl`), and `updateHeadings` calls `$set` on **both** on every update. Only one is ever visible at a time (you're either in preview or source mode).

**Why it janks:** Every scroll tick re-renders the hidden component too — double the DOM work, double the `{#each}` reconciliation, double the `{@html}` title injection. The hidden component's shadow element also runs its own layout.

**Fix:** Only mount and `$set` the component for the _active_ mode (`isEditMode(view)`). Mount the other lazily when the mode switches (on `layout-change`/`active-leaf-change`). At minimum, skip `$set` on the inactive component.

---

## 8. `{@html heading.title}` re-injects HTML on every re-render — no memoization

**File/line:** `src/ui/StickyHeader.svelte:113` and `:128`

**Problem:** The `{#each}` block renders `{@html heading.title}`. Svelte re-runs the `{#each}` when `headings` changes (every scroll tick that passes the `headingsEqual` guard). `{@html}` re-parses and re-inserts the HTML string into the DOM each time.

**Why it janks:** Re-parsing HTML strings and re-inserting DOM nodes on every scroll tick is wasteful. Combined with the fact that the _visible_ heading list changes rarely, this causes unnecessary DOM churn and can cause visible flicker as nodes are torn down/recreated.

**Fix:** Key the `{#each}` by `heading.index` (already done) so unchanged items are reused, and avoid `{@html}` for the common plain-text case — render text directly and only use `{@html}` when the title actually contains markdown. Consider memoizing the rendered title.

---

## 9. Hardcoded `delay(20)` and `delay(80)` magic numbers cause flicker and race conditions

**File/line:** `src/ui/StickyHeader.svelte:35` (`await delay(20)`), `src/ui/StickyHeader.svelte:48` (`await delay(80)`)

**Problem:**

- `calculateExpectedHeight` waits a fixed 20ms for the shadow to render before reading `shadow.clientHeight`. If the render takes longer (slow machine, large expected list), it reads a stale/partial height → wrong scroll target → flicker. If faster, it wastes 20ms.
- `scrollTo` (instant mode) waits a fixed 80ms for the throttled scroll to "complete" before restoring `headings`. The throttle is 50ms, so 80ms is a guess. If the scroll event hasn't fired yet, `headings` is restored too early → the sticky header shows the wrong heading (flicker). If the machine is slow, 80ms isn't enough.

**Why it causes flicker:** These are race-prone fixed sleeps. The 80ms one directly fights the 50ms throttle — it's a fragile "wait longer than the throttle" hack.

**Fix:**

- Replace `delay(20)` with a `requestAnimationFrame` double-rAF (or a `MutationObserver`/`await tick()` from Svelte) to wait for actual render completion, not a fixed time.
- Replace `delay(80)` with a promise that resolves on the actual scroll event (or on the next rAF after `scrollTo`), or use `scrollend` event where supported. Never guess a sleep longer than the throttle.

---

## 10. `predictHeadingsHeight` uses a MutationObserver that can miss or hang

**File/line:** `src/plugin.ts:150-180`

**Problem:** `predictHeadingsHeight` creates a `MutationObserver` on the shadow target, then calls `item.headingEl.predictHeadingsHeight(...)` which `$set`s `expectedHeadings`. The observer resolves only when a record's target has class `sticky-headings-shadow-item`. If the `$set` doesn't produce a mutation matching that predicate (e.g. the expected list is empty, or Svelte reuses existing nodes without a childList mutation), the promise **never resolves** → the `await` in `showSuggester` hangs, and the scroll never happens.

**Why it causes jank/flicker:** A hanging promise means the jump never completes (user clicks a heading, nothing happens). Also, MutationObserver on `subtree: true, childList: true` fires on every DOM change under the shadow, adding overhead during the jump.

**Fix:** Add a timeout to the observer promise (e.g. resolve after 100ms regardless), and resolve on the first childList mutation rather than requiring the class predicate. Prefer Svelte's `tick()`/`afterUpdate` over a MutationObserver for "wait until rendered".

---

## 11. `animateScroll` writes `scrollTop` every rAF frame — fights the throttled scroll listener

**File/line:** `src/utils/scroll.ts:12-24`, `src/ui/StickyHeader.svelte:53-58`

**Problem:** `animateScroll` sets `target.scrollTop` on every `requestAnimationFrame` (60fps). Each write fires a scroll event, which the 50ms-throttled `detectPosition` handler picks up, triggering the full `setHeadingsInView` recompute. So during a 1000ms smooth jump, the plugin recomputes headings ~20 times _in addition to_ the rAF writes.

**Why it janks:** The smooth scroll and the scroll-listener recompute fight each other. The `forceRenderingHeadings` hack (`StickyHeader.svelte:58`) is a workaround to suppress the scroll event's effect, but it doesn't stop the expensive recompute in `setHeadingsInView` from running.

**Fix:** During an animated scroll, set a flag to skip the scroll-listener recompute entirely (the destination is known). Also, `animateScroll` should use `scrollTo({ top, behavior: 'smooth' })` where supported, or at least coalesce writes to a single rAF (it already does one write per rAF, which is correct — the issue is the listener reacting to it).

---

## 12. `forceRenderingHeadings` state is a module-level mutable hack prone to stale state

**File/line:** `src/ui/StickyHeader.svelte:19, 45-59`

**Problem:** `forceRenderingHeadings` is set to `[...expectedHeadings]` before scrolling and cleared after. In instant mode it's cleared after `delay(80)`; in smooth mode it's cleared in the `onComplete` callback. If the user clicks another heading mid-animation, or the component is destroyed before `onComplete`, the state can be left stale (stuck showing the wrong headings, or `forceRenderingHeadings` never cleared).

**Why it causes flicker:** A stale `forceRenderingHeadings` shows the wrong heading list, and the manual `headings = forceRenderingHeadings` assignment bypasses Svelte's reactive flow, causing a visible jump/flicker when it's finally cleared.

**Fix:** Replace the manual state juggling with a proper reactive approach: derive the displayed headings from a single source of truth, and use Svelte's `tick()`/reactive statements instead of imperative `headings = ...` assignments. Guard against re-entrancy (ignore clicks while a jump is in progress).

---

## 13. `headingsEqual` compares by value but `getExpectedHeadings` is compared by reference

**File/line:** `src/stickyHeader.ts:5-18, 85-92`

**Problem:** `updateHeadings` skips `$set` only if `headingsEqual(headings, this.lastHeadings)` **and** `getExpectedHeadings === this.lastGetExpectedHeadings`. But `makeExpectedHeadings` returns a **new closure on every call** (`plugin.ts:248`, `:364`, `:450`), so the reference check always fails even when the headings are identical. This defeats the `headingsEqual` optimization — `$set` always runs.

**Why it janks:** The guard that's supposed to prevent redundant re-renders never short-circuits because the function reference changes every time. Every scroll tick that reaches `updateHeadings` forces a full `$set` on both components.

**Fix:** Memoize `makeExpectedHeadings` (cache the closure per `(headings, max, mode)` tuple) so the reference is stable, or compare the expected-headings output by value instead of by reference.

---

## 14. `trivial` recursion is O(n²) on the heading list

**File/line:** `src/utils/getShownHeadings.ts:80-101`

**Problem:** `trivial` recursively slices the array (`subHeadings.slice(...)`) and re-reduces on each recursion level. For a file with many headings, this is O(n²) work, and it runs on every scroll tick (`plugin.ts:321`).

**Why it janks:** On large documents (hundreds of headings), the quadratic recursion adds up during scroll, contributing to main-thread saturation.

**Fix:** Rewrite `trivial` iteratively (single pass, no slicing) — it's a simple "keep top-level headings" filter that doesn't need recursion or array copies.

---

## 15. `calcIndentLevels` is fine but runs on every scroll tick

**File/line:** `src/utils/calcIndentLevels.ts:3-18`, called from `plugin.ts:326`

**Problem:** `calcIndentLevels` is O(n) and cheap, but it runs on every scroll tick even when the heading set hasn't changed.

**Why it janks:** Minor, but it's part of the per-tick recompute that should be skipped when the active heading set is unchanged.

**Fix:** Fold into the "only recompute when active heading changes" optimization from finding #1.

---

## 16. `getContainerEl` + `clientHeight` read on every scroll tick

**File/line:** `src/plugin.ts:289` (`getContainerEl(scroller)?.clientHeight`), `src/utils/obsidian.ts:51-52`

**Problem:** Every `setHeadingsInView` call does `el.closest('.markdown-reading-view, .markdown-source-view')?.querySelector('.sticky-headings-root')` then reads `.clientHeight` — a forced layout read (the sticky header's height).

**Why it janks:** `clientHeight` forces a synchronous layout flush on every scroll tick, and the `closest`+`querySelector` DOM walk is repeated work.

**Fix:** Cache the sticky header element and its height, updating only on layout change. Avoid reading `clientHeight` in the scroll hot path.

---

## 17. CSS: `backdrop-filter: blur(12px)` on the blur theme is expensive during scroll

**File/line:** `src/ui/StickyHeader.svelte:212-220` (`.sticky-headings-theme-blur .sticky-headings-container`)

**Problem:** `backdrop-filter: blur(12px)` forces the browser to continuously re-blur the content behind the sticky header. During scroll, the backdrop changes every frame, so the GPU must re-run the blur filter on every frame.

**Why it janks:** `backdrop-filter` is one of the most expensive CSS effects; combined with the `position: relative; z-index: 2` and the two `::before`/`::after` gradient overlays (also `position: absolute`), the blur theme can drop frames during scroll.

**Fix:** Consider disabling `backdrop-filter` during scroll (toggle a class while scrolling) or replacing it with a solid/semi-transparent background. At minimum, keep the blur region small and avoid stacking multiple full-size gradient overlays.

---

## 18. CSS: `position: absolute` + `z-index: 1` on `.sticky-headings-root` creates a new stacking context and can overlap content

**File/line:** `src/ui/StickyHeader.svelte:147-156`, `styles.css:48-50`

**Problem:** `.sticky-headings-root` is `position: absolute; top: 0; width: 100%; z-index: 1`. The shadow copy (`.sticky-headings-shadow`) is also `position: absolute` with `opacity: 0` but still occupies layout and is painted (invisible but composited). The `z-index: 1` on the root can sit above note content, and the invisible shadow still triggers layout/paint.

**Why it janks:** The invisible shadow element is still laid out and painted (opacity 0 doesn't skip layout), doubling the DOM work for the sticky header. The absolute positioning means the header doesn't participate in normal flow, so it can overlap content and needs careful z-index management.

**Fix:** Use `visibility: hidden` (skips paint) or `display: none` for the shadow when not needed, instead of `opacity: 0`. Consider `position: sticky` for the visible header instead of absolute+manual offset, which is cheaper and avoids overlap issues.

---

## 19. `getIcon(...).outerHTML` re-renders SVG on every re-render

**File/line:** `src/ui/StickyHeader.svelte:85, 109`

**Problem:** `{@html getIcon('heading')?.outerHTML}` and `{@html getIcon(`heading-${heading.level}`)?.outerHTML}` call `getIcon()` and serialize to HTML on every render of the `{#each}`.

**Why it janks:** `getIcon` + `outerHTML` serialization runs per item per re-render. Minor, but adds up with the per-tick re-renders.

**Fix:** Precompute the icon HTML once (icons don't change per scroll) and cache it, or render the SVG element directly instead of serializing to HTML.

---

## 20. `onMount`/`onDestroy` `console.debug` and no cleanup of the scroll listener on component destroy

**File/line:** `src/ui/StickyHeader.svelte:24-30`

**Problem:** The Svelte component logs on mount/destroy (noise), and the scroll listener is managed in `plugin.ts` (added/removed there), not in the component's `onDestroy`. If the component is destroyed without the plugin's cleanup running, the listener leaks.

**Why it janks:** A leaked scroll listener keeps firing `setHeadingsInView` on a destroyed view, causing wasted work and potential errors. The `console.debug` is just noise.

**Fix:** Move scroll-listener lifecycle into the component's `onMount`/`onDestroy`, and remove the debug logs.

---

## Summary of highest-impact fixes

1. **Stop recomputing heading offsets on every scroll tick** (#2, #3, #16) — cache offsets per layout change; scroll handler only reads `scrollTop` and filters.
2. **Skip the Svelte `$set` when the active heading set is unchanged** (#1, #13) — fix the `getExpectedHeadings` reference-compare bug so `headingsEqual` actually short-circuits.
3. **Only mount/update the active-mode component** (#7) — halve the DOM work.
4. **Replace the 20ms/80ms magic sleeps with render-completion signals** (#9, #10) — eliminates the flicker on jumps.
5. **Fix the title cache keying and bound it per-file** (#4, #5) — correctness + memory.
6. **Make `trivial` iterative** (#14) — O(n²) → O(n).
7. **CSS: avoid `backdrop-filter` during scroll, hide the shadow properly** (#17, #18).
