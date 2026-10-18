# Cutting iOS CPU/memory for a sticky-headings Obsidian plugin

Research date: 2026-10-18. Scope: reduce per-event work on `metadataCache 'resolve'`, workspace `'layout-change'`, and iOS `visualViewport`/`resize` bursts — without changing features (no flicker).

## 0. What the reference plugin (zhouhua/obsidian-sticky-headings) actually does today

Source (master, read 2026-10-18):
- `src/plugin.ts` — https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/plugin.ts
  - Registers `this.app.metadataCache.on('resolve', file => this.handleResolve(file))`. `handleResolve` calls `updateHeadings()` **immediately, un-debounced**, which calls `setHeadingsInView()` → `retrieveHeadings()` → `parseMarkdown()` per shown heading.
  - Registers a **per-leaf** `workspace.on('layout-change', ...)` handler (`handleComponentUpdate`), each of which re-runs `setHeadingsInView` and re-binds a `scroll` listener.
  - Scroll detection uses **lodash `throttle(..., 50, { leading: true, trailing: true })`** — not Obsidian's `debounce`.
  - `markdownCache: Record<string,string>` memoizes rendered heading HTML.
  - **No** `visualViewport`/`resize` listener exists in the upstream plugin (so that trigger is fork-specific).
- `src/utils/obsidian.ts` — `parseMarkdown()` builds a detached `<div>` and calls `MarkdownRenderer.render(app, '# '+md, div, '', activeView)` per heading.
- `src/utils/getShownHeadings.ts` — offsets come from `metadataCache`/renderer data: source mode uses `view.editor.cm.lineBlockAt()` + `.cm-contentContainer.offsetTop`; preview uses `renderer.sections[].height`. **No `getBoundingClientRect()` anywhere in current source.**
- `src/ui/StickyHeader.svelte` — an absolutely-positioned overlay plus an invisible `.sticky-headings-shadow` div whose `clientHeight` is read (only on click-to-jump) to predict height.

Git history: the 2.0.x rewrite (Aug 26 2024) is the fix arc for issues #20/#21 (see §4). No dedicated perf commits for #38.

## 1. Obsidian API facts (authoritative)

Source of truth: `obsidianmd/obsidian-api` `obsidian.d.ts`
- https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts

- **`debounce()`** signature is `debounce<T,V>(cb: (...args)=>V, timeout?: number, resetTimer?: boolean): Debouncer<T,V>`.
  - Returns an object with `.cancel()` and `.run()` (since 1.4.4).
  - **There are NO `leading`/`trailing` options** in Obsidian's built-in `debounce` — the task's assumption is wrong. It is trailing-only, with `resetTimer` controlling whether a new call restarts the timer. For leading+trailing you must use `lodash.debounce`/`throttle` (as this plugin does) or hand-roll.
  - Docs: https://docs.obsidian.md/Reference/TypeScript+API/debounce
- **`Platform`**: `isMobile`, `isDesktop`, `isDesktopApp`, `isMobileApp`, `isIosApp`, `isAndroidApp`, and `isPhone`/`isTablet`-style helpers — plain booleans, cheap to read at load/module scope.
- **Metadata cache reads are cheap & synchronous**: `metadataCache.getFileCache(file): CachedMetadata | null` and `metadataCache.getCache(path)`. Headings live at `cache.headings` (`HeadingCache[]`, each with `heading`, `level`, `position.start.line/offset`).
  - **There is no `metadataCache.getHeadings()` method.** The task's phrasing is inaccurate; use `getFileCache(file)?.headings ?? []`.
  - Events: `on('resolve', (file: TFile))` (per-file, fires on autosave) and `on('resolved', ())` (batch/settled). Both confirmed in the .d.ts (lines ~6528/6533).
- **`MarkdownRenderer.render(app, markdown, el, sourcePath, component): Promise<void>`** — async, constructs a `MarkdownRenderChild`, runs the full markdown post-processor chain. Calling it once per heading per keystroke (as upstream does on every `resolve`) is the single biggest avoidable cost. Memoizing the rendered HTML string per heading text (as `markdownCache` does) is correct; the bug is *when* it re-runs.
  - Docs: https://docs.obsidian.md/Reference/TypeScript+API/MarkdownRenderer
