# Research — Silent desktop failures that require disable/re-enable to recover

**Date:** 2026-09-21
**Repo:** `obsidian-sticky-headings-no-flicker`
**Plugin:** Sticky Headings (No Flicker)
**Scope:** Desktop-only silent failures where the sticky header stops working until the user disables and re-enables the plugin.

**Method:** Static source review of the **current** `src/plugin.ts` (759 lines), `src/stickyHeader.ts`, `src/ui/StickyHeader.svelte`, all `src/utils/*`, and `src/types.d.ts`, cross-referenced against `research/core-logic-audit.md`, `research/file-open-event-fix.md`, `research/mobile-plugin-load-failure-causes.md`, and `learning-log.md`.

---

## Executive summary

The plugin keeps all of its per-leaf runtime state in `this.fileResolveMap`, keyed by **`leaf.id`** (`FileResolveEntry`: the Svelte `headingEl`, `scrollListener` + `scrollListenerTarget`, `detectPosition` throttle, `retryTimer`/`retryCount`, `layoutChangeEvent`, `getExpectedHeadings`, and a `resolve` flag).

"Stops working until disable/re-enable" happens when a `FileResolveEntry` is **retained in the map but its mount and/or scroll listener are left broken, and no subsequent event re-runs the code path that rebuilds it.** Re-enabling fixes it because `onunload()` clears the whole map (`plugin.ts:748`) and the next `onload()` rebuilds every entry from scratch for the current view mode — wiping whatever half-broken state survived.

Three distinct, code-grounded root causes match that signature:

| # | Confidence | File / line | Failure scenario |
|---|---|---|---|
| 1 | **High** | `plugin.ts:410` + `stickyHeader.ts:143-161` | Preview ↔ source mode switch on the same leaf leaves the sticky header mounted in the now-hidden old container |
| 2 | **Medium-High** | `plugin.ts:557-591, 137-140, 547-555` | Unhandled async rejection in the un-awaited `metadataCache.resolve` listener on a stale `item.file`, with the self-heal gate (`handleEditorChange`) dead code |
| 3 | **Medium** | `plugin.ts:294-345` | Same-leaf re-init tears down the mount + scroll listener *before* rebuilding; a throw mid-rebuild leaves a retained entry with nothing mounted and no listener |

---

## Why "disable + re-enable fixes it" — the recovery contract

`onunload()` (711-750):
- destroys every `headingEl` via `removeStickyHeader()` (714),
- `offref`s each `layoutChangeEvent` (717),
- removes each `scrollListener` from its `scrollListenerTarget` (721),
- clears `retryTimer` (725),
- removes the `stickyScrollCapture` dataset flag (731),
- **`this.fileResolveMap.clear()` (748).**

`onload()` (75-153) then calls `checkFileResolveMap()` (146), which for every markdown leaf calls `initStickyHeaderComponent(leaf.view)` (622). Because the map is empty, that always takes the *fresh-init* `if` branch (275), which constructs a **brand-new `StickyHeaderComponent` into the container matching the current view mode** and re-attaches the scroll listener. So re-enabling rebuilds exactly the state that a broken retained entry was supposed to hold — which is why it always "fixes" the freeze.

The corollary: any error that leaves an entry **retained** with a broken mount/listener, and that does **not** trigger `active-leaf-change` (leaf id changed), `file-open` (file path changed), or a fresh `layout-change`, will stay broken until the user re-enables.

---

## Root cause #1 — HIGH confidence: no remount after preview↔source mode switch

### Files / lines
- `src/plugin.ts:410` — `if (!item.headingEl.stickyHeaderComponents?.length) { item.headingEl.addStickyHeader(...) }`
- `src/stickyHeader.ts:22-55` (`resolveMountContainers`), `143-161` (`addStickyHeader`)

