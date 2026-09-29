# Desktop sticky-header vertical drift with a fixed `desktopTopOffset`

**Date:** 2026-09-29
**Repo:** `obsidian-sticky-headings-no-flicker` (branch `master`, `d008756`)
**Question:** Why does the desktop sticky heading's vertical position change/drift even though `settings.desktopTopOffset` is fixed?
**Method:** Full static review of `src/plugin.ts`, `src/stickyHeader.ts`, `src/ui/StickyHeader.svelte`, `src/settings.ts`, `src/types.d.ts`, `styles.css`, the last 20 commits, the **shipped `main.js` bundle**, and **Obsidian 1.13.7's own `app.css`/`app.js`** (extracted from `obsidian.asar`), plus the deployed plugin + vault settings on this machine.

---

## TL;DR — the answer

The most likely cause is **not** the inline `top` value at all. The inline `top:${topOffset}px` is applied correctly and consistently. What moves is the **CSS containing block** that `top` resolves against.

The sticky root is `position: absolute`. Its containing block is whichever ancestor is positioned (`position != static`). On desktop:

- When the plugin's classes **`.sticky-headings-mount`** (on the mount target `view.editMode.editorEl` / `view.previewMode.containerEl`) and **`.has-sticky-headings`** (on `view.contentEl`) are present → the containing block is the editor/preview wrapper, which sits **below Obsidian's 40 px `.view-header`**. The bar appears at `desktopTopOffset` **from below the header**.
- When those classes are **absent** → the containing block falls back to `.workspace-leaf-content` (which Obsidian core gives `position: relative`), i.e. the **top of the whole pane, including the 40 px header**. The bar appears **~40 px higher**.

And the classes are stripped from a *live* header by a **teardown-after-mount ordering bug in the same-leaf re-init path**, which runs on **every `active-leaf-change`** (tab/leaf switch) and several other events. So the bar jumps/drifts ~40 px on desktop — exactly matching "fixed value in settings but position changes". On mobile there is effectively no `.view-header` gap, so the same bug is invisible → desktop-only, as reported.

Two line-level facts make it decisive:

1. `src/plugin.ts` builds the **new** `StickyHeaderComponent` *before* destroying the **old** one, and both share the same DOM target + `view.contentEl`:
   ```ts
   // plugin.ts:388 (else branch of initStickyHeaderComponent)
   const newHeadingEl = new StickyHeaderComponent(view, settings);   // adds classes to shared DOM
   ...
   item.headingEl?.removeStickyHeader?.();                           // removes those same classes
   item.headingEl = newHeadingEl;
   ```
2. `removeStickyHeader()` removes the classes unconditionally from the shared nodes — there is **no ref-count / ownership check**:
   ```ts
   // stickyHeader.ts:159
   this.mountTargets.forEach(target => target.removeClass('sticky-headings-mount'));
   ...
   this.lastView.contentEl.removeClass('has-sticky-headings');   // stickyHeader.ts:169
   ```

Net effect: the *new* component (the one now rendering) has its positioning context deleted by the *old* component's teardown. The remount guard then **cannot detect or repair this**, because it checks DOM-target identity, not class presence (see "Why it never self-heals" below).

---

## 1. How the position actually resolves (evidence)

### 1.1 The absolute containing-block chain

`src/ui/StickyHeader.svelte`:

```svelte
<div class="sticky-headings-root ..." style={rootStyles} />   <!-- position:absolute; top:Npx; left:Npx -->
```

`styles.css`:

```css
.markdown-source-view.sticky-headings-mount,
.markdown-preview-view.sticky-headings-mount,
.markdown-reading-view.sticky-headings-mount,
.sticky-headings-mount { position: relative; }

.has-sticky-headings { position: relative; }
```

Mount target (from Obsidian internals, `app.js`):

```
editorEl = n.createDiv("markdown-source-view cm-s-obsidian mod-cm6")          // edit / live preview
containerEl = t.contentEl.createDiv("markdown-reading-view")                   // reading / preview
```