- **Handy built-in helpers instead of `requestIdleCallback`**: `window.sleep(ms): Promise<void>` and `window.nextFrame(): Promise<void>` (global `nextFrame()`/`sleep()` also exist). Confirmed in `obsidian.d.ts`.
- **`requestIdleCallback` is NOT usable on iOS WKWebView.**
  - MDN marks it "Limited availability … not Baseline because it does not work in some of the most widely-used browsers": https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback
  - caniuse: Safari & Safari on iOS show "Disabled by default" from 13.1 through 27.2; only Safari TP enables it. https://caniuse.com/requestidlecallback
  - mdn/browser-compat-data issue #24573 confirms WebKit ships it behind a pref that was disabled again: https://github.com/mdn/browser-compat-data/issues/24573
  - **Standard fallback**: `setTimeout`/`setTimeout(0)` for trailing deferral, `requestAnimationFrame` to coalesce a burst into one frame, or Obsidian's `window.nextFrame()`/`window.sleep(ms)`. Always feature-detect: `const idle = window.requestIdleCallback ?? (cb => setTimeout(() => cb({ didTimeout:false, timeRemaining:()=>16 }), 1))`.

## 2. Real-world debounce patterns (plugin source, with values)

1. **Dataview** (blacksmithgu) — `src/main.ts`
   - https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/main.ts
   - `this.debouncedRefresh = debounce(() => this.app.workspace.trigger('dataview:refresh-views'), this.settings.refreshInterval, true)`.
   - Default `refreshInterval` is **500 ms**, clamped to a **100 ms** minimum ("<100 => 100"). So the canonical "refresh views when files change" debounce is 500 ms trailing with timer-reset.

2. **Breadcrumbs** (michaelpporter) — `src/main.ts`
   - https://github.com/michaelpporter/breadcrumbs/blob/main/src/main.ts
   - `const _rebuild_debouncer = debounce(() => this.rebuildGraph(), 1500, true)` — graph rebuild.
   - `const _redraw_page_views_debouncer = debounce(() => redraw_page_views(this), 150, true)` — cheap UI redraw.
   - `const _save_debouncer = debounce(() => this.saveSettings(), 600, true)` — persistence.
   - Coalescing idiom: `metadataCache.on('changed', () => this._pending_rebuild = true)` then `metadataCache.on('resolved', () => { if (this._pending_rebuild) { this._pending_rebuild = false; this.rebuildGraphDebounced(); } })`. This is a dirty-flag + settle-event pattern that avoids doing work per keystroke.
   - `layout-change` handler routes to either `rebuildGraphDebounced()` (1500 ms) or `_redraw_page_views_debouncer()` (150 ms), gated by a setting.

3. **anamnesis** (Chepech) — README
   - https://github.com/Chepech/anamnesis
   - `VaultWatcher` handles `create`/`modify`/`rename`/`delete` with a **500 ms debounce** before re-indexing.

4. Consensus best-practice list ("Debounce frequent events", "Debounce API calls and saves", "Always use `registerEvent`"):
   - https://github.com/allenhutchison/obsidian-gemini/blob/master/.agents/skills/obsidian-plugin-development/references/best-practices.md

Note: the reference sticky-headings plugin uses **lodash `throttle(fn, 50, {leading:true, trailing:true})`**, i.e. it pays the leading cost on the first scroll tick (needed to avoid perceived lag) and coalesces the rest.

## 3. iOS platform behaviour (WKWebView / Safari)

- **Keyboard open/close does not always fire `window.resize`** — you must listen to `window.visualViewport` (`resize` + `scroll`). Closing the keyboard does **not** update the visual viewport immediately; a `setTimeout(..., ~1000)` was needed in one tested app. https://martijnhols.nl/blog/how-to-get-document-height-ios-safari-osk
- WebKit resizes the visual viewport **late** when the Safari UI expands — bug 265578: https://bugs.webkit.org/show_bug.cgi?id=265578
- In WKWebView the visual viewport **cannot** be resized independently of the layout viewport (keyboard is handled by the embedder), so a keyboard animation produces a burst of viewport/layout changes rather than one clean resize: https://issues.chromium.org/issues/40287394
- There are also long-standing reports of the WKWebView failing to resize at all after keyboard close, notably in Low Power Mode: https://github.com/ionic-team/capacitor-keyboard/issues/23
- Practical implication: debounce/coalesce all `visualViewport` resize work into a single rAF or ~100–150 ms trailing pass, and read geometry only *after* the burst settles.

### iOS jetsam / memory-reload reports and what mitigations worked

- Obsidian forum — "Mobile app keep reload after sync around 5K note": https://forum.obsidian.md/t/mobile-app-keep-reload-after-sync-around-5k-note/107057
  - Mitigation reported: disable plugins; add plugins per-device; don't sync heavy plugin configs to iOS. "Mobile OSes are more aggressive in killing apps that use too much memory."