### The failure scenario (exactly the desktop case)
1. User opens a note in **preview / reading mode**. `resolveMountContainers` returns the preview target (`plugin.ts`/`stickyHeader.ts` mounts Svelte into `previewMode.containerEl` or `.markdown-*-view`).
2. User hits **Cmd/Ctrl+E (toggle edit/preview)** or switches to source mode **on the same file, same leaf**. Both the leaf id and the file path are unchanged.
3. `layout-change` fires → `handleComponentUpdate(view)` runs. Because the map entry still exists, the mode-switch path in `initStickyHeaderComponent` (`else` branch, 294-340) is **never reached** — it is only reached from `checkFileResolveMap()`, which is only invoked on `active-leaf-change` (leaf changed), `file-open` (file changed), or initial load.
4. Inside `handleComponentUpdate` the remount is gated on line 410: `if (!item.headingEl.stickyHeaderComponents?.length)`. After the switch the array is **still non-empty** (the old component remains), so `addStickyHeader` is **skipped**. The Svelte component stays mounted inside the preview container, which is now hidden; the newly-active source container gets no sticky header.
5. `updateEditMode` (426-429) and `updateHeadings` are no-ops / ineffective because the component lives in the hidden container. The bar either visually disappears or freezes showing stale headings.

### Why it is silent
The whole of `handleComponentUpdate` is wrapped in a single blanket `try/catch` (line 471) that only `console.warn`s. No error surfaces, no listener dies — the mount simply targets the wrong, hidden DOM. The dedup guard `lastActiveLeafId` (`plugin.ts:97-104`) plus the file-path guard in the `file-open` handler (`plugin.ts:123`) mean no later event re-enters the rebuild path while the file/leaf stay the same.

### Why toggling fixes it
`onunload` → `onload` clears the map and re-runs `initStickyHeaderComponent`, which (map now empty) takes the fresh-init branch and mounts a new `StickyHeaderComponent` into the **current** mode's container. Alternately, merely re-opening the note in a *different* leaf would also fix it.

### Why desktop-specific
Mobile reading view is preview-only (no source toggle), so the preview↔source switch is a desktop/tablet-only trigger. The `.cm-editor`→`.markdown-*-view` container swap is also the desktop dual-mode case.

### Minimal fix
Change the remount guard from "array empty" to "mount container matches the current mode":

```ts
// plugin.ts, handleComponentUpdate — replace line 410's test:
const needsRemount =
  !item.headingEl.stickyHeaderComponents?.length ||
  !resolveMountContainers(item.view).some(t =>
    item.headingEl.stickyHeaderComponents?.some(c => c.target === t)
  );
if (needsRemount) {
  item.headingEl.addStickyHeader(item.view, this.settings);
}
```

(Expose `target` on the Svelte component, or compare containers via `resolveMountContainers` against the currently-mounted targets. `addStickyHeader` already calls `removeStickyHeader()` internally, so it is safe to call unconditionally on mode change.)

---

## Root cause #2 — MEDIUM-HIGH: unhandled async rejection in the resolve listener, with the self-heal gate dead

### Files / lines
- `src/plugin.ts:137-140` — `this.metadataCache.on('resolve', file => { this.handleResolve(file); })`
- `src/plugin.ts:557-591` — `async handleResolve`
- `src/plugin.ts:547-555` — `handleEditorChange` (defined, **never registered**)

### The failure scenario
`handleResolve` is an `async` method invoked as an event callback that is **neither awaited nor `.catch()`-ed** (line 138: `this.handleResolve(file)`). Inside it:

```ts
for (const [id, item] of this.fileResolveMap) {
  if (item.file.path === file.path) {
    ...
    const headings = await this.retrieveHeadings(file, item.view); // line 565
    ...
    this.updateHeadings(file, item.view, item);                    // line 575
  }
}
```

