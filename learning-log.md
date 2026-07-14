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