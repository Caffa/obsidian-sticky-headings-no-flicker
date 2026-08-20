# Research: Sticky headings don't update when a new file opens in the same leaf

**Date:** 2026-08-20
**Repo:** `obsidian-sticky-headings-no-flicker`
**Goal:** Fix the bug where sticky headings don't update when the user opens a new file in the same leaf (e.g. clicking an internal link that opens in the current pane, no modifier key).

---

## TL;DR / Root cause

The plugin only listens to `workspace.on('active-leaf-change', ...)` (plugin.ts:56). When a file opens **in the same leaf**, the active leaf does NOT change, so `active-leaf-change` never fires — exactly the buggy scenario described.

The authoritative fix is to **add a `file-open` listener**. Obsidian's official docs say:

> **`Workspace.on('file-open')`** — *"Triggered when the active file changes. The file could be in a new leaf, an existing leaf, or an embed."*

That is precisely the "existing leaf" case this plugin is missing.

---

## Q1. Does Obsidian expose `workspace.on('file-open')`? Signature / location / scope?

**Yes.** It is a first-class event on the **`Workspace`** class (`this.app.workspace`), not on `App`.

**Authoritative signature** (from `node_modules/obsidian/obsidian.d.ts`, v1.6.6, line 4693):

```ts
on(name: 'file-open', callback: (file: TFile | null) => any, ctx?: any): EventRef;
```

