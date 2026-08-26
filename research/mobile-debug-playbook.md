# Mobile Debug Playbook — Sticky Headings (No Flicker)

> **Living reference** for debugging why this plugin does not work on mobile.
> Plugin: `sticky-headings-no-flicker` (manifest id), v2.1.4, `isDesktopOnly: false`.
> Audience: the user (testing on a phone) + the next agent who touches mobile code.
> Source of truth for code references: `src/plugin.ts`, `src/stickyHeader.ts`, `src/ui/StickyHeader.svelte`, `src/utils/obsidian.ts`, `src/utils/getShownHeadings.ts`, `styles.css`, `manifest.json`.
> Source of truth for past attempts: commits `7144d7e`, `b83c08f`, `fa3c8ca`, `61dc6d4`, `e8bfd73`, `aca0ca4` + the `research/` docs.

---

## TL;DR

- The plugin **loads** on mobile (manifest id / folder-name mismatch was fixed in `7144d7e`; `isDesktopOnly: false` is correct).
- The plugin **Mounts** the Svelte sticky-header component into `view.previewMode.containerEl` / `view.editMode.editorEl` on mobile — verified by `mounted svelte component` log in `StickyHeader.svelte:36`.
- The remaining failure modes are **silent no-ops**, not crashes, because every internal-API access is null-guarded. Symptoms are caused by one of:
  1. **`getScroller(view)` returns `null`** → no scroll listener attached → the sticky bar is **visible but static/non-tracking** (the `updateHeadings` no-scroller branch still populates `headings`). (`research/mobile-sticky-headings-not-visible.md`)
  2. **Heading offsets collapse to degenerate values** (`0` or `index * 32`) when `view.editor.cm` / `view.previewMode.renderer.sections` are missing → wrong heading shown as "current", wrong scroll target on click. (`research/mobile-desktop-compat-audit.md` findings #6, #7)
  3. **Mount target is null/detached at mount time** → Svelte component never created → bar invisible. The single-mount code in `stickyHeader.ts` may defer when `view.getMode()` picks a container that doesn't exist yet on mobile. (`research/mobile-desktop-compat-audit.md` finding #4)
  4. **CSS positioning**: `.has-sticky-headings { position: relative }` + `.sticky-headings-root { position: absolute; top: 0; z-index: 1 }` may render the bar under the mobile top bar / safe-area inset, *even when the component is mounted and has headings*. (`research/mobile-desktop-compat-audit.md` finding #11)
  5. **Scroll listener attached to the wrong element** — listener attached directly to the resolved scroller may not catch scroll events when the real mobile scroller is recreated/lazy. (`research/mobile-desktop-compat-audit.md` findings #3, #12)
  6. **Metadata hasn't resolved yet** on a slow phone → `getShownHeadings` returns `[]` and `setHeadingsInView` exits early → bar hidden until the next `resolve` event.
- The upstream plugin `zhouhua/obsidian-sticky-headings` has **no mobile-specific code at all** — same `view.editor.cm.scrollDOM` / `view.previewMode.renderer.previewEl` paths, no `Platform.isMobile`, no mobile CSS, two-component mount. So mobile *can* work with the same internal APIs; the question is **timing + null-guarding + CSS**, not platform branching. (`research/upstream-mobile-handling.md`)

---

## Symptom → Hypothesis quick map

| Symptom on mobile | First hypothesis to test |
|---|---|
| Plugin shows "Failed to load" in settings | H1 (load failure) — check mobile console for `onload` exception |
| Plugin loads, no sticky bar appears at all (any note, any mode) | H3 (no mount target) → H4 (CSS off-screen) → H6b (metadata not resolved) |
| Bar appears but doesn't update as you scroll | H2 (scroller null) → H5 (listener on wrong element) → H6 (offsets collapse) |
| Bar appears, shows wrong heading (top-level only, never advances) | H6 (offsets collapse to 0 / `index*32`) |
| Bar appears in reading mode but not in edit/live-preview | H2 (edit-mode scroller fallback missing) |
| Bar appears in edit mode but not in reading mode | H2 (preview-mode `renderer.previewEl` null on mobile) |
| Clicking a heading in the **status bar** (Quick Navigate) does nothing or hangs | H7 (`predictHeadingsHeight` MutationObserver / 250ms timeout path) |
| Clicking a heading in the **sticky bar itself** does nothing or jumps wrong | H2 (scroller null in `scrollTo`) → H6 (offsets collapse) → H4 (bar covers target) |
| Bar visible but covered by mobile top bar / status bar | H4 (CSS safe-area / z-index) |
| Bar appears for first note but not when navigating via internal link | H8 (file-open event on mobile) |
| Bar appears then disappears when keyboard opens | H4 (CSS) + known upstream FR #51 (not yet handled) |

---

## Hypotheses (priority order)

> Each hypothesis is a discrete thing you can test on the phone and report back.
> "Code status" tells you which files already try to handle it — so you don't re-try blindly.

### H1 — `onload()` throws on mobile → "Failed to load plugin"

- **How to confirm**
  - Mobile console (see cheatsheet below). Look for `console.warn('Sticky headings plugin onload encountered an error', error)` at `src/plugin.ts:120` or any uncaught exception before it.
  - If no plugin logs at all appear → plugin module evaluation itself threw (look for a stack trace at the top of the console).
- **Code status**
  - `src/plugin.ts:44-122` wraps `loadSettings`, `initStatusBarItem`, all `registerEvent` calls, and `checkFileResolveMap()` in nested `try/catch`. Internal API calls inside `initStickyHeaderComponent`/`retrieveHeadings` are also guarded, so a late internal-API error typically becomes a non-fatal warning rather than a "Failed to load".
  - `src/utils/obsidian.ts` and `src/utils/getShownHeadings.ts` heavily null-guard internal APIs (`view.editor.cm`, `view.previewMode.renderer`).
  - Covered by: `research/mobile-plugin-load-failure-causes.md` (ruled out CJS/ESM, lodash `require("util")`, `window.i18next`, `isDesktopOnly`; identified internal-API timing + folder-name/id match as the real risks).
- **Expected result if true**: console shows a `TypeError` / `ReferenceError` in `onload` or module top-level; plugin is listed but greyed out / "Failed to load" in Community Plugins.
- **What to try**: read the exact error message. A top-level/module-eval crash is most likely a bundling/Node-API issue or a regex lookbehind on older iOS. A guarded internal-API failure inside `checkFileResolveMap()` will appear as a warning, not "Failed to load".

### H2 — `getScroller(view)` returns `null` on mobile → bar never populated

- **How to confirm**
  - Add temporary `console.log('getScroller', { mode: view.getMode?.(), hasCm: !!view?.editor?.cm, hasScrollDOM: !!view?.editor?.cm?.scrollDOM, hasRenderer: !!view?.previewMode?.renderer, hasPreviewEl: !!view?.previewMode?.renderer?.previewEl, hasContainerEl: !!view?.previewMode?.containerEl })` at the top of `getScroller` in `src/utils/obsidian.ts:41`.
  - Add `console.log('handleComponentUpdate scroller', scroller)` after `const scroller = getScroller(view)` in `src/plugin.ts:358`.
  - Open a note in reading mode on the phone. If you see `scroller null`, H2 is confirmed.
- **Code status**
  - `src/utils/obsidian.ts:41-67` already has a fallback chain for **edit mode**: `editor.cm.scrollDOM` → `editMode.containerEl .cm-scroller` → `editMode.containerEl` → `contentEl .cm-scroller`.
  - For **preview mode** it falls back to: `previewMode.containerEl` → `previewMode.renderer.previewEl` → `contentEl .markdown-preview-view` → `contentEl .markdown-reading-view`.
  - `src/plugin.ts:309-353` (`updateHeadings`) has a "no-scroller" branch that still calls `item.headingEl.updateHeadings(...)` with `freshHeadings` and schedules a `scheduleScrollerRetry` (up to 10 retries @ 100ms).
  - Covered by: `research/mobile-sticky-headings-not-visible.md` (root-cause analysis), `research/mobile-desktop-compat-audit.md` findings #1, #2, `research/obsidian-mobile-sticky-headers-api-research.md` §2.
- **Expected result if true**: log shows `scroller null` repeatedly; `mounted svelte component` appears **and** `updateHeadings` is called (bar visible but static); bar does **not** track scroll.
- **What to try**: in `getScroller`, also try `view.contentEl` itself and `.view-content` as last-resort fallbacks (capture-phase listener on a stable ancestor is the recommended pattern per `obsidian-mobile-sticky-headers-api-research.md` §3). Also confirm the retry chain is firing (log `retryCount` in `scheduleScrollerRetry`). If the bar is invisible despite a null scroller, look at H3/H4.

### H3 — Mount target is null/detached at mount time (Svelte component never created)

- **How to confirm**
  - Log `console.log('resolveMountContainers', { isPreview, previewTarget: !!previewTarget, sourceTarget: !!sourceTarget })` inside `resolveMountContainers` in `src/stickyHeader.ts:22`.
  - Log `console.log('addStickyHeader targets', targets.length)` in `src/stickyHeader.ts:75`.
  - If `targets.length === 0` → `console.warn('No mount container found for sticky header; deferring mount')` fires (already in code at `stickyHeader.ts:85`).
- **Code status**
  - `src/stickyHeader.ts:22-55` (`resolveMountContainers`) now picks ONE container based on `view.getMode()` — not both like upstream. So a wrong mode read = no target.
  - `src/stickyHeader.ts:83-90` warns and defers mount when no target is found; `stickyHeaderComponents` is set to `[]`.
  - `src/plugin.ts:371-373` only calls `addStickyHeader` if `!item.headingEl.stickyHeaderComponents?.length`.
  - Covered by: `research/mobile-desktop-compat-audit.md` finding #4 (dual-mount problem; the fork now does single-mount but at risk of picking the wrong one).
- **Expected result if true**: `No mount container found for sticky header; deferring mount` warning in console; `mounted svelte component` never logs.
- **What to try**: confirm `view.getMode()` returns `'preview'` on mobile (it should). If `getMode()` returns `'source'` but `editMode.editorEl` is null (lazy creation), `resolveMountContainers` returns empty → defer. Re-trigger `handleComponentUpdate` after `layout-change` so the mount happens once the editor el exists. If the preview container itself is null at mount time, the 100ms `active-leaf-change`/`file-open` timeouts may simply be too short on mobile — increase them or retry with `requestAnimationFrame`.

### H4 — CSS positions the bar off-screen or under the mobile top bar

- **How to confirm**
  - In mobile DevTools Elements panel, inspect `.sticky-headings-root` inside the active view. Check `getBoundingClientRect()` — is `top` negative, or behind another element?
  - Toggle `--sticky-header-verticle-offset` in settings to a large value (e.g. 80px). If bar becomes visible, H4 confirmed.
  - Run in console: `document.querySelector('.sticky-headings-root')?.getBoundingClientRect()` and `getComputedStyle(document.querySelector('.sticky-headings-root')).zIndex`.
- **Code status**
  - `styles.css:50-52`: `.has-sticky-headings { position: relative }` — sets positioning context.
  - `src/ui/StickyHeader.svelte:173-182`: `.sticky-headings-root { position: absolute; top: 0; width: 100%; z-index: 1; padding-top: var(--sticky-header-verticle-offset) }`.
  - `styles.css:54-57` + `StickyHeader.svelte:254-258`: only mobile-specific CSS is `@media (max-width: 600px) { .sticky-headings-theme-float.sticky-headings-root { padding: 10px 4% } }` — **no safe-area handling, no `.is-mobile` rules**.
  - Covered by: `research/mobile-desktop-compat-audit.md` finding #11, `research/obsidian-mobile-sticky-headers-api-research.md` §5.d (safe-area insets), upstream FRs #50 #51.
- **Expected result if true**: `mounted svelte component` logs; `getBoundingClientRect` shows the element exists but `top` is within the top-bar region or `z-index: 1` is below the mobile title bar overlay.
- **What to try**: add `body.is-mobile .sticky-headings-root { padding-top: env(safe-area-inset-top); z-index: 20 }` and ensure `.view-content` (or the actual mobile scroll container) is `position: relative`.

### H5 — Scroll listener attached to wrong element / `.view-content` gate skips updates

- **How to confirm**
  - Log `console.log('scroll listener attached to', scroller.tagName, scroller.className)` after `scroller.addEventListener('scroll', ...)` in `src/plugin.ts:402`.
  - Scroll the note on the phone. Log `console.log('scroll event fired', event.target)` at the top of `newScrollListener` (`plugin.ts:398`).
  - If listener is attached but no scroll events fire → H5.
- **Code status**
  - `src/plugin.ts:398-408` attaches listener directly to `scroller` (the real scroller from `getScroller`), not `view.contentEl` (this was changed from the upstream pattern). Uses `useCapture = scroller !== item.view.contentEl`.
  - `src/plugin.ts:391-397` throttled `detectPosition` calls `setHeadingsInView` directly — **no `.view-content` gate anymore** (the gate flagged in `mobile-desktop-compat-audit.md` finding #12 has been removed).
  - Covered by: `research/mobile-desktop-compat-audit.md` findings #3, #12 (the audit predates the fix; verify the fix actually works on mobile).
- **Expected result if true**: scroll events never log when you scroll the note; `scroller` resolves to a non-scrolling element (e.g. `editMode.containerEl` which may not actually scroll on mobile).
- **What to try**: re-attach to `view.contentEl` with `capture: true` (the upstream pattern) in addition to the real scroller; the capture listener survives scroller re-creation.

### H6 — Heading offsets collapse to degenerate values (all 0 or `index * 32`) or metadata is empty

- **Two sub-causes**: (a) internal geometry APIs missing → fallback to fabricated offsets; (b) `metadataCache` hasn't resolved yet → `getShownHeadings` returns `[]`.
- **How to confirm**
  - Log `console.log('offsets', headings.map(h => h.offset))` after `freshHeadings = getShownHeadings(...)` in `src/plugin.ts:436`.
  - Open a multi-heading note on the phone and scroll. If all offsets are the same number, or look like `[0, 32, 64, 96, ...]`, H6 confirmed (fallback path fired).
  - Also check for `Preview renderer sections missing; falling back to fabricated offsets` (`getShownHeadings.ts:43`) or `Internal source offset API failed, trying DOM fallback` (`getShownHeadings.ts:136`) warnings.
- **Code status**
  - `src/utils/getShownHeadings.ts:29-69` (`getHeadingsWithOffsetPreview`) now tries `getPreviewOffsetsDOM` (real `getBoundingClientRect` measurements) before falling back to `index * 32 - boundaryOffset`.
  - `src/utils/getShownHeadings.ts:108-152` (`getHeadingsWithOffsetSource`) now tries `cm.lineBlockAt` first, then `getSourceOffsetsDOM` (real DOM), then `0` for all.
  - The DOM fallbacks require `getScroller(view)` to be non-null AND the heading DOM elements to exist (lazily created on mobile).
  - Covered by: `research/mobile-desktop-compat-audit.md` findings #6, #7, `research/mobile-sticky-headings-not-visible.md` §B, `research/obsidian-mobile-sticky-headers-api-research.md` §2.
- **Expected result if true**: bar visible but always shows the first/top-level heading set; clicking a heading scrolls to the wrong place (or to top).
- **What to try**: confirm the DOM fallback path is reached (log `domOffsets != null` inside both `*OffsetsDOM` helpers). If the DOM headings aren't yet rendered when `getShownHeadings` is called, defer the offset computation until `metadataCache resolve` + a `requestAnimationFrame`.

### H7 — Status-bar Quick Navigate hangs because `predictHeadingsHeight` returns wrong height

- **Scope**: applies only to the **status bar** "Quick Navigate Headings" command (`showSuggester`, `plugin.ts:153-174`). **Sticky-bar clicks do NOT use this path** — they use Svelte's `handleScrollClick` / `calculateExpectedHeight` (`StickyHeader.svelte:43-88`).
- **How to confirm**
  - Tap a heading in the status bar suggester. If nothing happens → H7.
  - Log `console.log('predictHeadingsHeight finish called', value)` inside `controller.finish` (`plugin.ts:192`).
  - If `finish` only logs after the 250ms safety timeout, the MutationObserver isn't catching the `.sticky-headings-shadow-item` mutation → Svelte shadow not laid out on mobile.
- **Code status**
  - `src/plugin.ts:187-228` now wraps `predictHeadingsHeight` in try/catch + a 250ms `safetyTimeout` (added in `e8bfd73`) → promise always resolves.
  - The Svelte shadow that emits `.sticky-headings-shadow-item` is inside `{#if settings.mode !== 'disable'}` (`StickyHeader.svelte:91`) — so it renders even when `headings` is empty.
  - Covered by: `research/mobile-desktop-compat-audit.md` finding #5 (predates the timeout fix; verify the timeout actually fires).
- **Expected result if true**: 250ms delay before scroll; works but slow, OR scroll never happens because `target.clientHeight` is 0 (shadow container collapsed).
- **What to try**: log `target.clientHeight` inside `controller.finish`. If 0, the shadow container isn't laid out (display:none ancestor?) — fall back to a fixed-height estimate (e.g. `headings.length * 18`).

### H8 — `file-open` / `active-leaf-change` doesn't fire on mobile navigation

- **How to confirm**
  - Log `console.log('file-open', file?.path)` in `src/plugin.ts:82` and `console.log('active-leaf-change', activeLeafId)` in `src/plugin.ts:64`.
  - On the phone, open a note → tap an internal link → use the back button → tap a graph node. Check which events fire for each.
- **Code status**
  - `src/plugin.ts:62-75` listens to `active-leaf-change` (with same-leaf guard + 100ms timeout).
  - `src/plugin.ts:81-99` listens to `file-open` (only fires for already-tracked leaves, with 100ms timeout + `stillActive` check).
  - Covered by: `research/mobile-bug-session-transcript-notes.md` (open question #1), `research/file-open-event-fix.md`.
- **Expected result if true**: bar appears for first note but doesn't update / re-mount when navigating via back button or graph.
- **What to try**: also listen to `layout-change` (already registered per-leaf) and re-resolve `getScroller` + `getShownHeadings` on every fire. Confirm the 100ms timeout is long enough on a slow phone (log `getScroller` result inside the timeout).

---

## Past attempts we already made (don't retry blindly)

| Commit | Date | Mobile-related change |
|---|---|---|
| `7144d7e` | 2026-08-04 | **Rebrand plugin id** from `another-sticky-headings` → `sticky-headings-no-flicker` to match the deploy folder name. Fixed "Failed to load plugin" on mobile caused by Obsidian's folder-name == manifest-id check (stricter on mobile). Deploy script now cleans stale mismatched folders in all three vaults. |
| `b83c08f` | 2026-08-15 | **Restore visibility on mobile by adding scroller fallbacks.** `getScroller` (preview mode) gained fallbacks to `previewMode.containerEl` and `contentEl .markdown-preview-view` / `.markdown-reading-view`. Added `research/mobile-sticky-headings-not-visible.md` documenting the root cause (`renderer.previewEl` null on mobile → silent no-op). |
| `fa3c8ca` | 2026-08-17 | **WAVE2: per-leaf throttled scroll listener + view-scoped markdown parse cache.** Moved scroll listener from `contentEl`-only to per-leaf `scroller` element with `useCapture` flag computed dynamically. Added `markdownCache` Map keyed by `file.path::heading` to avoid re-parsing titles per scroll event. Hardened `getScroller` edit-mode fallback chain. |
| `61dc6d4` | 2026-08-19 | **Docs only** — added `research/core-logic-audit.md`, `research/mobile-desktop-compat-audit.md`, `research/performance-rendering-audit.md`. No code change. |
| `e8bfd73` | 2026-08-25 | **Make sticky headings work on mobile with DOM-derived fallbacks + bounded scroller retry.** Added `getPreviewOffsetsDOM` / `getSourceOffsetsDOM` (real `getBoundingClientRect` measurements) so offsets are real when `renderer.sections` / `cm.lineBlockAt` are missing. Added `scheduleScrollerRetry` (up to 10 attempts @ 100ms) so the scroll listener gets attached once the editor is ready. Hardened `predictHeadingsHeight` with try/catch + 250ms safety timeout. Added `handleComponentUpdate` staleness guard (`fileResolveMap.get(id) !== item`). Added `retryCount` reset on success and same-leaf file change. Added `scrollTo` retry-with-delay in the Svelte component. |
| `aca0ca4` | 2026-08-26 | **Harden settings lifecycle, break import cycle, make containers/scroller robust for new Obsidian editor.** Rewrote `resolveMountContainers` (`stickyHeader.ts`) to pick ONE container based on `view.getMode()` instead of mounting both. Tightened `addStickyHeader`/`removeStickyHeader` lifecycle. Added `research/editor-internals-mid-2025.md`, `research/mobile-bug-session-transcript-notes.md`, `research/obsidian-mobile-sticky-headers-api-research.md`, `research/upstream-mobile-handling.md`. |

---

## Mobile console debugging cheatsheet

### Android
1. Phone: **Settings → About → Developer options → enable USB debugging**.
2. Connect via USB. Allow the RSA fingerprint prompt.
3. Desktop Chrome (or Edge): open `chrome://inspect/#devices`.
4. Under "Remote Target", find the **Obsidian** webview (Capacitor).
5. Click **inspect** → full DevTools open on the desktop, console mirrored live from the phone.
6. Filter console by `Sticky` / `sticky` / `getScroller` to find plugin logs.
7. Reference: https://developer.chrome.com/docs/devtools/remote-debugging

### iOS (iOS 16.4+ required, Mac only)
1. Phone: **Settings → Safari → Advanced → enable Web Inspector**.
2. Connect via USB to a Mac.
3. Mac Safari: **Safari → Settings → Advanced → enable Develop menu**.
4. **Develop → [your iPhone] → Obsidian** → opens Web Inspector with console.
5. Reference: https://webkit.org/web-inspector/enabling-web-inspector/

### In-app, no computer
- Install the **`logstravaganza`** community plugin — surfaces `console.log`/`console.warn`/errors in a tab inside Obsidian. Best option when you don't have a USB cable.
- Open it, then reproduce the bug. All the plugin's `console.warn('Failed to ...')` messages will appear.
- Caveat: cannot inspect DOM elements, only logs.

### Desktop emulation (fast iteration before phone)
- Desktop Obsidian DevTools console — try the official mobile-emulation toggle if available in your Obsidian build:
  ```js
  this.app.emulateMobile(true);   // enable mobile UI
  this.app.emulateMobile(false);  // disable
  this.app.emulateMobile(!this.app.isMobile); // toggle
  ```
  > Note: `app.emulateMobile` is not a documented public API and may not exist in all builds. If it doesn't, use the device-frame emulation in desktop DevTools (`Ctrl/Cmd+Shift+M`) as a partial substitute.
- Useful for CSS positioning tests (H4) — but **does not** reproduce lazy-DOM / scroller-timing issues (H2, H3) accurately. Always confirm on a real device.

---

## Minimal repro steps checklist

Use this every time you test a fix on the phone. Mark each step.

- [ ] 1. Build + deploy: `./sendToNovelVault.sh` (or rebuild + copy `main.js`, `manifest.json`, `styles.css` into the vault's `.obsidian/plugins/sticky-headings-no-flicker/`).
- [ ] 2. On phone: restart Obsidian fully (force-quit + reopen).
- [ ] 3. Settings → Community plugins → confirm "Sticky Headings (No Flicker)" is **listed and toggled ON** (not greyed out).
- [ ] 4. Open a multi-heading note (≥ 3 headings, mixed H1/H2/H3) in **reading mode** (mobile default).
- [ ] 5. Observe: does the sticky bar appear at the top of the note?
- [ ] 6. Scroll down past the first heading. Does the bar update to show the current section?
- [ ] 7. Tap a heading in the bar. Does the note scroll to that heading?
- [ ] 8. Toggle to **edit / live-preview mode** (top-right pencil). Repeat 5–7.
- [ ] 9. Tap an internal link to a different note in the same pane. Does the bar update to the new note's headings?
- [ ] 10. Open a second note in a new pane (if supported on the device). Does each pane have its own sticky bar?
- [ ] 11. Connect mobile console (Android/iOS) and capture the full console output for steps 4–10.
- [ ] 12. Save the console log to `tmp/mobile-debug-YYYY-MM-DD.log` for the next agent.

---

## Test matrix

Fill in `Actual` and `Notes` during testing. Use ✅ / ❌ / ⚠️ (partial).

| Device | Mode | Action | Expected | Actual | Notes |
|---|---|---|---|---|---|
| Android phone | Reading | Open note | Bar shows top heading | | |
| Android phone | Reading | Scroll past H1 | Bar updates to current section | | |
| Android phone | Reading | Tap heading in bar | Note scrolls to it | | |
| Android phone | Reading | Tap internal link | Bar updates to new note | | |
| Android phone | Live preview | Open note | Bar shows top heading | | |
| Android phone | Live preview | Scroll | Bar updates | | |
| Android phone | Source mode | Open note | Bar shows top heading | | |
| Android phone | Source mode | Type a new `## H2` | Bar adds new heading | | |
| Android phone | Reading | Open note w/ only H3 | Bar shows the H3 | | |
| Android phone | Reading | Open note w/ no headings | Bar hidden, no errors | | |
| Android phone | Reading | Toggle keyboard open | Bar not covered (FR #51) | | |
| iOS phone | Reading | Open note | Bar shows top heading | | |
| iOS phone | Reading | Scroll past H1 | Bar updates | | |
| iOS phone | Reading | Tap heading | Note scrolls to it | | |
| iOS phone | Live preview | Open note | Bar shows top heading | | |
| iOS phone | Source mode | Open note | Bar shows top heading | | |
| iOS tablet | Reading | Open note | Bar shows top heading | | |
| iOS tablet | Reading | Two panes side by side | Two bars, independent | | |
| Android tablet | Reading | Open note | Bar shows top heading | | |
| Desktop (emulateMobile) | Reading | Open note | Bar shows top heading | | |
| Desktop (emulateMobile) | Reading | Scroll | Bar updates | | |

---

## Next action

> **Do these three things first.** Report results back, then we pick the next hypothesis.

1. **Capture the mobile console for one repro.** Connect Android via `chrome://inspect` (or iOS via Safari Web Inspector). Open a multi-heading note in reading mode. Save the full console output — especially any `Failed to ...` warnings and whether `mounted svelte component` appears. Note that `console.debug` may be hidden by default; enable verbose/debug level in the console. This single artifact distinguishes H1 vs H2 vs H3 vs H4.
2. **Add two temporary logs and rebuild.**
   - `src/utils/obsidian.ts:41` (top of `getScroller`): `console.log('getScroller', { mode: view?.getMode?.(), hasCm: !!view?.editor?.cm?.scrollDOM, hasPreviewRenderer: !!view?.previewMode?.renderer?.previewEl, hasPreviewContainer: !!view?.previewMode?.containerEl })`
   - `src/plugin.ts:358` (after `const scroller = getScroller(view)`): `console.log('handleComponentUpdate scroller', scroller?.tagName, scroller?.className)`
   Run `./sendToNovelVault.sh`, reproduce, capture logs, then revert the logs before committing.
3. **Run the minimal repro checklist above** for at least: Android reading mode (steps 4–7) and Android live-preview (step 8). Fill in the first 2 rows of the test matrix with what you actually see.

> Once you have those three artifacts (console log, getScroller log, repro checklist), the next agent can pinpoint whether to attack H2 (scroller fallback), H4 (CSS), or H6 (offsets) — and stop guessing.