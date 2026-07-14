# Research: Flickering Headings Fix

## Problem

Headings in the sticky headings plugin flicker when scrolling. The flicker is visible as the heading bar rapidly disappearing and reappearing during scroll.

## Root Cause (Confirmed)

Three compounding causes:

1. **`{#key}` blocks in StickyHeader.svelte** — Svelte's `{#key}` directive destroys and recreates all child DOM when the key expression changes. Since `headings` was a new array reference on every scroll tick (50ms throttle), the entire heading DOM was torn down and rebuilt 20×/second.

2. **`retrieveHeadings()` on every scroll tick** — Expensive offset computation (DOM queries via `cm.lineBlockAt` or `renderer.sections` iteration) + markdown parsing ran on every scroll event, even though scrolling doesn't change document layout.

3. **No content equality check** — `$set()` was called with a new array reference even when the visible headings were identical, triggering unnecessary Svelte re-renders.

## Fix Applied

### 1. StickyHeader.svelte — Incremental DOM diffing
- Removed `{#key forceRenderingHeadings || headings}` and `{#key expectedHeadings}` blocks
- Replaced with keyed `{#each ... (heading.index)}` for both main and shadow divs
- Svelte now diffs incrementally — only adds/removes individual heading nodes that changed

### 2. stickyHeader.ts — Skip $set when unchanged
- Added `headingsEqual()` helper comparing `index`, `level`, `indentLevel`, `title`
- `updateHeadings()` short-circuits if all four props (headings, getExpectedHeadings, showFileName, view) are unchanged
- Stores `lastHeadings`, `lastGetExpectedHeadings`, `lastShowFileName`, `lastView` for comparison

### 3. plugin.ts — Cache headings, recompute only on real changes
- `setHeadingsInView()` (scroll path) uses `item.headings` — no recompute
- `handleComponentUpdate()` (layout-change) calls `retrieveHeadings()` to recompute offsets
- `handleResolve()` (metadata-resolve / content change) calls `retrieveHeadings()` to refresh
- `getExpectedHeadings` closure cached on `FileResolveEntry`, recreated only when headings or settings change

## Architecture After Fix

```
Scroll event (50ms throttle)
  → setHeadingsInView() — uses CACHED item.headings (fast, no DOM queries)
  → filter by scrollTop + stuckHeaderHeight
  → trivial() mode filtering
  → calcIndentLevels()
  → updateHeadings() — equality check, skip $set if unchanged
  → Svelte keyed {#each} — incremental DOM diff (no teardown)

Layout change (edit/preview switch, resize)
  → handleComponentUpdate() — calls retrieveHeadings() (recompute offsets)
  → updates item.headings + item.getExpectedHeadings
  → setHeadingsInView() with fresh data

Content change (heading added/removed)
  → handleResolve() — calls retrieveHeadings() (refresh from metadata cache)
  → updates item.headings + item.getExpectedHeadings
  → updateHeadings() → setHeadingsInView() with fresh data
```

## Relevant Files

- `src/ui/StickyHeader.svelte` — template rendering (keyed each)
- `src/stickyHeader.ts` — Svelte bridge with equality guard
- `src/plugin.ts` — orchestrator with cached headings
- `src/types.d.ts` — FileResolveEntry with getExpectedHeadings field
- `src/utils/getShownHeadings.ts` — offset computation (unchanged)
- `src/utils/makeExpectedHeadings.ts` — closure factory (unchanged)

## Status

Fixed and deployed. Awaiting user testing in Obsidian.