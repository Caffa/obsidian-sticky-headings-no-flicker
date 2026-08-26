# Mobile Bug Background Research — Session Transcript Extraction

**Date:** 2026-08-25
**Source sessions:**
- `ses_fe125e675ffemX7QFrgiqjyuyk` — "Headings not updating when navigating pages" (full transcript saved at `tmp/session-pages.md`)
- `ses_fcb4e562bffeFDnH3SWLYwsrLV` — "Plugin works on desktop but not mobile" (prior turns saved at `tmp/session-mobile.md`; transcript ends mid-investigation)

---

## Session 1: "Headings not updating when navigating pages"

### Symptom
- Sticky header kept showing the **old page's top-level heading** after navigating to a new note.
- Repro on desktop: open a note, scroll so a heading sticks, click an internal link that opens in the **same pane** → heading doesn't change.

### Root cause identified
1. Plugin only listened to `active-leaf-change`. When a file opens in the *same* leaf (normal internal-link click), the leaf ID is unchanged → event effectively useless for that case.
2. The handler had a guard `if (activeLeafId === lastActiveLeafId) return` (with a 100ms setTimeout waiting for cm.editor) → same-leaf navigation was skipped entirely, so `checkFileResolveMap()` never ran.
3. `fileResolveMap` entry (keyed by leaf id) still pointed at the old file/view/headings.
4. Secondary issue: the per-leaf `layout-change` listener was bound (`bind(this, view)`) to the **old view** captured at registration time; Obsidian replaces the MarkdownView on same-leaf file opens, so the stale binding risked attaching scroll listeners to dead scrollers. Events registered via `workspace.on` persist until `offref` — not auto-cleaned on view destroy.

### Code paths changed (`src/plugin.ts`)
1. **New `workspace.on('file-open', ...)` listener** in `onload()`:
   - Guards: markdown file only, active MarkdownView exists, leaf already tracked in fileResolveMap, file actually changed vs tracked item, leaf still active after 100ms delay.
   - Defers to existing `checkFileResolveMap()` for consistency with `active-leaf-change` path.
   - Kept `active-leaf-change` listener too (needed for cleanup of closed leaves / non-markdown switches where `file-open` doesn't fire).
2. **Hardened same-leaf re-init branch** of `initStickyHeaderComponent()` (existing-entry case):
   - Removes old sticky component + old `layout-change` listener (`offref`).
   - Removes old scroll listener from the old scroller (`getScroller(view)`).
   - Updates `view`, `file`, `container`, `editMode`, `headings`, `getExpectedHeadings`, `currentIndex`, `resolveRevision`.
   - Creates fresh `StickyHeaderComponent`, registers new `layout-change` listener bound to the new view.

### Outcome
- ✅ Worked on **desktop**: build, lint, deploy (`./sendToNovelVault.sh`) all green; analytic + deep reviewer approved.
- Committed: `FIX: update sticky headings when a new file opens in the same leaf` (+ `research/file-open-event-fix.md`). Diff: https://critique.work/v/b10f26f91e88cf29675cc0ed076ad7c5
- ❌ User then reported **mobile still broken** → spawned session 2.

### Supporting details worth keeping
- Prior fix referenced from `learning-log.md`: cached `getExpectedHeadings` closure on FileResolveEntry (created once during init/layout-change, reused across scroll events) — an earlier stale-closure flicker fix.
- Architecture: `checkFileResolveMap()` iterates all leaves → `initStickyHeaderComponent(leaf.view)` keyed by leaf id → `handleComponentUpdate(view)` retrieves headings via `retrieveHeadings(item.file, view)`, attaches scroll listener via `getScroller(view)`, updates Svelte component via `item.headingEl.updateHeadings(...)`.
- Researcher subagent produced a doc on Obsidian `file-open` semantics (saved as `research/file-open-event-fix.md`).

---

## Session 2: "Plugin works on desktop but not mobile" (current)

### What the user said (voice message transcription)
> "This is still not working for the mobile side. I would like you to check what the original plugin does for the mobile and then compare it to all the approaches we have tried by looking at the Kimaki sessions here because it works on the desktop but not the mobile right now."

### State of investigation in transcript
The transcript **cuts off mid-investigation** — no findings, fix attempts, or conclusions were recorded yet. Completed actions only:
- Listed Kimaki sessions + git log for the project.
- Identified original plugin: **Zhou Hua's [obsidian-sticky-headings](https://github.com/zhouhua/obsidian-sticky-headings)**.
- Read: `manifest.json`, `README.md`, `package.json`, src glob, `research/` folder listing, `src/stickyHeader.ts` (149 lines), one utils file (41 lines), `src/plugin.ts` (598 lines).
- Flagged other relevant sessions to mine for prior mobile attempts:
  - `ses_feb6c0982ffeuEYP5AbUs6s7CR` — "Investigate stale heading showing wrong season"
  - `ses_ff459aab0ffeGT99crKlgBVeAK` — "Obsidian plugin bug and performance audit"

### Mobile-only specifics found in these two transcripts
- **None beyond the symptom statement.** No mention of `Platform.isMobile`, mobile scroller element differences, mobile-specific events, or mobile file-open semantics in either transcript.
- Likely next sources for those details: the two sessions above, `learning-log.md`, `research/` folder contents (incl. `research/file-open-event-fix.md`), and the original plugin's mobile handling (upstream repo).
- Note (inference, not from transcripts): the plugin's scroll pipeline (`getScroller(view)` + scroll listeners + layout-change) is the most probable divergence point on mobile, since mobile uses different scroll containers/view lifecycle than desktop.

---

## Open questions for the mobile fix
1. Does `file-open` / `active-leaf-change` fire reliably on mobile? (Mobile navigation often goes through different paths — e.g., back button, search results, graph clicks.)
2. Does `getScroller(view)` find the correct scroll container on mobile?
3. Does the sticky header element even mount on mobile (DOM structure differs)?
4. How does the original zhouhua plugin handle mobile (does it use `Platform.isMobile` branches)?