`retrieveHeadings` (666-692) calls `getHeadings(file, this.app)` → `app.metadataCache.getFileCache(file)` **at line 667, which is NOT wrapped**. `handleResolve` keeps a reference to the *entry's* `item.file`. Per `research/file-open-event-fix.md` Q7, after a same-leaf file swap the entry's `file` field is updated in the init `else` branch — but if a resolve event fires against a **stale/renamed/detached `TFile` object**, or metadata cache throws for that file, `getFileCache` throws. Because the listener is un-awaited and un-caught, this surfaces as an **unhandled promise rejection**; the remaining iterations of the `for...of` batch for other open leaves on the same file are skipped, `checkFileResolveMap()` at line 584 is never reached for that batch, and those entries are not refreshed.

### Why it is silent
The rejection goes to the global unhandled-rejection handler, not to any `try/catch` in this function (the only guards are the per-heading catches inside `retrieveHeadings` itself, which don't cover `getHeadings`). Nothing in the plugin observes the failure, and no event retries it.

### Why the dead `handleEditorChange` gate makes it permanent
`handleEditorChange` (547-555) is the only writer of `item.resolve = false`. It is **never registered** (verified: grep shows the definition only, no `.on(...)`). Therefore in `handleResolve` the branch at line 577-580:

```ts
if (!item.resolve) {
  item.resolve = true;
  ids.push(id);
}
...
if (ids.length > 0) this.checkFileResolveMap(); // line 584
```

can **never** run — `item.resolve` stays `true` forever (set to `true` on init, line 290). So the one path that would re-run the full reconcile after a resolve failure is effectively dead, and a broken entry has no built-in recovery.

### Why toggling fixes it
Same as #1: re-enable wipes and rebuilds the map.

### Why desktop-specific
The stale/detached-`TFile` case is most likely with multi-pane desktop workflows (per `file-open-event-fix.md` Q7 the same-leaf file swap leaves the entry's `file` field stale until re-init). It's a timing/race on metadata `resolve` vs. file navigation — a desktop-heavy interaction pattern.

### Minimal fixes
1. `Promise.resolve().then(() => this.handleResolve(file)).catch(e => console.warn('resolve failed:', e))` — or wrap `handleResolve`'s body in its own `try/catch` so a rejection can never abort the batch.
2. Register `handleEditorChange` — subscribe to the relevant editor event (`workspace.on('editor-change', ...)` or the `file-open`/`layout-change` path) that sets `item.resolve = false` when a file's content changes, restoring the `checkFileResolveMap()` self-heal.
3. Defensively guard `item.file` in `handleResolve`: skip entries whose `item.file.status !== 'loaded'` (or re-fetch `view.getFile()` instead of trusting the cached reference).

---

## Root cause #3 — MEDIUM: torn-down-but-not-rebuilt partial state in the same-leaf re-init

### Files / lines
- `src/plugin.ts:294-345` (the `else` branch of `initStickyHeaderComponent`)
- outer guard `src/plugin.ts:343` (`catch (error) { console.warn('Failed to init sticky header component:', error); }`)

### The failure scenario
The same-leaf re-init branch performs a **destructive teardown first, rebuild second**:

1. `item.headingEl?.removeStickyHeader?.()` (line 299) → destroys Svelte components, `stickyHeaderComponents = []` (`stickyHeader.ts:163-175`).
2. `offref(layoutChangeEvent)` (304) and `removeEventListener` on the old scroll listener + nulls `item.scrollListener`/`scrollListenerTarget`/`detectPosition` (306-315).
3. Then rebuild: `makeExpectedHeadings(...)` (328), `new StickyHeaderComponent(view, settings)` (333), `this.app.workspace.on('layout-change', ...)` + `registerEvent` (336-338).

If **any step after the teardown throws** (e.g. `new StickyHeaderComponent` → `addStickyHeader` → `this.app.workspace.on` failing during a teardown/teardown race, or `makeExpectedHeadings`), the whole branch exits through the outer `try/catch` at line 343 — but the entry has **already** had its headingEl destroyed and scroll listener cleared. It stays retained in the map in a "nothing mounted, no listener" state.

### Why it is silent and permanent
The blanket catch (343-345) only warns. Because `fileResolveMap.has(id)` is now `true`, every *later* `initStickyHeaderComponent` call for the same leaf takes the **same `else` branch** and can fail the same way (or short-circuit), so the idempotency guard that normally protects fresh inits (`!fileResolveMap.has(id)`) works *against* recovery. With a single-pane desktop user (no leaf switch, no file-open, no mode toggle that would hit a working path), no event rebuilds the entry → freeze until disable/re-enable.

### Why toggling fixes it
Re-enable clears the map, so the next init takes the fresh-init branch (275) which builds the component and listener atomically.

### Why desktop-specific
The same-leaf rebuild is exercised by clicking internal links / navigating within one pane (per `file-open-event-fix.md`) — a primary desktop interaction. Any mid-branch throw leaves the single active pane dead.

### Minimal fix
Make the re-init **atomic** — do not tear down until the new objects are successfully constructed, or guard the teardown so a failure doesn't leave a destroyed-but-retained entry:

```ts
const newHeadingEl = new StickyHeaderComponent(view, settings);
const newLayoutChange = this.app.workspace.on('layout-change', this.handleComponentUpdate.bind(this, view));

// Only commit after both construct successfully; the constructor is effectively the
// mount, and registerEvent is idempotent-safe to call here.
try {
  item.headingEl?.removeStickyHeader?.();          // now safe: replacement already built
  if (item.layoutChangeEvent) this.app.workspace.offref(item.layoutChangeEvent);
  if (item.scrollListener && item.scrollListenerTarget) { /* remove */ }
  item.headingEl = newHeadingEl;
  item.layoutChangeEvent = newLayoutChange;
  this.registerEvent(newLayoutChange);
} catch (e) {
  newHeadingEl.removeStickyHeader?.();             // roll back the new mount
  console.warn('...', e);
}
```

Additionally, in `handleComponentUpdate`, if the mount guard decides a remount is needed but `stickyHeaderComponents?.length > 0` with a stale target, call `removeStickyHeader()` first (which `addStickyHeader` already does internally) — i.e. the fix in #1 also hardens this path.

---

## Supporting observations (not the top-3, but relevant)

- **`handleComponentUpdate` also tears-down-then-rebuilds the scroll listener (414-455).** It removes the old listener before re-attaching to `contentEl`. Because `contentEl` is stable (unlike the scroller node), the *listener* generally survives CM rebuilds — so the scroll path is more robust than the mount path; the freeze is dominated by mount/lambda state, not the listener.
- **`scheduleScrollerRetry` (593-611)** caps at `MAX_RETRIES = 20` and only self-heals because `handleComponentUpdate` resets `retryCount = 0` at line 459 on a later event. If no later `layout-change`/`resolve` event runs, an exhausted retry is permanent, but that's a secondary contributor to the mount freeze rather than an independent cause.
- The `core-logic-audit.md` headline critical bug (`predictHeadingsHeight` promise never resolving) is **already fixed** in the current source (`plugin.ts:218-260` uses `record.addedNodes` + a 250 ms `safetyTimeout`, so it always resolves) and is not a cause of the desktop freeze.

---

## Summary

The single dominant, desktop-specific silent failure is **root cause #1** (no remount on preview↔source mode switch because the remount guard tests array-emptiness instead of container identity). **#2** (unhandled async rejection in the un-awaited `resolve` listener compounded by the dead `handleEditorChange` self-heal gate) and **#3** (non-atomic same-leaf teardown-then-rebuild) are the two next-most-likely, and all three share one property: the `FileResolveEntry` survives in the map while its mount is broken, and no later event rebuilds it — which is precisely why only disable/re-enable recovers, since `onunload()` clears the map and `onload()` rebuilds from scratch for the current mode.