**Official doc** (https://docs.obsidian.md/Reference/TypeScript+API/Workspace/on%28%27file-open%27%29):

> Triggered when the active file changes. The file could be in a new leaf, an existing leaf, or an embed. *(Since 0.10.9)*

- **Callback arg:** `TFile | null`. `null` when no file (e.g. focus moves to a non-file view).
- **Scope:** fires for the **active file** change. "The file could be in a new leaf, an existing leaf, or an embed" — so it fires both when the file opens in a *new* leaf AND when it replaces the file in the *same* leaf.

Confirmed identical signature in upstream `obsidian-api` master `obsidian.d.ts`:
```ts
on(name: 'file-open', callback: (file: TFile | null) => any, ctx?: any): EventRef;
```

Compare with `active-leaf-change` (line 4689):
```ts
on(name: 'active-leaf-change', callback: (leaf: WorkspaceLeaf | null) => any, ctx?: any): EventRef;
```

---

## Q2. When clicking an internal link (no modifier), is the `MarkdownView` instance reused or recreated?

**The same `MarkdownView` instance is reused; a new view is NOT created on the same leaf.**

Obsidian reuses the existing leaf + view instance and calls `setState(...)` on it to swap the file. The typings confirm the lifecycle (this is why `TextFileView` has the `clear` flag in `setViewData`):

- `WorkspaceLeaf.setViewState(viewState, eState?)` (obsidian.d.ts:4850) — reuses the leaf; Obsidian calls the same view's `setState`.
- `TextFileView.setViewData(data, clear)` — the doc comment explicitly says: *"If `clear` is set, then it means we're opening a completely different file. In that case, you should call `clear()`..."* (obsidian.d.ts:3953–3965). This confirms the **same view instance** serves successive different files.
- `FileView.onLoadFile(file)` / `onUnloadFile(file)` (lines 1636, 1640) — fired per-file on the reused view.

**Implication for the plugin:** The `MarkdownView` (and its `.leaf.id`) stays the same, but `view.getFile()`, `view.file`, `view.contentEl`'s child content, and the CodeMirror/preview DOM are all torn down and rebuilt for the new file.

**This is the crux:** the plugin keys its `fileResolveMap` by **`leaf.id`** (e.g. plugin.ts:197 `const { id } = view?.leaf ?? {}`). Because the leaf id never changes on same-leaf navigation, the existing `FileResolveEntry` (with its stale `file`, `headings`, `container`, scroll listeners, sticky components) is **never re-initialized** — that's the bug.

---

## Q3. Are there other `file-open` / similar listeners already registered in this repo?

**No.** A full scan of `src/` and `main.ts` shows only these three event registrations, all in `src/plugin.ts`:

| Event | Line | Purpose |
|---|---|---|
| `workspace.on('active-leaf-change', ...)` | 56 | Re-run `checkFileResolveMap()` when active leaf changes |
| `metadataCache.on('resolve', file => ...)` | 75 | Refresh headings when file metadata resolves |
| `workspace.on('layout-change', handleComponentUpdate)` | 205 | Recompute offsets on layout change |

`grep -rn "file-open\|active-leaf-change\|layout-change\|\.on("` across `src/` and `main.ts` confirms **no `file-open` listener exists anywhere**. `main.ts` is just the entry re-export of `./src/plugin`.

---

## Q4. Does `active-leaf-change` fire when a file opens in a NEW leaf (Cmd/Ctrl+click)? Would both fire?

**Yes — opening in a new leaf fires `active-leaf-change`** (the leaf is new/becomes active), **and `file-open` also fires** (the active file changed). So in the new-leaf case, **both events fire**.

- `active-leaf-change` — fires when the active leaf changes (new leaf becomes active).
- `file-open` — fires when the active *file* changes, regardless of leaf ("a new leaf, an existing leaf, or an embed").

**Same-leaf case (the bug):** only `file-open` fires; `active-leaf-change` does NOT fire because the leaf is unchanged.

This asymmetry is exactly why adding `file-open` is the correct, complete fix: it covers both the new-leaf and same-leaf paths, so keeping the existing `active-leaf-change` handler would cause **duplicate work** in the new-leaf case — which motivates the defensive pattern in Q5.

---

## Q5. Recommended defensive pattern to avoid duplicate work when both events fire

When opening in a new leaf, both `active-leaf-change` and `file-open` fire → the plugin's `checkFileResolveMap()` would run twice (once per listener). The established defensive patterns:

### Option A — Idempotent reconcile + early-exit guard (recommended)
Make `checkFileResolveMap()` idempotent (it already largely is: it only inits a leaf if `!this.fileResolveMap.has(id)`), and in the `file-open` handler, only act if the file actually differs from what's cached for the active leaf:

```ts
this.registerEvent(
  this.app.workspace.on('file-open', (file) => {
    // Same-leaf re-nav: file changed but leaf id is the same.
    // Guard against the same file re-firing and against double work.
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const id = view.leaf.id;
    if (!id) return;
    const item = this.fileResolveMap.get(id);
    if (item && item.file?.path === file?.path) return; // no-op, already current
    this.checkFileResolveMap();
  })
);
```

Because `checkFileResolveMap()` re-runs `initStickyHeaderComponent(leaf.view)` for every leaf, and `initStickyHeaderComponent` already short-circuits on `fileResolveMap.has(id)`, the same-leaf case hits the `else` branch (lines 221–229) and updates `item.file`, `item.headings`, `item.getExpectedHeadings` — which is exactly what needs to happen. The `active-leaf-change` handler can then be **removed** or left as a no-op fallback.

### Option B — Debounce/throttle the reconcile
Since both events fire in the new-leaf path, wrap `checkFileResolveMap` in a `lodash.debounce` (already imported at plugin.ts:20) with e.g. 50–100ms so the two events collapse into one reconcile:

```ts
const reconcile = debounce(() => this.checkFileResolveMap(), 100);
this.registerEvent(this.app.workspace.on('active-leaf-change', () => reconcile()));
this.registerEvent(this.app.workspace.on('file-open', () => reconcile()));
```

### Note on the existing `setTimeout` in `active-leaf-change`
The current handler (lines 60–66) already guards with `lastActiveLeafId` and a `setTimeout(…, 100)` "wait for cm.editor to load". The same wait is needed for `file-open` (the editor DOM may not be ready synchronously). Debouncing both through one reconcile is the cleanest.

**Recommended:** Option A (idempotent `file-open` handler + keep `checkFileResolveMap` idempotency), because the plugin's map is keyed by leaf id and `initStickyHeaderComponent` already has the exact short-circuit needed. Optionally also drop the `active-leaf-change` listener in favor of `file-open` alone to eliminate the duplicate-firing path entirely — but `active-leaf-change` still covers the edge case of switching focus between two *already-open* leaves with no file change, so keep it as a no-op guard.

---

## Q6. Confirm `view.getFile()` and `view.contentEl` reflect the new file by the time `file-open` fires.

**Yes — by the time `file-open` fires, the view's `file` and `contentEl` already reflect the new file.** `file-open` is emitted *after* Obsidian has loaded the file into the view (i.e. after `onLoadFile` → `setViewData` → editor/preview DOM built).

Evidence from the type model:
- `MarkdownView` implements `MarkdownFileInfo`, which declares `get file(): TFile | null` (obsidian.d.ts:2210) and `contentEl: HTMLElement` (line 1940/2707).
- `FileView.file: TFile | null` (line 1603) and `MarkdownView.contentEl` (inherited via `ItemView`, line 1939) are populated during file load.

**Caveat:** `contentEl` is the *container* — its child content (the CodeMirror `.cm-editor` / preview DOM) may still be **building** when `file-open` fires. The plugin already handles this with its `setTimeout(…, 100)` wait and its `layout-change` listener (`handleComponentUpdate`), so heading offsets should be recomputed after the editor finishes mounting. The correct ordering is:

1. `file-open` → file/container already swapped (safe to read `view.getFile()`).
2. Editor/preview DOM fully mounted slightly later → offsets valid → `layout-change` / `handleComponentUpdate` recomputes them.

So the plugin should (a) swap the cached `item.file`/`item.headings` immediately in the `file-open` handler, and (b) rely on the existing `layout-change` + scroll listeners to recompute offsets once the DOM settles.

---

## Q7. Cleanup logic review in `plugin.ts` (`checkFileResolveMap`, `onunload`) — stale references on same-leaf file change

**Yes — there are stale references that need updating when the file changes in the same leaf.** The map entry is keyed by `leaf.id`, and the leaf id never changes on same-leaf navigation, so all file-specific fields go stale:

In `src/types.d.ts`, `FileResolveEntry` (lines 16–31) stores **file-specific state**:
```ts
file: TFile;
view: MarkdownView;
container: HTMLElement;     // == view.contentEl
headings: Heading[];
getExpectedHeadings: ...
headingEl: StickyHeaderComponent;
layoutChangeEvent: EventRef;
scrollListener?: ...
scrollListenerTarget?: HTMLElement;  // the scroller DOM node
detectPosition?: ...
```

On same-leaf navigation the leaf id is unchanged, so `checkFileResolveMap()` finds the leaf still "valid" and never tears the entry down. The problems:

1. **`container` / `scrollListenerTarget` become stale.** `container` is captured as `view.contentEl` (plugin.ts:210) and `scrollListenerTarget` is the `getScroller(view)` DOM node (plugin.ts:286–291). When a new file loads, Obsidian clears and rebuilds the content inside `view.contentEl` (and in source mode replaces the `.cm-scroller` / `.cm-content` nodes). The old scroller node is **detached from the DOM**, so:
   - The scroll listener attached to the *old* scroller never fires again → sticky headings freeze.
   - `item.container` still points at the (now reused) `contentEl`, but `item.view` is the same instance, so `view.getFile()` reflects the new file while `item.file` and `item.headings` are stale.
   - In `handleComponentUpdate` (lines 260–264) the code removes the old scroll listener from `item.scrollListenerTarget` — but if that node is already gone, `removeEventListener` is a harmless no-op; the real problem is the listener was never moved to the *new* scroller.

2. **`headingEl` (Svelte sticky components) target stale content.** `StickyHeaderComponent` mounts Svelte components into `view.previewMode.containerEl` and `view.editMode.editorEl` (stickyHeader.ts:44–85). When a new file loads in the same leaf, Obsidian reuses/clears these container elements. `removeStickyHeader()` in `StickyHeaderComponent` (lines 92–99) calls `$destroy()` and removes `has-sticky-headings`, but the entry isn't re-initialized because the leaf id is unchanged → components keep targeting cleared/rebuilt DOM.

3. **`layoutChangeEvent` is fine (doesn't go stale) but should be re-registered.** It's an `EventRef` bound to `handleComponentUpdate.bind(this, view)` with the *same* `view` instance (plugin.ts:205) — since the view instance is reused, the bound handler still points at the right object. However, `handleComponentUpdate` looks up `this.fileResolveMap.get(id)` and operates on `item.headings`/`item.file` (stale after re-nav). So the event ref itself is valid; the *data it reads* is stale until re-initialized.

### What must be updated in the `file-open` handler (concrete)

In the same-leaf path, `initStickyHeaderComponent`'s `else` branch (plugin.ts:221–229) currently only refreshes:
```ts
item.editMode = isEditSourceMode(view);
item.headings = headings;
item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, ...);
item.file = file;
```
It does **NOT** refresh `item.container`, `item.scrollListener`/`scrollListenerTarget`, nor re-mount `item.headingEl`. The fix should additionally:
- Re-resolve `item.container = view.contentEl`.
- Remove the old scroll listener from the old target and re-attach to the new scroller (reuse the logic already in `handleComponentUpdate`, lines 260–299).
- Ensure `headingEl.addStickyHeader(item.view, this.settings)` is re-run so the Svelte components mount into the freshly-rebuilt preview/edit containers (the `stickyHeaderComponents?.length` guard at plugin.ts:252 may still be true if components weren't destroyed — force a re-mount when the file changes).
- Then call `handleComponentUpdate(view)` (already done at line 230) to recompute offsets.

**`onunload()` (lines 498–527) and `checkFileResolveMap()`'s cleanup block (lines 431–448) are correct** for teardown (they guard `item?.layoutChangeEvent`, `item?.scrollListener && item?.scrollListenerTarget`, etc.), but they only run when a leaf is destroyed/removed. They do **not** handle the same-leaf file swap — that's the gap Q7 exposes. No leaks in onunload, but the same-leaf path needs the field refreshes listed above.

---

## Summary of recommended code change (plugin.ts)

```ts
// In onload(), after the existing active-leaf-change registration:
this.registerEvent(
  this.app.workspace.on('file-open', (file) => {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const id = view.leaf.id;
    if (!id) return;
    const item = this.fileResolveMap.get(id);
    if (item && item.file?.path === file?.path) return; // same file, no-op
    // Wait for editor DOM to build (mirrors the active-leaf-change handler).
    setTimeout(() => {
      if (this.app.workspace.getMostRecentLeaf()?.id === id) {
        this.checkFileResolveMap(); // re-inits / refreshes the entry for this leaf
      }
    }, 100);
  })
);
```

And inside `initStickyHeaderComponent`'s `else` (same-leaf refresh) branch, also refresh `container`, re-attach the scroll listener, and force a sticky-header re-mount for the new file.

---

## Sources

- Obsidian API typings: `node_modules/obsidian/obsidian.d.ts` (v1.6.6) — lines 4689 (`active-leaf-change`), 4693 (`file-open`), 4698 (`layout-change`), 1603/1940/2210/2707 (`file`, `contentEl`, `get file()`), 4850 (`setViewState`), 3921–3965 (`TextFileView.setViewData` `clear` flag).
- Obsidian official API docs: `on('file-open')` — https://docs.obsidian.md/Reference/TypeScript+API/Workspace/on%28%27file-open%27%29 ("Triggered when the active file changes. The file could be in a new leaf, an existing leaf, or an embed.")
- Upstream `obsidian-api` master `obsidian.d.ts` (https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts) — identical event signatures.
- Community: Obsidian Forum `setActiveLeaf()` workarounds thread (https://forum.obsidian.md/t/setactiveleaf-is-creating-a-massive-pile-up-of-workarounds-in-plugins/11182) and `active-leaf-change` fired twice thread (https://forum.obsidian.md/t/api-active-leaf-change-event-is-sometimes-triggered-twice/31841) — document the `active-leaf-change`/`file-open` double-fire and the need for dedup.
- This repo: `src/plugin.ts` (lines 56, 195–235, 245–304, 414–452, 498–527), `src/types.d.ts` (lines 16–31), `src/stickyHeader.ts` (lines 32–99).