Obsidian 1.13.7 `app.css`:
- `.workspace-leaf-content { width:100%; height:100%; overflow:hidden; position:relative; display:flex; flex-direction:column; }` (line ~6530)
- `.view-header { height: var(--header-height); ... }` and `--header-height: 40px`
- `.view-content { width:100%; height:calc(100% - var(--header-height)); }` — **no `position`**
- `.markdown-preview-view { ... position: relative ... }` — but the mount target is `.markdown-reading-view`, which core does **not** position.
- `.markdown-source-view` — core does **not** set `position` (checked; only the plugin's `.sticky-headings-mount` does).
- CM6 sets `.cm-editor { position: relative !important }`, but `.cm-editor` is a *descendant* of the mount target, not an ancestor, so it is irrelevant to the sticky root's containing block.

So the two candidate containing blocks for `.sticky-headings-root` are:

| Class state | Containing block | Bar's visual origin |
|---|---|---|
| `.sticky-headings-mount` present | `view.editMode.editorEl` (`.markdown-source-view`) or `view.previewMode.containerEl` (`.markdown-reading-view`) | top of editor content area, **below** the 40 px `.view-header` |
| class absent | `.workspace-leaf-content` (`position:relative`) | top of the whole leaf, **including** the header |

Delta ≈ **40 px** (`--header-height`), i.e. exactly the kind of "the bar moved" a user notices while the slider value is unchanged.

> This also answers the "desktop vs mobile containing block" bullet in the question: the visible delta comes from the desktop `.view-header`. Obsidian's rule `body:not(.show-view-header):not(.is-phone) .view-header { display:none; }` means the gap is ~0 whenever there is no view header (typical mobile / hidden-header setups), so the class-strip bug is effectively desktop-only.

### 1.2 The classes are shared, per-view singletons with no ownership

- `mountTargetsInternal()` adds the class to the DOM node but stores no owner:
  ```ts
  // stickyHeader.ts:126-129
  this.stickyHeaderComponents = components;
  this.mountTargets = targets;
  targets.forEach(target => target.addClass('sticky-headings-mount'));
  view.contentEl.addClass('has-sticky-headings');
  ```
- `removeStickyHeader()` removes it unconditionally (above).
- If two live component instances ever point at the same target/contentEl, tearing one down strips the class from the other. That is precisely what the same-leaf re-init else-branch does.

### 1.3 The bug fires on ordinary desktop actions

`checkFileResolveMap()` (called from `active-leaf-change` after a 100 ms debounce, from `file-open`, and from `handleResolve`→`load`) iterates **all** markdown leaves and calls `initStickyHeaderComponent(leaf.view)`. For any leaf already in `fileResolveMap`, that takes the **else branch** — the one with the ordering bug — *even when the file has not changed*:

```ts
// plugin.ts:383-433 (else branch)  — runs whenever fileResolveMap.has(id)
const newHeadingEl = new StickyHeaderComponent(view, settings); // mounts + adds classes
...
item.headingEl?.removeStickyHeader?.();                          // strips classes from shared DOM
...
item.headingEl = newHeadingEl;
```

So the trigger list is:
- **Switch tab / focus another leaf** → `active-leaf-change` → `checkFileResolveMap()` → class strip on the active leaf's live header.
- **Open another note in the same leaf** → `file-open` → same path.
- **Edit a note so metadata re-resolves** → `metadataCache.on('resolve')` → `handleResolve` → `checkFileResolveMap()`.
- Background leaves are also rebuilt, so any of the above can churn their classes too.

The `handleUpdateInFlight`/`retryTimer`/watchdog logic does not gate this path.

### 1.4 Why it never self-heals (this is why it "drifts" rather than flashes once)

`handleComponentUpdate()`'s remount guard is:

```ts
// plugin.ts:525-531
const currentTargets = resolveMountContainers(item.view);
const needsRemount =
  !item.headingEl.stickyHeaderComponents?.length ||
  (currentTargets.length > 0 && !item.headingEl.hasMountTargetFor(item.view));
if (needsRemount) item.headingEl.addStickyHeader(item.view, this.settings);
```

After the else-branch, `newHeadingEl.mountTargets` **is** the current target, so `hasMountTargetFor(view)` returns `true` and `stickyHeaderComponents.length === 1`. Therefore `needsRemount === false` → `addStickyHeader` is **not** called → the stripped classes are **never re-added**. The guard tests *target identity*, not *class presence*, so it is blind to the very corruption that matters.

Because `removeStickyHeader` itself is the only thing that re-adds the classes (via `addStickyHeader` → `mountTargetsInternal`), and nothing forces a fresh mount, the bar stays in the wrong containing block until something genuinely changes identity (a preview↔source mode switch, or plugin reload).

### 1.5 Secondary churn source with the same signature

`mountTargetsInternal()` is also called **directly** by `scheduleMountRetry()` (it does not go through `addStickyHeader`, so it does not tear down first):

```ts
// stickyHeader.ts:80 / 91
this.mountTargetsInternal(view, settings, targets);
```

If a retry resolves while components already exist, it **overwrites `this.stickyHeaderComponents`/`this.mountTargets` without `$destroy()`-ing the old ones**. The orphaned Svelte roots remain in the DOM, and the new `this.mountTargets` no longer references the old nodes, so a later `removeStickyHeader()` cannot clean them. This can leave duplicate `.sticky-headings-root` elements in the same target and can make `getContainerEl()` (which does `querySelector('.sticky-headings-root')`, returning the *first* match) measure/report the wrong element. Retries are logged (`[sticky-headings] mount target missing, retry`) and are common on desktop during layout changes.

---

## 2. Other candidate contributors (ranked, with verdicts)

### 2.1 `settings` staleness / reactivity — **not the cause of drift, but worth hardening**

`settings` is replaced (never mutated) by `settings.ts:update()` and `plugin.ts:onSettingChanged()` forwards the new object to every mounted component via `updateSettings()` → `$set({ settings })`. Svelte's `$:` for `rootStyles` depends on `settings`, so a new reference re-runs it. No staleness path was found that would produce *dynamic* drift for an unchanged setting.

One latent issue: `initStickyHeaderComponent()` captures `const settings = this.settings` **before** `await retrieveHeadings(...)` (plugin.ts:361-363). If a settings change happens during that await, a *newly created* entry can be constructed with the older object; `onSettingChanged` may have already run over the existing `fileResolveMap` before the new entry was inserted, so that entry would not receive the newer object until the next settings change. This is a real but narrow race; it would show as "the last setting edit didn't apply to a freshly opened note", not as repeated drift.

### 2.2 The shadow element (`sticky-headings-shadow`) — **not the cause**

The shadow div gets `style={rootStyles}` and is `position:absolute; opacity:0; pointer-events:none`. Being out of flow it does not displace the visible root, so it cannot move the bar. Two caveats:
- It is a *second* `.sticky-headings-root` in the DOM; `getContainerEl()` may select it when the real root is hidden, feeding a wrong `stuckHeaderHeight` into `setHeadingsInView()` (affects *which* headings show, not the CSS `top`).
- If a retry ever leaves orphaned roots (§1.5), `querySelector` can pick a stale shadow, again affecting height math, not the bar's `top`.

### 2.3 Throttled scroll updates / remount logic — **the remount logic is the problem, scroll throttling is not**

`detectPosition` (throttle 50 ms) only calls `setHeadingsInView()`; it never writes `top` or classes. The remount logic is the locus of the bug (§1.3-1.5). `animateScroll` writes `scrollTop`, never CSS `top`.

### 2.4 `padding-top: var(--sticky-header-verticle-offset)` and `--sticky-header-*` CSS vars — **one-time shifts, not drift**

`padding-top` moves content *inside* the bar; the comment in `styles.css` now says so explicitly. The recent commits `5b1a278`/`d008756` removed `--sticky-header-desktop-top-offset` / `--sticky-header-mobile-top-offset` from `styles.css` and from the scoped `<style>`. Consequence: any user who had previously set those via the **Style Settings** plugin silently loses that contribution (one-time position change, not continuous drift). Note the shipped `main.js` **matches** the source (verified by md5: `5ff12de84a7474c3d2e9dcb0ad202dd3`, identical across repo + deployed copies), so the user is running the new code.

### 2.5 A theme or community snippet overriding `top` — **confirmed present on this machine, and a real alternative explanation**

Vault `ZettelPublish (Content Creator V2 April 2025)` has an enabled snippet `Note Toolbar x Another Sticky Heading Conflict Fix.css`:

```css
.markdown-source-view.mod-cm6 .sticky-headings-root { top: 35px !important; }
```

An `!important` rule beats the inline style. If the user is in that vault (or copies that snippet elsewhere), the *effective* top is a constant 35 px, and any change to the class/containing-block state adds another visible jump on top. Also relevant: `note-toolbar` is enabled in all four vaults, and the snippet was created specifically because it fights the sticky header. This is worth ruling out first because it is a 5-second check in DevTools.

### 2.6 Obsidian UI changes (properties collapse, inline-title toggle, view-header show/hide) — **plausible amplifiers**

`showViewHeader` is `true` in the user's vaults with the fork. Toggling it (or collapsing properties) changes the gap between the content area and the leaf top, i.e. changes the size of the containing-block delta. That makes the *same* class-strip bug produce a different jump. It cannot, by itself, move the bar while nothing changes.

### 2.7 `left` offset — **horizontal only**

`left:${leftOffset}px` was added in `05f581b`. It shifts horizontally; with `width: fit-content` + `padding: 0 var(--file-margins)` it does not move the bar vertically. Mentioned only to exclude it.

---

## 3. What to instrument (5-minute triage in DevTools)

Run these on the desktop app with the note open, then switch tabs and re-run. Use the console's context = the app window.

1. **Containing block + effective top:**
   ```js
   const el = document.querySelector('.markdown-source-view .sticky-headings-root')
           || document.querySelector('.markdown-reading-view .sticky-headings-root');
   const cs = getComputedStyle(el);
   console.log({
     inlineTop: el.style.top,
     computedTop: cs.top,
     offsetParent: el.offsetParent?.className,
     rectTop: el.getBoundingClientRect().top,
     mountClass: el.parentElement?.className,
     viewContentClass: el.closest('.view-content')?.className,
   });
   ```
   Expect `offsetParent` to flip between the editor wrapper and `.workspace-leaf-content`, and `rectTop` to move by ~40 px when you switch tabs.

2. **Class-strip proof (MutationObserver):**
   ```js
   const viewContent = document.querySelector('.workspace-leaf-content[data-type="markdown"] .view-content');
   const target = viewContent.querySelector('.markdown-source-view, .markdown-reading-view');
   new MutationObserver(ms => ms.forEach(m =>
     console.log(new Date().toISOString(), m.target.className)))
     .observe(target, { attributes: true, attributeFilter: ['class'] });
   new MutationObserver(ms => ms.forEach(m =>
     console.log('contentEl', m.target.className)))
     .observe(viewContent, { attributes: true, attributeFilter: ['class'] });
   ```
   Then switch tabs. If you see `... sticky-headings-mount` added then immediately removed while a `.sticky-headings-root` remains, the mechanism in §1.3 is confirmed.

3. **Rule out `!important` snippets/themes:**
   ```js
   [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } })
     .filter(r => r.cssText && r.cssText.includes('sticky-headings-root') && r.cssText.includes('!important'))
     .map(r => r.cssText);
   ```
   Any hit (e.g. the Note Toolbar fix) explains a constant offset that stacks with the containing-block jump.

4. **Orphaned roots / retries:** `document.querySelectorAll('.sticky-headings-root').length` — more than 2 per view indicates §1.5. Also watch for the `[sticky-headings] mount target missing, retry` and `scroller retry` warnings with the diagnostics gate on (`document.body.dataset.stickyHeadingsDebug = '1'`).

---

## 4. Recommended fixes

### Fix A (primary): stop the teardown from stripping the classes of a live component

Cheapest correct change — re-assert ownership **after** the swap in the else branch:

```ts
// src/plugin.ts, in the else branch of initStickyHeaderComponent, after:
item.headingEl = newHeadingEl;
item.layoutChangeEvent = newLayoutChange;
this.registerEvent(newLayoutChange);

// NEW: the old component's removeStickyHeader() stripped classes that the new
// component just added (shared DOM nodes). Re-assert them.
newHeadingEl.reassertMountClasses?.();
```

```ts
// src/stickyHeader.ts
reassertMountClasses() {
  this.mountTargets.forEach(target => target.addClass('sticky-headings-mount'));
  this.lastView?.contentEl.addClass('has-sticky-headings');
}
```

Better still: make `removeStickyHeader()` not clobber a live sibling by only removing classes if it still owns the nodes. Simplest robust form is to **tear down the old component before constructing the new one** in the else branch, or add an owner token:

```ts
// stickyHeader.ts — module-level ownership set
const mountOwners = new WeakMap<HTMLElement, number>();
// add: mountOwners.set(t, (mountOwners.get(t) ?? 0) + 1)
// remove: if (--count <= 0) t.removeClass('sticky-headings-mount')
```

### Fix B (defensive): make the remount guard detect the stripped context

Teach the guard that a mismatched positioning context also requires a remount:

```ts
// plugin.ts handleComponentUpdate
const target = currentTargets[0];
const contextOk = !!target?.classList.contains('sticky-headings-mount')
  && !!item.view.contentEl.classList.contains('has-sticky-headings');
const needsRemount =
  !item.headingEl.stickyHeaderComponents?.length ||
  (currentTargets.length > 0 && (!item.headingEl.hasMountTargetFor(item.view) || !contextOk));
```

This also self-heals any state produced by Fix A or by retry orphaning.

### Fix C: make `mountTargetsInternal()` destroy prior components when called directly

`scheduleMountRetry()` calls it without teardown. Guard it:

```ts
private mountTargetsInternal(view, settings, targets) {
  if (this.stickyHeaderComponents.length) this.removeStickyHeader(); // or destroy + clear only components
  ...
}
```

(Watch for recursion: `addStickyHeader` already calls `removeStickyHeader` then `mountTargetsInternal`; the extra guard must be a no-op in that path.)

### Fix D: don't rely on `.sticky-headings-mount` for the containing block at all

The most robust structural fix (and closest to what `112345brian/return-headings` does) is to **explicitly position the wrapper you mount into**, and verify it, rather than depend on a class that a teardown can strip:

- On mount, set an inline `position: relative` (or a dedicated attribute) on the resolved target, and remove it only when the *last* live component for that target is destroyed (ref-count).
- Alternatively mount into the **non-scrolling outer wrapper** and let the inner scroller scroll beneath it, which is decoupled from class churn.

### Fix E: harden the settings capture

Move `const settings = this.settings` to *after* the `await retrieveHeadings(...)` (or re-read `this.settings` immediately before constructing `newHeadingEl`) so a settings change during the await cannot produce a stale-mounted component.

### Fix F: decide precedence between the plugin offset and any legacy CSS var

If you want to keep supporting users who set `--sticky-header-verticle-offset` (and the removed desktop/mobile vars), document that the inline `top` wins and that removed vars no longer apply; otherwise a one-time position change on upgrade will be reported as a regression.

---

## 5. Which explanation is "the" one? (confidence)

| Hypothesis | Confidence | Why |
|---|---|---|
| Class-strip → containing block moves ~40 px (desktop) | **High** | Reproduced by code inspection at `plugin.ts:388-430` + `stickyHeader.ts:159-169`; trigger events are ordinary desktop actions; magnitude matches `--header-height: 40px`; explains desktop-only. |
| Retry path orphans components/roots, confusing `getContainerEl`/height math | **Medium** | `scheduleMountRetry` → `mountTargetsInternal` bypasses teardown; direct code path, but effect is on heading selection/height more than CSS `top`. |
| `!important` snippet (Note Toolbar fix) or theme override | **Medium (environment-specific)** | Confirmed present in one of the user's vaults; must be ruled out first because it is trivially checkable and stacks with the above. |
| Settings staleness over the `await` | **Low-Medium** | Real race, narrow window, produces "setting didn't apply", not repeated drift. |
| Shadow element moving the bar | **Low** | Out of flow (`position:absolute`, `opacity:0`); cannot displace the visible root. |
| `padding-top` / removed CSS vars | **Low (one-time)** | Moves interior padding or removes a previously-set offset once; not dynamic drift. |

Recommended order of action: (1) run the §3 DevTools checks to confirm the class flip and rule out `!important`; (2) apply Fix A + Fix B; (3) add Fix C/D as hardening; (4) add a regression test that asserts `.sticky-headings-mount` and `has-sticky-headings` remain present after an `active-leaf-change` re-init.

---

## 6. Supporting artefacts on this machine

- Shipped bundle == source: repo `main.js` md5 `5ff12de84a7474c3d2e9dcb0ad202dd3`, identical in `~/Notes/Journal/.../plugins/sticky-headings-no-flicker/main.js` (so the report is about the code under review, not a stale build).
- User's real config: `~/Notes/Novel-Writing/.obsidian/plugins/sticky-headings-no-flicker/data.json` → `desktopTopOffset: 36`, `mobileTopOffset: 36`, `theme: flat`, `mode: concise`; `appearance.json` → `showViewHeader: true` (so the 40 px header gap is live).
- Conflicting snippet: `~/Notes/ZettelPublish (Content Creator V2 April 2025)/.obsidian/snippets/Note Toolbar x Another Sticky Heading Conflict Fix.css` (`top: 35px !important`), enabled in that vault; `note-toolbar` enabled in all four vaults.
- Obsidian core CSS/JS inspected: `/Applications/Obsidian.app/Contents/Resources/obsidian.asar` (v1.13.7), extracted to `/tmp/obs-asar`.

## Source URLs

- Repo files: https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/stickyHeader.ts
- Upstream `StickyHeader.svelte`: https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/ui/StickyHeader.svelte
- Upstream mode-separate mounts (PR #30): https://github.com/zhouhua/obsidian-sticky-headings/pull/30
- Upstream issue #21 (padding recalculating at a scroll point): https://github.com/zhouhua/obsidian-sticky-headings/issues/21
- Upstream issue #20 (programmatic padding shifting as you scroll): https://github.com/zhouhua/obsidian-sticky-headings/issues/20
- Upstream issue #48 (left-gap / note leak): https://github.com/zhouhua/obsidian-sticky-headings/issues/48
- MDN containing block (absolute → nearest positioned ancestor): https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_display/Containing_block
- MDN stacking context (transform/filter/contain create containing blocks): https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_positioned_layout/Understanding_z-index/Stacking_context
- Svelte 4 reactive `$:` assignment semantics: https://svelte.dev/docs/svelte/legacy-reactive-assignments
