# Learning Log — obsidian-sticky-headings-no-flicker

Record insights, solutions, and gotchas discovered during development.

---

## Format

Each entry:
- **Date** — when the insight was gained
- **Problem** — what we were trying to do or what went wrong
- **Solution** — how we fixed it or what we learned
- **Files** — relevant source files involved

---

## Entries

### 2026-07-14 — Svelte `{#key}` blocks cause DOM flicker on frequent updates

- **Problem**: Sticky headings flickered visibly during scroll. The Svelte template used `{#key array}` blocks around the heading list. Svelte's `{#key}` DESTROYS and RECREATES all child DOM nodes whenever the key expression changes. Since `setHeadingsInView()` passed a new array on every scroll tick (throttled 50ms), the entire heading bar was torn down and rebuilt 20 times per second.
- **Solution**: Replaced `{#key}` blocks with keyed `{#each ... (heading.index)}`. This lets Svelte diff incrementally — it only adds/removes individual heading DOM nodes that actually changed, instead of destroying everything.
- **Files**: `src/ui/StickyHeader.svelte`
- **Key insight**: `{#key}` in Svelte is a sledgehammer — use it only when you genuinely need to reset component state. For list rendering, keyed `{#each}` is almost always the right choice.

### 2026-07-14 — Reference equality defeats optimization guards

- **Problem**: Added a content-equality check in `stickyHeader.ts` to skip `$set()` when headings hadn't changed. But the check compared `getExpectedHeadings === lastGetExpectedHeadings` by reference. The problem: `makeExpectedHeadings()` created a NEW closure on every `setHeadingsInView()` call, so the reference was always different. The optimization never fired.
- **Solution**: Cached the `getExpectedHeadings` closure on `FileResolveEntry` (created once during init/layout-change, reused across scroll events). Now the same reference is passed every time, and the equality check works.
- **Files**: `src/plugin.ts`, `src/stickyHeader.ts`, `src/types.d.ts`
- **Key insight**: When optimizing with reference equality checks, make sure the references are actually stable. A factory function called inline will always produce new references.

### 2026-07-14 — Don't cache too aggressively — know what triggers what

- **Problem**: First attempt at fixing flicker removed `retrieveHeadings()` from `setHeadingsInView()`. But it also accidentally removed heading refresh on layout-change and metadata-resolve, because those code paths routed through `setHeadingsInView` via `handleComponentUpdate` and `handleResolve`.
- **Solution**: Kept `setHeadingsInView` using cached headings (fast scroll path), but restored `retrieveHeadings()` calls in `handleComponentUpdate` (layout changes: edit/preview switch, pane resize) and `handleResolve` (content changes: headings added/removed). The invariant: scroll = fast (cached), layout-change/content-change = recompute.
- **Files**: `src/plugin.ts`
- **Key insight**: Before removing an expensive call, trace ALL callers and understand which events trigger them. "Expensive on scroll" doesn't mean "remove everywhere" — it means "remove from the scroll path only".

### 2026-07-14 — CodeMirror 6 virtualizes content — offsets shift during scroll

- **Problem**: After caching headings to prevent flicker, the sticky header stopped updating during scroll. It showed ALL headings stacked in rows instead of just the current one. Root cause: heading offsets (pixel positions) computed at initialization were stale by the time the user scrolled.
- **Why**: CodeMirror 6 virtualizes off-screen content. `cm.lineBlockAt()` returns different positions as you scroll because content is lazily rendered. Preview mode has similar behavior with section heights. Offsets computed once at init are wrong during scroll.
- **Solution**: Recompute **offsets** on every scroll tick (synchronous — `getHeadings()` from metadata cache + `getShownHeadings()` via `cm.lineBlockAt` or section iteration), but reuse **cached titles** (the expensive async `parseMarkdown()` part) via a `Map<string, string>` for O(1) lookup. This keeps scroll fast (no async, no DOM element creation) while having correct offsets.
- **Files**: `src/plugin.ts` (`setHeadingsInView`)
- **Key insight**: In CodeMirror 6, you cannot cache line positions across scroll events. The positions are only valid for the current viewport state. Cache the expensive parts (rendered markdown titles), not the volatile parts (pixel offsets).

