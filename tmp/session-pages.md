# Headings not updating when navigating pages

## Conversation

### 👤 User

There is still the problem of the headings not updating when I move to a new page. So the top level heading did not change properly.

[current git branch is master]


### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

<details>
<summary>💭 Thinking</summary>

The user reports that the sticky headings plugin has an issue: headings don't update when moving to a new page, and the top-level heading doesn't change properly. This is in the obsidian-sticky-headings-no-flicker repo.

I need to investigate this. Let me first understand the codebase by exploring the relevant files.

</details>

I'll investigate the sticky headings update issue. Let me first explore the codebase and understand how headings are tracked on navigation.

> 🛠️ **bash** command=ls -la, description=List repo files, ... (37 lines)

> 🛠️ **glob** pattern=**/*.{ts,tsx,js,json,md}, path=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker (38 lines)


*Completed in 6.4s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **read** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/src/plugin… (545 lines)

> 🛠️ **read** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/src/sticky… (149 lines)

> 🛠️ **read** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/src/utils/… (120 lines)

> 🛠️ **read** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/src/utils/… (27 lines)


*Completed in 2.9s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **bash** command=git log --oneline -20, description=View recent commit history, ... (21 lines)

> 🛠️ **read** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/learning-l… (52 lines)


*Completed in 2.7s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

<details>
<summary>💭 Thinking</summary>

I can see the issue. The `headingsEqual` function in `src/stickyHeader.ts` checks `a[i].title` and `a[i].level`. The top-level heading likely changes when moving to a new page, but there could be a state caching issue. 

But the real problem might be in `setHeadingsInView` in `plugin.ts`: it does `item.headings = headings` but it uses `item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, ...)`. This makes a new closure each time `setHeadingsInView` runs, which breaks the reference equality in `stickyHeader.ts`. This is the same issue that was fixed previously. Let me check.

Wait, in the learning-log it says: "Solution: Cached the getExpectedHeadings closure on FileResolveEntry (created once during init/layout-change, reused across scroll events)."

But in `setHeadingsInView`, on line 256-258:
```typescript
const headings = await this.retrieveHeadings(item.file, view);
item.headings = headings;
item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);
```

This creates a new `getExpectedHeadings` every time `handleComponentUpdate` is called. But `setHeadingsInView` also has:
```typescript
item.headingEl?.updateHeadings?.(
  findalHeadings.map(...),
  item.getExpectedHeadings,
  ...
);
```

Hmm, but in `setHeadingsInView` it doesn't recreate `getExpectedHeadings`. It does in `handleComponentUpdate`. The issue: when moving to a new page, `active-leaf-change` triggers `checkFileResolveMap` → `initStickyHeaderComponent`.

If the leaf id already exists (e.g., same MarkdownView reused for new file), then it updates `item.headings`, `item.getExpectedHeadings`, etc. Then calls `handleComponentUpdate` which will call `retrieveHeadings` and update again.

Wait, actually the issue might be in the `headingsEqual` function. It compares title and level. If the new page has the same first heading title (e.g., both notes have "Introduction"), it won't update. But that's unlikely.

Actually, I think the issue is in `setHeadingsInView`: after `item.headings = headings`, it doesn't update `item.getExpectedHeadings`. So when `item.headingEl.updateHeadings` is called, it passes the old `item.getExpectedHeadings` which captured the old `item.headings` via closure. But wait — `item.getExpectedHeadings` was likely created to close over `item.headings` by reference, so it should pick up the new value. Let me check `makeExpectedHeadings`:

```typescript
export function makeExpectedHeadings(
  getHeadings: () => Heading[],
  max: number,
  mode: 'default' | 'concise' | 'disable'
): (index: number) => Heading[] {
  return (index: number) => {
    ...
    const subHeadings = getHeadings().slice(0, index);
```

It calls `getHeadings()` each time, so if `getHeadings` is `() => item.headings`, it will read the current value. So the closure is stable.

But the `getExpectedHeadings` reference changes in `handleComponentUpdate`, which means `stickyHeader.ts` won't skip update. That's fine.

Hmm, let me re-read the user message: "There is still the problem of the headings not updating when I move to a new page. So the top level heading did not change properly."

This is a follow-up to previous work. Let me check if there are tests and how to reproduce. Let me look at the git diff or prior changes. Also, the issue might be that `headingsEqual` doesn't compare file path/identity, so when switching between pages with identical headings, it doesn't update. But the top-level heading should change.

Actually, another subtle bug: in `setHeadingsInView`, the headings are recomputed as `freshHeadings` using `getShownHeadings(rawHeadings, item.view, this.settings)`. These include `title: heading.heading` (raw heading text). Then they are mapped to replace titles from cached `item.headings`. But the cached `item.headings` might be stale — they were computed for the PREVIOUS file if the file was changed but the item wasn't updated.

Wait, but `item.file` is updated in `initStickyHeaderComponent`. The key for titleMap is `${item.file.path}::${h.position.start.offset}`. If `item.headings` still contains old file's headings, the titleMap keys won't match new file's offsets. The titles will fall back to raw heading text. That's not ideal but should still show updated text.

Actually, the user says top-level heading did not change properly. This suggests the rendered sticky header still shows the old page's heading. Let me think about the `active-leaf-change` flow more carefully.

In `active-leaf-change` handler:
```typescript
this.registerEvent(
  this.app.workspace.on('active-leaf-change', () => {
    const activeLeaf = this.app.workspace.getMostRecentLeaf();
    const activeLeafId = activeLeaf?.id ?? null;
    if (activeLeafId === this.lastActiveLeafId) return;
    this.lastActiveLeafId = activeLeafId;
    setTimeout(() => {
      if (activeLeafId === this.lastActiveLeafId) {
        this.checkFileResolveMap();
      }
    }, 100);
  })
);
```

`getMostRecentLeaf()` returns the most recently active leaf, not necessarily the currently active leaf. Obsidian has `active-leaf-change` event, and the handler gets no args. So using `getMostRecentLeaf()` might give stale leaf. Should use `workspace.activeLeaf` or get leaf from event? But the event doesn't pass leaf in newer API? Actually Obsidian's `active-leaf-change` passes the workspace leaf as an argument in older versions, but in newer versions maybe not? Actually, the type is `on(name: 'active-leaf-change', callback: (leaf: WorkspaceLeaf | null) => any)`. So it should receive the leaf.

If we use `getMostRecentLeaf()`, that returns the leaf that was most recently active, which might be the previous leaf right after switching? No, it should be the current active leaf. But maybe there's a timing issue.

Also, the `checkFileResolveMap` iterates all leaves and calls `initStickyHeaderComponent` for each. For the previously active leaf, it might re-init it. But `initStickyHeaderComponent` checks `if (file && isMarkdownFile(file))` and uses `view.getFile()`. If the leaf now has a different file, it should update.

But here's a critical issue: in `initStickyHeaderComponent`, for an existing item:
```typescript
} else {
  const item = this.fileResolveMap.get(id);
  if (item) {
    item.editMode = isEditSourceMode(view);
    item.headings = headings;
    item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);
    item.file = file;
  }
}
```

Then it calls `await this.handleComponentUpdate(view);` which:
1. Calls `retrieveHeadings(item.file, view)` — good, gets new headings.
2. Updates `item.headings` and `item.getExpectedHeadings`.
3. Re-attaches scroll listener.
4. Calls `this.updateHeadings(item.file, item.view, item);` which calls `setHeadingsInView`.

So far so good.

The issue might be that when moving to a new page in a leaf that previously had a file, `fileResolveMap` still has the old `headingEl` mounted, and `updateHeadings` doesn't force a re-mount. But `updateHeadings` calls `item.headingEl.updateHeadings` which should update the Svelte component.

Wait — I need to look at the Svelte component to see if it has keyed blocks or what might cause it not to update.

</details>

> 🛠️ **glob** pattern=src/ui/*.svelte, path=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker (1 lines)

> 🛠️ **read** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/src/types.… (53 lines)


*Completed in 15.2s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **read** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/src/ui/Sti… (265 lines)


*Completed in 3.0s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

<details>
<summary>💭 Thinking</summary>

I need to find where the problem is. The user says headings don't update when moving to a new page - top level heading doesn't change properly.

Looking at plugin.ts, the active-leaf-change handler:
- Gets the most recent leaf
- Compares activeLeafId with lastActiveLeafId
- If same, returns
- Otherwise sets lastActiveLeafId, waits 100ms, then calls checkFileResolveMap if still active

The issue could be here. `app.workspace.getMostRecentLeaf()` - is this always the active leaf? In Obsidian, `getMostRecentLeaf()` returns the most recently active leaf. When active-leaf-change fires, this should be the new active leaf.

But wait - when you move to a new page (e.g. click a link), the active leaf changes. However, the sticky header might still be showing the old heading. 

Let me think about what could go wrong:

1. The active-leaf-change handler might not be firing correctly for all navigation cases.
2. `checkFileResolveMap()` calls `initStickyHeaderComponent` for the new view. If the fileResolveMap already has an entry for that leaf id (same leaf, different file), it goes to the else branch:
```typescript
} else {
  const item = this.fileResolveMap.get(id);
  if (item) {
    item.editMode = isEditSourceMode(view);
    item.headings = headings;
    item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);
    item.file = file;
  }
}
```

Then `handleComponentUpdate(view)` is called. This retrieves headings again, updates item.headings, etc.

But wait - in the active-leaf-change handler, after the 100ms timeout, it calls `this.checkFileResolveMap()`. But checkFileResolveMap does NOT call `handleComponentUpdate`. It only calls `initStickyHeaderComponent`. initStickyHeaderComponent calls `handleComponentUpdate` only when creating a NEW entry. If the entry exists (same leaf id), it just updates the stored data but does NOT call `handleComponentUpdate`.

So when navigating to a new page in the SAME leaf, the fileResolveMap entry exists with the same leaf id. The active-leaf-change handler calls checkFileResolveMap, which calls initStickyHeaderComponent, which updates item.file, item.headings, etc., but does NOT call handleComponentUpdate. So the sticky header UI is not updated!

This is the bug. When you navigate to a new page within the same leaf, the component doesn't get refreshed.

Wait, but does Obsidian reuse leaf ids when navigating? Let me check. In Obsidian, when you click a link that opens in the same pane, the leaf id stays the same but the view/file changes. So the fileResolveMap entry for that leaf id would still exist.

Actually, I should check what triggers handleComponentUpdate. It's registered via layout-change event:
```typescript
const layoutChangeEvent = this.app.workspace.on('layout-change', this.handleComponentUpdate.bind(this, view));
```

So when layout changes, handleComponentUpdate fires. Does active-leaf-change cause layout-change? Sometimes yes, but not always reliably. If the active leaf changes to a different file in the same leaf, Obsidian might not fire layout-change.

Wait, also the metadata cache 'resolve' event handler might fire when the new file's metadata is resolved. handleResolve would then update the headings for matching file paths. But if the file path changes, the old entry in fileResolveMap still has the old path. The handleResolve checks `item.file.path === file.path`. If the new file resolves, it finds the item with the new file path only if item.file was already updated. But checkFileResolveMap updates item.file but doesn't trigger handleComponentUpdate. 

Hmm, actually when navigating to a new file, Obsidian will resolve the new file's metadata, which fires 'resolve'. At that point, item.file has been updated by checkFileResolveMap, so handleResolve finds it and calls retrieveHeadings + updateHeadings. So eventually it should update. But maybe there's a race condition or it doesn't fire reliably.

Also, in `initStickyHeaderComponent`, when the entry exists, it updates item.file, but it doesn't call handleComponentUpdate. If the resolve event doesn't fire (e.g. file already cached), the sticky header would remain stale.

So the fix is: in `initStickyHeaderComponent`, when updating an existing entry (the else branch), also call `await this.handleComponentUpdate(view)` to refresh the UI. But we need to be careful not to cause double updates or race conditions.

Actually, looking again, initStickyHeaderComponent is called from checkFileResolveMap, which is called from:
1. onload
2. active-leaf-change handler
3. handleResolve after resolve

If we call handleComponentUpdate in the else branch, it would be called every time checkFileResolveMap runs and finds an existing leaf. That might be OK because checkFileResolveMap is throttled... actually it's not throttled. But it's called on leaf changes and resolve events, which shouldn't be extremely frequent.

Wait, but checkFileResolveMap is also called from active-leaf-change handler with a 100ms delay. If we add handleComponentUpdate there, it could conflict with the layout-change event. But that's probably OK.

Actually, let me reconsider. The issue is specifically "headings not updating when I move to a new page. So the top level heading did not change properly." This is consistent with the fileResolveMap entry not being refreshed.

But we need to be careful about the else branch in initStickyHeaderComponent. The code currently updates:
- item.editMode
- item.headings
- item.getExpectedHeadings
- item.file

But it doesn't update the UI. So the sticky header component still shows the old headings until something else triggers handleComponentUpdate.

The safest fix is to call `await this.handleComponentUpdate(view)` after updating the existing entry. This will:
1. Recompute headings
2. Update edit mode
3. Attach scroll listener
4. Update UI

But there's a subtlety: handleComponentUpdate retrieves headings again, so the update in the else branch is redundant. We could simplify by just updating item.file and then calling handleComponentUpdate.

Actually, looking at the code more carefully:

```typescript
if (!this.fileResolveMap.has(id)) {
  // create new entry
  ...
  this.fileResolveMap.set(id, {...});
  this.registerEvent(layoutChangeEvent);
} else {
  const item = this.fileResolveMap.get(id);
  if (item) {
    item.editMode = isEditSourceMode(view);
    item.headings = headings;
    item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);
    item.file = file;
  }
}
await this.handleComponentUpdate(view);
```

Wait, handleComponentUpdate is already called at the end of initStickyHeaderComponent OUTSIDE the if/else. Let me re-read...

Yes, line 230: `await this.handleComponentUpdate(view);` is outside the if/else. So it IS called for both new and existing entries. So the issue is not there.

Hmm, then why are headings not updating?

Let me look at handleComponentUpdate:
```typescript
async handleComponentUpdate(view: MarkdownView) {
  try {
    const scroller = getScroller(view);
    const { id } = view?.leaf ?? {};
    if (!id) return;
    const item = this.fileResolveMap.get(id);
    if (!item) return;
    if (!item.headingEl.stickyHeaderComponents?.length) {
      item.headingEl.addStickyHeader(item.view, this.settings);
    }
    // Refresh headings — layout changed, so offsets need recomputing
    const headings = await this.retrieveHeadings(item.file, view);
```

Wait, it uses `item.file` to retrieve headings. If item.file was updated in the else branch to the new file, then retrieveHeadings should get the new headings. So this should work.

Unless... `view.getFile()` is the new file? In initStickyHeaderComponent, `const file = view.getFile();` gets the current file. Then item.file is set to this. Then handleComponentUpdate uses item.file. So it should be correct.

But maybe the problem is that `view` is stale? Let me check. In checkFileResolveMap:
```typescript
this.app.workspace.iterateAllLeaves(leaf => {
  if (leaf.view instanceof MarkdownView) {
    const { id } = leaf;
    if (id) {
      validIds.add(id);
      this.initStickyHeaderComponent(leaf.view);
    }
  }
});
```

It passes `leaf.view` which is the current view. This should be the new view.

In the active-leaf-change handler:
```typescript
this.registerEvent(
  this.app.workspace.on('active-leaf-change', () => {
    const activeLeaf = this.app.workspace.getMostRecentLeaf();
    const activeLeafId = activeLeaf?.id ?? null;
    if (activeLeafId === this.lastActiveLeafId) return;
    this.lastActiveLeafId = activeLeafId;
    // timeout to wait for cm.editor to load
    setTimeout(() => {
      if (activeLeafId === this.lastActiveLeafId) {
        this.checkFileResolveMap();
      }
    }, 100);
  })
);
```

It uses getMostRecentLeaf(). After active leaf changes, this should be the new leaf.

But wait, there might be an issue with `getMostRecentLeaf()`. Let me check Obsidian API. Actually, `getMostRecentLeaf()` returns the most recently focused leaf. When you click a link to open a new file, if it opens in the current leaf, that leaf is still the most recent. If it opens in a new leaf, that new leaf becomes most recent. So this should work.

Hmm, let me think about another possibility. The `active-leaf-change` event might not fire when a link opens in the same leaf? Or it might fire before the view's file has changed?

Actually, when you navigate within the same leaf (e.g. click a link), Obsidian may not fire `active-leaf-change` because the active leaf hasn't changed - it's still the same leaf. The event fires when the ACTIVE leaf changes, not when the file in the active leaf changes.

So if you click an internal link that opens in the same pane, the leaf stays active. The active-leaf-change event might not fire. In that case, checkFileResolveMap is not called, and the sticky header isn't updated.

What events DO fire when a file changes within the same leaf? The 'layout-change' event might fire. But the layout-change event handler is `this.handleComponentUpdate.bind(this, view)`. The `view` here is captured at registration time - it's the original view. But since it's the same leaf, the view object might be the same or replaced.

Wait, actually in Obsidian, when you open a different file in the same leaf, the view object is usually replaced. The old MarkdownView is destroyed and a new one created. So the bound `view` in the layout-change handler would be the OLD view. handleComponentUpdate would get the old view's id, look up fileResolveMap (which might have been updated by checkFileResolveMap previously or not), and try to update.

But if active-leaf-change doesn't fire, then checkFileResolveMap doesn't run, so fileResolveMap still has the old entry with the old file and old view. The layout-change event fires with the old view, handleComponentUpdate does `const { id } = view?.leaf ?? {}`, gets the old leaf id, finds the old item, and updates based on old file. The new view is never registered.

This could be the bug! When navigating to a new page in the same leaf, active-leaf-change might not fire (because same leaf), so the new view isn't registered, and the sticky header stays attached to the old file's headings.

Actually, I need to verify whether active-leaf-change fires when file changes within same leaf. Let me think... in Obsidian, clicking an internal link that opens in the same pane: the leaf doesn't change, but the view does. I believe `active-leaf-change` does NOT fire in this case. The appropriate event would be something else, like `layout-change` or the view's own lifecycle.

So we need to handle the case where the file changes within the same leaf. We could listen to `workspace.on('file-open', ...)` or similar.

Actually Obsidian has `app.workspace.on('file-open', (file: TFile) => {...})`. Let me check. The Obsidian API has events like `active-leaf-change` and `layout-change`. There's also `file-open` event on Workspace.

Actually, looking at the Obsidian API docs, events include:
- `active-leaf-change`: leaf: WorkspaceLeaf | null
- `file-open`: file: TFile
- `layout-change`: none

The `file-open` event fires when a file is opened. This would catch navigation within the same leaf.

So the fix might be to also listen to `file-open` and call checkFileResolveMap or handleComponentUpdate.

But wait, the current code has a `lastActiveLeafId` check that might skip updates. If we add a file-open listener, we can just call checkFileResolveMap() directly.

Let me also consider: when active-leaf-change fires for a different leaf, does it always mean the file changed? Yes. And when file-open fires for the same leaf, active-leaf-change might not fire. So we need both.

But there's another issue: the active-leaf-change handler currently checks `activeLeafId === lastActiveLeafId` and returns if same. But if the same leaf opened a new file, we need to update. The current handler would skip this. The file-open listener would catch it.

So the plan:
1. Add a `file-open` event listener that calls `checkFileResolveMap()`.
2. Maybe also reset `lastActiveLeafId` or adjust logic to handle same-leaf file changes.

Actually, looking more carefully at the active-leaf-change handler, when the same leaf opens a new file, activeLeafId equals lastActiveLeafId, so it returns early and does NOT call checkFileResolveMap. This is intentional to avoid duplicate calls, but it misses same-leaf file changes.

If we add a file-open listener, it would catch same-leaf file changes. But we need to be careful not to duplicate work with active-leaf-change.

Wait, but file-open fires when ANY file opens, including when active leaf changes. So if we listen to both, we'd call checkFileResolveMap twice when changing active leaves. But checkFileResolveMap is idempotent-ish, though it does iterate all leaves and might recreate components. We should debounce or guard against excessive calls.

Actually, we can change the active-leaf-change handler to always call checkFileResolveMap, and rely on the file-open listener. Or we can keep active-leaf-change and add file-open, but with a guard.

Let me look at what the actual Obsidian event behavior is. I think file-open fires for each file open, including when switching to a different leaf with a different file. active-leaf-change fires when the active leaf changes.

So a good approach:
- Listen to `file-open` and call checkFileResolveMap.
- Remove or adjust the active-leaf-change handler's lastActiveLeafId guard, OR keep it but also listen to file-open.

Actually, I think the simplest and most robust fix is to listen to `file-open` and call checkFileResolveMap(). The active-leaf-change handler can be removed or kept for extra safety. But the file-open event fires for all file opens including initial load, so it might be sufficient on its own.

But we need to also consider the case where the user switches to a non-markdown view in the same leaf. active-leaf-change would fire, file-open might not (since no file opened). So we should keep active-leaf-change for cleanup.

Also, the 100ms setTimeout in active-leaf-change is there to wait for cm.editor to load. For file-open, we might also need a timeout.

Let me think about the current timing. When file-open fires, the view might not be fully ready. So we could use a small timeout.

Actually, there's another event: `layout-change`. The current code registers a per-leaf layout-change event in initStickyHeaderComponent. But that bound view might be stale.

OK so let me approach this systematically. I think the bug is:
1. When navigating to a new file in the same leaf, active-leaf-change doesn't fire (same leaf).
2. fileResolveMap entry for that leaf still points to the old file/view.
3. The sticky header shows old headings.

Fix: Add `file-open` event listener to refresh the fileResolveMap when a file opens.

Let me also think about edge cases:
- If file-open fires and the new file is opened in a leaf that already has an entry, checkFileResolveMap will update item.file and call handleComponentUpdate.
- The old layoutChangeEvent is still registered with the old view. When layout-change fires, the old view's handler runs with old id. But by then, fileResolveMap has been updated to the new view. The old handler's view parameter is stale. This could cause issues.

Wait, when a file opens in the same leaf, the old view is destroyed and a new one created. The old layoutChangeEvent registered via `this.app.workspace.on('layout-change', handler)` still exists and uses the old view. When layout-change fires on the new view, the old handler runs with old view. It does `const { id } = view?.leaf ?? {}` - the old view's leaf might be the same leaf object (leaf id same) or might be destroyed. If leaf id is the same, it looks up fileResolveMap with that id and finds the new entry (new file, new view). Then it does `const headings = await this.retrieveHeadings(item.file, view);` - using the old view to retrieve headings, but item.file is the new file. This could work if the old view is still partially valid, but it's risky.

Actually, if the old view is destroyed, `view.leaf` might still exist or be undefined. If undefined, it returns early. If it exists with same id, it proceeds with stale view.

So another issue: when the file changes within the same leaf, the layout-change event handler is bound to the old view. We should re-register the layout-change event with the new view.

In checkFileResolveMap or initStickyHeaderComponent, when updating an existing entry, we should also update the layoutChangeEvent to use the new view.

Let me look at the current else branch again:
```typescript
} else {
  const item = this.fileResolveMap.get(id);
  if (item) {
    item.editMode = isEditSourceMode(view);
    item.headings = headings;
    item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);
    item.file = file;
  }
}
```

It doesn't update item.view or item.layoutChangeEvent. We should update these.

Proposed changes in initStickyHeaderComponent else branch:
```typescript
} else {
  const item = this.fileResolveMap.get(id);
  if (item) {
    // Unregister old layout-change event
    if (item.layoutChangeEvent) {
      this.app.workspace.offref(item.layoutChangeEvent);
    }
    // Register new one with current view
    const layoutChangeEvent = this.app.workspace.on('layout-change', this.handleComponentUpdate.bind(this, view));
    this.registerEvent(layoutChangeEvent);
    
    item.editMode = isEditSourceMode(view);
    item.headings = headings;
    item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);
    item.file = file;
    item.view = view;
    item.layoutChangeEvent = layoutChangeEvent;
  }
}
```

And then add a file-open listener in onload.

Wait, but this is getting complex. Let me reconsider.

Maybe a simpler approach is: in handleComponentUpdate, instead of using the captured `view` parameter, look up the current view for the leaf id. But the function signature uses view. We could change it to take a leaf id or view, and always use the current view from fileResolveMap.

Actually, handleComponentUpdate uses `view` for:
1. `getScroller(view)`
2. `view?.leaf ?? {}` to get id
3. `retrieveHeadings(item.file, view)` - uses view
4. `isEditSourceMode(item.view)` - uses item.view
5. `item.headingEl.addStickyHeader(item.view, this.settings)` - uses item.view
6. `item.headingEl.updateEditMode(isEditSourceMode(item.view))`

If we always use item.view (which is updated in initStickyHeaderComponent), then the bound view parameter in layout-change handler doesn't matter as much. But getScroller(view) still uses the parameter.

Hmm, actually in the else branch, we update item.view, but handleComponentUpdate is called with the new view parameter from initStickyHeaderComponent. So that's fine.

The problem with the stale layoutChangeEvent is when layout-change fires later (not during init). The bound view is old, but fileResolveMap has new item.view. The function uses view parameter for getScroller and id, but item.view for other things. If getScroller(old view) returns a scroller, it might be the old scroller. Then it attaches scroll listener to old scroller. This is bad.

So we definitely need to update the layoutChangeEvent when the view changes.

Actually, let me think about whether the old layout-change event is automatically unregistered when the view is destroyed. Obsidian events registered via `this.app.workspace.on` persist until `offref`. They are not automatically removed when a view is destroyed. So yes, we need to manage this.

OK, let me formulate the fix more precisely:

1. Add `file-open` event listener in `onload()` that calls `checkFileResolveMap()` after a short delay.
2. In `initStickyHeaderComponent`, when updating an existing entry (else branch), also update `item.view` and re-register `item.layoutChangeEvent` with the new view.

But wait, there's a subtle issue with re-registering events. `this.registerEvent(layoutChangeEvent)` is used to auto-unregister on plugin unload. If we unregister and re-register, both old and new are tracked. But the old one was already unregistered via `offref`. So this is fine.

Actually, `this.registerEvent` adds to the plugin's registered events list. If we call offref, it's removed from Obsidian but maybe still in the plugin's list? I think `offref` also removes it from the plugin's internal list in Obsidian. Let me not worry about this.

Let me also think about the active-leaf-change handler. With file-open listener, when active leaf changes to a new file, file-open fires and checkFileResolveMap runs. The active-leaf-change handler with its 100ms delay also runs. Could be redundant but OK.

But the active-leaf-change handler has the `lastActiveLeafId` guard. If the same leaf opens a new file, it returns early. We need file-open for that case.

Actually, maybe we can simplify by replacing the active-leaf-change handler with file-open handler + keeping layout-change for cleanup. But the active-leaf-change handler also cleans up stale leaves when you close a leaf or switch to non-markdown. So we should keep it.

Wait, checkFileResolveMap is responsible for cleanup. It removes entries for leaves that no longer exist. This is called on active-leaf-change. If we also call it on file-open, it will also clean up. So maybe we don't need active-leaf-change for cleanup - file-open is enough? No, if you close a leaf or switch to a non-markdown view without opening a file, file-open might not fire, but active-leaf-change would. So keep active-leaf-change.

Actually, layout-change might also fire in those cases. But we already have active-leaf-change.

OK so final plan:
1. Add file-open listener.
2. Update existing entry in initStickyHeaderComponent to re-register layout-change with new view.

Let me now delegate this to a planner to confirm, then to builder.

Actually, this is a code debugging task. I should probably delegate to minion-planner for interpretation/confirmation, then minion-builder for implementation. But I've already done significant analysis. Let me still follow the workflow: planner first.

Actually, given that I've identified the likely root cause, I can spawn a planner to validate, then a builder. But maybe I can combine. The rules say Wave 1 Interpret is mandatory. But for bug fixes, I should get planner confirmation.

Let me spawn minion-planner with my analysis and ask for confirmation/fix plan.

</details>

I've identified a likely root cause. Let me validate the fix plan with a planner before implementation.

> 🛠️ **task** description=Validate sticky heading page change bug, subagent_type=minion-planner, ... (34 lines)


*Completed in 1m 35s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **task** description=Research Obsidian file-open event semantics, subagent_type=minion-researcher, ... (31 lines)


*Completed in 5m 49s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **read** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/research/f… (237 lines)


*Completed in 2.6s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **task** description=Plan page-change heading update fix, subagent_type=minion-planner, ... (139 lines)


*Completed in 1m 5s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

Plan is approved. Now I'll implement the fix.

> ❌ **todowrite** — The todowrite tool was called with invalid arguments: SchemaError(Missing key


*Completed in 2.6s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> ❌ **todowrite** — The todowrite tool was called with invalid arguments: SchemaError(Missing key


*Completed in 2.2s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> ❌ **todowrite** — The todowrite tool was called with invalid arguments: SchemaError(Expected string, got 1


*Completed in 2.4s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **todowrite** todos=[{"content":"Add workspace 'file-open' listener in plugin onload()","priority":"… (22 lines)


*Completed in 3.4s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **edit** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/src/plugin…, oldString=try { this.registerEvent( this.app.workspace.on('active-leaf-change', () => { co…, ... (1 lines)


*Completed in 10.8s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **edit** filePath=/Users/caffae/Local-Projects-2026/obsidian-sticky-headings-no-flicker/src/plugin…, oldString=} else { const item = this.fileResolveMap.get(id); if (item) { item.editMode = i…, ... (1 lines)


*Completed in 6.3s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **todowrite** todos=[{"content":"Add workspace 'file-open' listener in plugin onload()","priority":"… (22 lines)


*Completed in 2.7s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **bash** command=npm run build, description=Build the plugin, ... (5 lines)

> 🛠️ **bash** command=./sendToNovelVault.sh, description=Deploy plugin to test vaults, ... (6 lines)


*Completed in 4.4s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **todowrite** todos=[{"content":"Add workspace 'file-open' listener in plugin onload()","priority":"… (22 lines)


*Completed in 3.0s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **bash** command=npm run lint, description=Run linter on changes, ... (5 lines)


*Completed in 5.2s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **task** description=Analytic review of plugin fix, subagent_type=minion-reviewer-analytic, ... (29 lines)


*Completed in 1m 49s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **task** description=Deep review of plugin fix, subagent_type=reviewer, ... (119 lines)


*Completed in 2m 36s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **todowrite** todos=[{"content":"Add workspace 'file-open' listener in plugin onload()","priority":"… (22 lines)


*Completed in 3.0s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **bash** command=git status --short && git diff --stat, description=Check working tree changes, ... (5 lines)


*Completed in 2.7s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **bash** command=git add src/plugin.ts research/file-open-event-fix.md && git commit -m "FIX: upd…, description=Commit the fix and research doc, ... (4 lines)


*Completed in 6.5s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

> 🛠️ **bash** command=bunx critique --commit HEAD --web "FIX: update sticky headings when a new file o…, description=Generate diff URL for the fix commit, ... (10 lines)


*Completed in 7.6s*

### 🤖 Assistant (kimi-k2.7-code:cloud)

**Started using ollama-cloud/kimi-k2.7-code:cloud**

<callout accent="#3b82f6">
## Fix applied and deployed

- **Root cause:** The plugin only listened for `active-leaf-change`. When you opened a new file in the *same* pane (e.g. normal internal-link click), the leaf didn't change, so the sticky heading kept pointing at the old file's top heading.
- **Fix:** Added a `workspace.on('file-open', ...)` listener and hardened the same-leaf refresh path so it tears down and re-mounts the sticky header when the leaf's file changes.
</callout>

## What changed

1. **`src/plugin.ts` — new `file-open` listener**
   - Catches same-leaf file changes that `active-leaf-change` misses.
   - Guards: markdown file only, active MarkdownView exists, leaf already tracked, file actually changed, leaf still active after 100ms.
   - Defers to `checkFileResolveMap()` to keep behavior consistent with the existing `active-leaf-change` path.

2. **`src/plugin.ts` — hardened same-leaf re-init**
   - When `initStickyHeaderComponent()` sees an existing entry for the reused leaf, it now:
     - Removes the old sticky component and `layout-change` listener.
     - Removes the old scroll listener from the old scroller.
     - Updates `view`, `file`, `container`, `editMode`, `headings`, `getExpectedHeadings`, `currentIndex`, `resolveRevision`.
     - Creates a new `StickyHeaderComponent` and registers a fresh `layout-change` listener.

## Verification

- `npm run build` ✅
- `./sendToNovelVault.sh` ✅ (deployed to novel writing, journal, and zettelpublish vaults)
- `npm run lint` ✅
- Analytic + deep review both **approved** with no blocking issues.

## Try it in Obsidian

Reload the plugin (or restart Obsidian), then:

1. Open a note with headings and scroll so a heading is sticky.
2. Click an internal link that opens in the **same** pane.
3. The sticky heading should update to the new note's heading within ~100ms.

Diff: https://critique.work/v/b10f26f91e88cf29675cc0ed076ad7c5

Let me know if it still misbehaves — if so, a screen recording of the exact navigation would help.


*Completed in 6.7s*