- obsidian-remotely-save issue #1188 — iOS silent jetsam during parallel large downloads (buffered in memory): https://github.com/remotely-save/remotely-save/issues/1188
  - Mitigations proposed: **stream to disk instead of buffering**, make effective concurrency size-aware, **lower default concurrency on mobile**. No `.ips` crash report (memory kill, not exception).
- obsidian-smart-connections issue #1301 — mobile memory/reload loop: https://github.com/brianpetro/obsidian-smart-connections/issues/1301
  - Mitigation: fixed a **vector-memory allocation**, plus users asking for a "disable on mobile" switch.
- Obsidian forum — "Crashing when there's a large markdown": https://forum.obsidian.md/t/crashing-when-theres-a-large-markdown/113527
  - One 2.26 MB note with **1,650 headings** + 3,450 wikilinks caused an Electron/V8 **out-of-memory** renderer kill. Mitigation that worked: move huge notes into a **dot-prefixed folder** so Obsidian doesn't index them. Lesson: per-heading work scales with heading count.
- Obsidian Rocks — "Fixing Slow Startup on Obsidian Mobile": https://obsidian.rocks/fixing-slow-startup-on-obsidian-mobile
  - Custom views (Dataview, Tasks) were the load-time culprit; pared plugin set fixed it.
- Apple's jetsam guidance (memory budget per process, reports): https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports

Common thread in every mitigation: **fewer DOM nodes, fewer/larger allocations, and releasing caches** beat micro-optimizations. There is no report of a plugin being "fixed" purely by debouncing — debouncing reduces *steady-state* CPU, while jetsam is usually about peak retained memory (DOM + caches).

## 4. Upstream issues #38 and #21 (zhouhua/obsidian-sticky-headings)

- **#38 "A lot of lag and some errors"** — https://github.com/zhouhua/obsidian-sticky-headings/issues/38
  - Opened Dec 19 2024 by SandmansDreams: lag on every note, scroll stutter, lag while typing.
  - Owner (zhouhua) replied: "Could you share the note that has the issue?"
  - Reporter: lag is on **Windows but not Mac**.
  - **No fix was proposed or merged; the issue remains open.** No perf commit in the history addresses it.
- **#21 "Issue with Page Padding Recalculating Infinitely at Particular Scroll Point"** — https://github.com/zhouhua/obsidian-sticky-headings/issues/21
  - Opened Aug 12 2024 by itsonlyjames, about the **programmatic `padding-top`** added to `contentElement`, which recalculated infinitely at a scroll point. Explicitly linked to **#20**.
  - **#20** (same day) — https://github.com/zhouhua/obsidian-sticky-headings/issues/20 — tracked `item.style.paddingTop = newHeight + 'px'` and `headingContainer.parentElement.style.height = newHeight + 'px'` as the offending lines. Collaborator itsonlyjames investigated whether the padding was even necessary (the sticky container is absolute and out of document flow). Owner explained the padding was to make the "about to scroll out" calculation accurate.
  - Resolution: **architectural, not a value tweak.** Reporter closed #20 on Aug 21 2024: "Upcoming changes are tackling the solution…". The 2.0.x rewrite replaced in-flow padding mutation with an absolutely-positioned overlay + hidden shadow element, and computes offsets from cached metadata (`cm.lineBlockAt` / renderer section heights) instead of mutating layout or measuring with `getBoundingClientRect` on every tick.
  - **#40** (relates to heading rendering, fixed in 2.1.3) shows the cost of the per-heading `MarkdownRenderer.render` path and the `markdownCache` used to tame it: https://github.com/zhouhua/obsidian-sticky-headings/issues/40

## 5. Actionable technique list (see reply)

See the orchestrator reply for the compact bullet list.

### Key nuances / uncertainty flags
- Obsidian's `debounce` has **no leading/trailing** options (unlike lodash). If leading behaviour is required for scroll, use lodash `throttle` or a custom leading+trailing debounce.
- `metadataCache.getHeadings` **does not exist**; headings are on `getFileCache(file).headings`.
- `requestIdleCallback` is **unavailable** in iOS WKWebView; use `setTimeout`/rAF or Obsidian's `window.nextFrame()`/`window.sleep()`.
- The upstream plugin has **no resize/visualViewport** handling and does **not** use `getBoundingClientRect` in current source — both appear to be fork additions.
- Jetsam fixes in the wild were dominated by peak-memory reductions (streaming, lower concurrency, dot-folder exclusion), not by debouncing.