### 2026-10-15 — Degenerate-rect fallback clobbers good anchor tops; positioning context must match the measured element by construction

- **Problem**: The sticky header pinned to the wrong position (or jumped) in three situations: (1) hidden/detached leaves — `computeEffectiveTop` returned a fallback `max(0, userNudge)` when rects were degenerate (height 0), and any recompute triggered while the leaf was hidden (global `layout-change`, settings change, resize, settle timers) wrote that fallback over the correct top; (2) theme/other-plugin overrides or class refcount races removed the `.sticky-headings-mount` / `.has-sticky-headings` positioning classes, so the CSS containing block (`top:` ancestor) no longer matched the measured `main.parentElement` and the header resolved its `top:` against a different ancestor; (3) `detachLayoutListeners()` set `observedContainer = null`, clobbering the fresh assignment in the parent-change reactive block and causing ResizeObserver disconnect/reconnect churn on every `main` re-bind (which happens whenever the headings `{#if}` block flips).
- **Solution**: (1) `computeTopFromRects` (pure, bun-tested) returns `null` for zero-height rects as a skip signal, and `recomputeTop` only writes when the result is non-null — never write a position derived from degenerate rects, keep the last good value. (2) Set `parentElement.style.position = 'relative'` inline in the parent-change block — identity by construction beats any class lifecycle. (3) `detachLayoutListeners` no longer resets `observedContainer`; the reactive block orders detach → attach → inline style → assign `observedContainer` → settle. Plus: `handleComponentUpdate` calls `refreshAnchor()` early (before the async `retrieveHeadings`) and `active-leaf-change` refreshes known items directly, so fast mode toggles / tab switches correct within a frame. Debug: `document.body.dataset.stickyHeadingsDebug = '1'` enables `logAnchor` traces (trigger, prev/next top, anchor vs parent rects, `offsetParent` agreement).
- **Files**: `src/utils/viewportAnchor.ts`, `src/utils/anchorDebug.ts`, `src/ui/StickyHeader.svelte`, `src/plugin.ts`, `src/utils/viewportAnchor.test.ts`
- **Key insight**: Never write a computed position derived from degenerate rects; make the CSS containing block match the measured element by construction (inline style on the exact measured node), not by class lifecycle. `null` is a better API than a fallback number — it forces the caller to decide what "skip" means.
### 2026-10-16 — Delta-dependent top formulas clamp-saturate and kill user input

- **Problem**: The "Desktop header position" slider appeared dead, and the sticky header jumped between two visual anchors ("pinned to different things") across tabs/modes. `computeEffectiveTop` computed `effectiveTop = max(0, round(contentElRect.top − containerRect.top + userNudge))` — i.e. `max(0, nudge − delta)` where `delta = containerRect.top − anchorRect.top`. In the ZettelPublish vault the note-toolbar + theme push the editor container down by ≥31px (the user's slider value), so every nudge clamped to 0. The same delta-dependence meant the header's visual anchor changed whenever deltas changed at runtime (tab switches, edit/preview toggles measure against different geometry). The Oct 2 contentEl anchoring (d7fe625) was built on an unresolved analysis.
- **Solution**: Anchor `top` relative to the CSS containing block the header actually renders against (`main.parentElement`, already `position: relative` inline), offset purely by the user slider: `effectiveTop = max(0, round(userNudge))`. Rects are now used ONLY as the visibility/degeneracy guard (zero height → `null` skip, preserving the hidden-leaf clobber fix). Pure core refactored to `computeTopFromRects(anchorHeight, containerHeight, userNudge)` — there is no delta to clamp. Slider descriptions updated to match the mental model: header anchored to the top of the visible content area, slider adds offset below it.
- **Files**: `src/utils/viewportAnchor.ts`, `src/utils/viewportAnchor.test.ts`, `i18n/en/index.ts`, `i18n/zh/index.ts`
- **Key insight**: Measure against the element CSS resolves against, and make user offsets independent of measured geometry — a formula that mixes user input with measured state can saturate and kill the input.
