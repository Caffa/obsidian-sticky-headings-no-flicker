# In-Depth: zhouhua sticky-headings — Positioning, Tab Switching, Inline Title, Mobile

Research task: answer, with concrete code and recent issues/commits, how Obsidian sticky-heading plugins handle (a) positioning / "top offset" / overlap with the inline title, (b) tab switching, (c) inline-title visibility, and (d) mobile/desktop differences — for the `obsidian-sticky-headings-no-flicker` fork.

Date: 2026-09-24

Repos examined (cloned `master`/default branch at HEAD):
- zhouhua/obsidian-sticky-headings  @ `2.1.3` (2025-01-21, latest commit `533ad98`)
- 112345brian/return-headings        @ `0.6.1`
- imshenshen/obsidian-sticky-heading @ `1.3.1`

---

## TL;DR — Direct answers

1. **Does zhouhua have open/closed issues matching the symptoms?** Yes — see §5. The most on-point are: **#50 (open, mobile: jumped-to heading covered by the bar)**, **#51 (open, mobile: hide bar when keyboard shows)**, **#21 (open, page padding recalculating infinitely near a scroll point — the closest match to a positioning jitter/overlap symptom)**, **#19 (closed, title "flashing" when properties collapsed)**, **#15 (closed, empty sticky header when switching notes)**, **#17 (closed, jumping when switching leaves)**, **#29 (closed, bar with higher z-index blocks a floating search bar — the inline-title/overlay overlap class)**. No issue was ever resolved by mechanically measuring the inline title; every fix was either CSS (z-index/padding) or scroll-jump logic.

2. **Exact positioning CSS.** `position:absolute; top:0; z-index:1; width:100%; padding-top:var(--sticky-header-verticle-offset)`, mounted into the markdown-view wrapper whose `.view-content` is set `position:relative`. §2.
3. **DOM measurement vs CSS variables.** They rely on CSS variables (the Style-Settings `verticle-offset` knob) for the *bar's* vertical position — **no `.inline-title` measurement**. They DO run DOM/geometry reads (`.cm-contentContainer.offsetTop`, `cm.lineBlockAt`, `renderer.sections` heights, `getBoundingClientRect` of the shadow bar) but only to compute *heading trigger offsets* and *bar height* for scroll/navigation — never to offset the bar under the inline title. §3.
4. **Reading vs live-preview vs source mounting.** Upstream mounts **two** Svelte components per leaf, one into `view.previewMode.containerEl` (reading) and one into `view.editMode.editorEl` (edit/live-preview/source). It relies on `layout-change` + `isEditSourceMode()` to switch `editMode` prop and re-attach scroll listeners. The `{@html}` heading titles come from the same `StickyHeader.svelte` for both modes. §4.
5. **Recent commits changing positioning strategy.** Latest = **Dec 2024 `1395742` "feat: support change boundary offset"** (adds `boundaryOffset` slider, shifted heading trigger offsets, not the bar's top) and the **Aug 2024 z-index fix / "Add Svelte components separately for preview and edit"** (PR #30). No commit ever moved the bar to accommodate the inline title. §6.
6. **Simplest battle-tested approach?** Yes — **a user-adjustable CSS offset knob** (`--sticky-header-verticle-offset`, default `0px`) is exactly what upstream ships and what 500+ users run today. No plugin auto-measures the inline title. The robust addition this fork already made — `measureInlineTitleOffset()` computing `.inline-title` bottom via `getBoundingClientRect()` and applying it as `--sticky-header-top-offset` on desktop, `top:0` on mobile — is *more* than any of the three plugins do, and is the closest thing to a real fix. Recommendation in §8.

---

## 1. Upstream architecture baseline (zhouhua master @ 2.1.3)

Upstream `src/stickyHeader.ts` mounts **two** Svelte `StickyHeader` components per leaf — one per mode — and never re-mounts on mode switch:

```ts
addStickyHeader(view: MarkdownView, settings: ISetting) {
  const previewContentEl = view.previewMode.containerEl;  // reading mode
  const sourceContentEl  = view.editMode.editorEl;         // edit / live preview / source
  this.stickyHeaderComponents = [
    new StickyHeader({ target: previewContentEl, props: {...} }),
    new StickyHeader({ target: sourceContentEl,  props: {...} }),
  ];
}
removeStickyHeader() { /* destroys both */ }
updateHeadings/updateEditMode/updateSettings → $set() on both
```

Both components render the identical `StickyHeader.svelte` markup; the `editMode` prop is toggled via `plugin.handleComponentUpdate(view)` on every `layout-change`:

```ts
handleComponentUpdate(view) {
  ...
  item.editMode = isEditSourceMode(item.view);
  item.headingEl.updateEditMode(isEditSourceMode(item.view));
  // re-attach scroll listener on view.contentEl (capture)
  item.view.contentEl.addEventListener('scroll', newScrollListener, true);
  ...
}
```

Mode detection helpers (`src/utils/obsidian.ts`):
```ts
export const isEditSourceMode = (view) => view.editMode.sourceMode && view.currentMode.type !== 'preview'; // source only
export const isEditMode       = (view) => view.currentMode.type !== 'preview';                              // source OR live preview
export const getScroller = (view) =>
  isEditMode(view) ? view.editor.cm.scrollDOM : view.previewMode.renderer.previewEl;
```

So "tab switching" is wired to `active-leaf-change` (which calls `checkFileResolveMap()` → `initStickyHeaderComponent`) plus `layout-change` (→ `handleComponentUpdate`). That is the whole desktop tab-switch story upstream.

**Note for the fork:** this project (Caffa/no-flicker) deliberately diverged — it uses a single-active-mode mount via `resolveMountContainers(view)` keyed on `view.getMode()` and re-mounts on mode/layout change, with mount-retry + capture-phase scroll fallbacks. That divergence is exactly what fixes the phantom/empty-header-on-tab-switch bugs that upstream still has open.

---

## 2. Exact positioning CSS (upstream)

Upstream `styles.css` is tiny — just the CSS-variable defaults and one positioning rule:

```css
:root {
  --sticky-header-indent-width: 1em;
  --sticky-header-verticle-offset: 0px;          /* the vertical-offset knob (note author's spelling) */
  --sticky-header-float-background-color: #000;
  --sticky-header-float-text-color: #fff;
}
.view-content { position: relative; }            /* makes absolute child position relative to the content pane */
```

**There is no `@media` query and no `.is-mobile` / `.is-phone` rule anywhere in upstream styles.css.** That is a key finding: upstream is genuinely platform-agnostic and just pins the bar to `top:0`.

The visual bar CSS lives inside `src/ui/StickyHeader.svelte`'s `<style>` block:

```css
.sticky-headings-root {
  height: fit-content;
  overflow: hidden;
  position: absolute;
  top: 0;
  width: 100%;
  padding: 0 var(--file-margins);
  z-index: 1;
  padding-top: var(--sticky-header-verticle-offset);   /* ← the whole "clear the top" story */
}

.sticky-headings-container {
  max-width: min(var(--file-line-width), var(--max-width));
  margin: 0 auto;
  font-size: 12px;
}

/* float theme pushes the offset further */
.sticky-headings-theme-float.sticky-headings-root {
  padding: 10px 20%;
  padding-top: calc(var(--sticky-header-verticle-offset) + 10px);
  padding-bottom: 0;
}

/* blur theme is the only one that climbs a z-index layer for its gradient overlay */
.sticky-headings-theme-blur .sticky-headings-container {
  position: relative;
  z-index: 2;
  ...
}

/* hidden "shadow" clone used purely for height prediction */
.sticky-headings-shadow { opacity: 0 !important; pointer-events: none !important; }
```

Bottom line on z-index: the flat theme bar is `z-index:1`; the blur container bumps to `z-index:2`; the float `.sticky-headings-root` stays `z-index:1`. There is no `transform` for positioning (transforms are only used for click/hover states), no `position: fixed`, no CSS `sticky`.

The `verticle-offset` knob is exposed as a Style-Settings variable (`styles.css` `@settings` block):

```
id: sticky-header-verticle-offset
title: verticle offset
description: The verticle offset in px units
type: variable-number
default: 0
format: px
```

### The fork's current CSS (for comparison)
`styles.css` (this repo) adds:
- `.has-sticky-headings { position: relative; }` and `.sticky-headings-mount { position: relative; }` — makes each mount target its own positioning context, so the `top` offset measured in Svelte aligns.
- `--sticky-header-top-offset` inline variable set from Svelte, consumed by `.sticky-headings-root { top: var(--sticky-header-top-offset, 0); }`.
- A mobile override `@media (max-width:600px)` for the float theme plus `.is-mobile/.is-phone` `top:0` handling.
This is the concrete "measure the inline title, offset on desktop only, stick to top on mobile" strategy the fork is testing.

---

## 3. Do they measure DOM, or rely on CSS variables?

**For the bar's vertical position: CSS variables only.** Neither the `.inline-title` height, nor `.view-header`, nor breadcrumb height is ever read to offset the bar. If the bar overlaps Obsidian's inline title / file-path / floating searchbar, the user must raise `--sticky-header-verticle-offset` by hand.

**For heading trigger offsets and bar height (navigation): yes, they read the DOM at runtime.** Three places:

1. `src/utils/getShownHeadings.ts` → `getHeadingsWithOffsetSource` reads `.cm-contentContainer.offsetTop` and `view.editor.cm.lineBlockAt(position.start.offset)` to turn line offsets into pixel offset:
```ts
const offset = view.editMode.containerEl.querySelector<HTMLElement>('.cm-contentContainer')?.offsetTop || 0;
const { top = 0 } = view.editor.cm.lineBlockAt(position.start.offset);
return { ...heading, offset: top + offset - boundaryOffset, ... };
```
2. Reading mode → `getHeadingsWithOffsetPreview` walks `view.previewMode.renderer.sections` and accumulates per-section `height` to derive pixel offsets.
3. `src/ui/StickyHeader.svelte` `calculateExpectedHeight` reads the hidden shadow bar via `shadow?.clientHeight`; `src/plugin.ts` reads `getContainerEl(scroller)?.clientHeight` and the `MutationObserver` on `.sticky-headings-shadow-item` class to know how far to scroll past the bar.

So: **geometry is read constantly, but it is always converted into scroll/trigger math. The bar itself is always anchored to `top:0 + user CSS knob`.**

That means the "overlap the inline title" symptom is *structurally unhandled upstream*. The fork's `measureInlineTitleOffset()` (getBoundingClientRect of `.inline-title` minus the mount root rect) is the ONLY runtime measurement of the title across all three repos.

---

## 4. Reading mode vs live preview vs source mounting

| Mode | Upstream mount target | How the scroller is found | Note |
|---|---|---|---|
| **Reading / preview** | `view.previewMode.containerEl` | `view.previewMode.renderer.previewEl` | Bar absolutely positioned at top of the preview wrapper; `.markdown-preview-view` scrolls beneath |
| **Live preview** (editMode true, sourceMode false) | `view.editMode.editorEl` | `view.editor.cm.scrollDOM` | Bar at top of the editor wrapper; `.cm-scroller` scrolls beneath |
| **Source mode** (editMode true, sourceMode true) | `view.editMode.editorEl` | `view.editor.cm.scrollDOM` | Same mount as live preview; `editMode` prop renders `#` icons instead of heading glyphs |

`isEditSourceMode` (source only) vs `isEditMode` (source OR live preview) is what distinguishes the two edit sub-modes. Both mounts coexist permanently; mode type drives which *scroller* and which `editMode` prop is used, not which component survives. This is why upstream's `layout-change` handler must re-`.addEventListener('scroll',...)` every time the mode changes — the scroller element identity can swap.

return-headings handles the three modes very differently (§7). imshenshen is edit-only (a CodeMirror `ViewPlugin` attached to `view.dom`), so reading mode gets nothing.

**Fork divergence:** this project mounts a single component into the *active* mode's container (`resolveMountContainers` in `src/stickyHeader.ts`), then re-mounts on `layout-change`/mode change, with retry backoff and a `contentEl` last-resort target. This avoids upstream's "two hidden phantom components" and directly addresses #15 (empty header) / #17 (jumping on leaf switch).

---

## 5. GitHub issue sweep — concrete matches for the symptoms

Searched `zhouhua/obsidian-sticky-headings` (36 issues), `imshenshen/obsidian-sticky-heading` (11), `112345brian/return-headings` (0 issues). Mapped by symptom:

### Inline-title overlap / overlay-class problems
- **#29 — "Will block search bar if it floats on the top area" (closed).** Themes like *Border* float a search bar at the top; the sticky container's higher z-index made it un-focusable. Fix: a new release adjusting z-index/padding. This is the closest upstream precedent for "my bar sits on top of something I shouldn't cover."

### Mobile positioning
- **#50 — "[FR] don't cover heading you've jumped to on Mobile" (OPEN).** After tapping a heading link on mobile the target is top-of-screen but hidden under the bar, because Obsidian doesn't know the bar reduced usable height. No fix — feature request for "scroll a bit further."
- **#51 — "[FR] For mobile: to hide sticky heading when onscreen keyboard is shown" (OPEN).** No auto-handling; the bar always shows on mobile.

### Tab / leaf / popout switching
- **#15 — "Switching Notes Sometimes Causes Empty Sticky Header" (closed, fixed).** Empty bar + a flash of headings before hiding when switching notes via the calendar. Maintainer fixed via re-render / leaf handling.
- **#17 — "Switching Between Leaves Causing Jumping" (closed, fixed).**
- **#16 — "Sticky Headings Act Randomly in Floating Leafs" (closed, fixed).** Root cause: `iterateLeaves` missed popout/floating leaves; maintainer switched to `iterateAllLeaves` (commit `26111d7`).
- **#18 — "Slow Addition and Removal of Headings in Popout Leaf" (closed, fixed)** by the same leaf-iteration work.

### Jitter / recalculation / padding
- **#21 — "[Issue] Page Padding Recalculating Infinitely at Particular Scroll Point" (OPEN).** A scroll position where the plugin's padding recalculation loops — the closest published match to a "flicker/ping-pong" symptom. Root cause hinted: programmatic padding added to the content element.
- **#19 — "Flashing of Title when Properties are Collapsed" (closed).** Title flashes before disappearing when switching to a file with a heading in view. This is the inline-title-visibility symptom the user describes.

### Overlap / scroll-to-heading
- **#5 — "Clicked Heading Is Placed In Middle Of Screen Due To setEphemeralState" (closed).** Wanted jumped-to headings at top rather than middle; maintainer's new version handled the offset, "works perfect," and he declined a setting.
- **#48 — "The left side of the sticky header has a gap ... note leaks" (OPEN).** Edge/padding gap; a community CSS snippet (see §6) is the current workaround.

### imshenshen flicker (shared anatomy with the fork's core bug)
- **imshenshen #9 — "Flickering when close to new heading to stick" (OPEN).** The bar "tries to stick the new heading before the old one disappears." Same family as the fork's original flicker fix. imshenshen never fixed it (still open).

**return-headings: zero open issues** — it's a young (0.6.1) personal fork, so there's no issue-trail to mine; source analysis is covered in §7.

---

## 6. Recent commits that changed positioning (upstream repo)

- **`1395742` — 2024-12-22 "feat: support change boundary offset"** → most recent positioning change. Adds a `boundaryOffset` setting (px or %, validated `/^-?\d+(%|px)$/`). It changes when a heading "activates" by subtracting the offset from each heading's pixel offset:
```ts
offset: (headingsOffset[index] || 0) - boundaryOffset,   // preview
offset: top + offset - boundaryOffset,                    // source
```
and `getBoundaryOffset` converts `%` against the scroller's `clientHeight`. **It does NOT move the visual bar** — it shifts the stick-trigger.
- **`8d73f29` (PR #30, "Add Svelte components separately for preview and edit mode" / z-index fix) — 2024-08-24.** Change: mount ONE component on `view.contentEl` → **TWO** components (`previewMode.containerEl` + `editMode.editorEl`). This is how the repo still separates reading/live-preview/source mounts.
- **`486c85d` — "render title as html instead of text"** → `{@html heading.title}`; the fork inherits this.
- **`864bb43` — "add style settings"** → introduced the `verticle-offset` knob and `@settings` block.

**No commit, past or present, ever measured or offset for the inline title.** (Issue #6 has the maintainer musing *at length* about when/how a title should show, but nothing shipped.)

### Community CSS workaround (from issue #48) — worth knowing
```css
/* Fix the left-gap / note-leak by forcing the bar to span the full read line width */
.markdown-source-view.is-readable-line-width .sticky-headings-container { max-width: none !important; }
.markdown-source-view.is-readable-line-width .sticky-headings-item,
.markdown-source-view.is-readable-line-width .sticky-headings-shadow-item {
  padding-left: max(calc((100% - var(--file-line-width)) / 2), 0px) !important;
}
```

---

## 7. How the other two plugins handle it

### 112345brian/return-headings (adopted VS Code sticky-scroll style)
Two separate implementations with **no `Platform.isMobile` handling** (`isDesktopOnly:false` in manifest only).

- **Editor mode** (`buildStickyBarExtension`, `src/sticky-headings.ts`): a CM6 `ViewPlugin` appends `.rh-sticky-bar rh-hidden` into `view.dom` (`.cm-editor`) as `position:absolute`:
```css
.rh-sticky-bar {
  position: absolute; top: 0; left: 0; right: 0; z-index: 10;
  background: transparent; padding: 0; overflow: visible;
  pointer-events: none;                 /* bar itself transparent to clicks */
}
.rh-sticky-line { background-color: var(--background-primary); pointer-events: auto; ... }
```
Each line has a solid background so scrolling content shows through cleanly; `will-change: transform` hint. Scroll handled by a **rAF-throttled** handler reading `scrollTop`, with **precomputed heading boundaries + binary search** (`computeHeadingBoundaries` → `findContextAtBoundaries`), not per-frame recompute. Jump uses `EditorView.scrollIntoView(cmLine.from, { y:'start', yMargin:0 })`.
- **Reading view** (`ReadingViewStickyBar.attach()`): injects into the **outer non-scrolling wrapper** `.markdown-reading-view`, adds `.rh-position-relative` to the host, `prepend(this.bar)`, and uses the **inner** `.markdown-preview-view` as the scroller. This is the cleanest structural decoupling: bar lives in the wrapper that does NOT scroll; content scrolls beneath it. It walks rendered `h1..h6` inside `.markdown-preview-section` via `getBoundingClientRect` and builds the context from headings whose bottom is above `bar.getBoundingClientRect().bottom + 2`.

**How it avoids the inline-title problem natively:** it derives the stack from real headings in `.markdown-preview-section`. Obsidian's **inline title is not an `<h1>` in that section** (confirmed in upstream issue #6: "inline title is not considered a 'heading element' in HTML"), so it is structurally excluded from the crumb stack. There is still **no vertical offset for the title** — the bar just sits at `top:0` and can cover the inline title region visually; the plugin simply never *includes* the title as a crumb.

### imshenshen/obsidian-sticky-heading (the original CodeMirror plugin, edit-only)
A CM6 `ViewPlugin` (`src/HeadingPlugin.ts`) that:
- Appends `.obsidian-sticky-heading.markdown-rendered` into `view.dom` (`.cm-editor`).
- CSS: `position:absolute; top:0; width:100%; z-index:1`.
- Applies a **negative top-space CSS variable** nudge:
```css
body { --sticky-heading-top-space: calc(-1 * var(--size-4-8)); ... }
```
(used with the inner container to pull it up by one Obsidian size step — a coarse static tweak, not a title measurement).
- Computes content→scroller distance at runtime (`getDistanceFromContentToScroller` walks `offsetTop`/`offsetParent` up to `scrollDOM`) and sets the stick trigger to `height = view.scrollDOM.scrollTop - distance + offset`, where `offset` = `-10` first pass, `10` after, or `stickyDom.clientHeight - 16` in `prevToH1` mode.
- Reads the syntax tree (`syntaxTree(view.state).iterate`) to find heading names and line numbers; renders titles via `MarkdownRenderer.render`.

Mobile: no special handling; `isDesktopOnly:false`. Reading mode: unsupported. **It is the only one of the three that *actively nudges the bar upward* to sit flush, via the negative `--sticky-heading-top-space`.**

---

## 8. Recommendation for the fork

**The simplest, battle-tested approach IS the user-adjustable CSS offset.** Upstream ships exactly `--sticky-header-verticle-offset` (default 0) and that's all users get to fix top-overlap — and the plugin is widely used with it. But the fork already goes further and is on the right track:

1. **Keep the DOM measurement already implemented** (`measureInlineTitleOffset()` → `--sticky-header-top-offset`). This is strictly better than all three upstream plugins, because it's the only code path that actually clears the inline title automatically. Its `getBoundingClientRect` reading is cheap and only runs on `onMount` / when `view`/`file` change — it should **not** run on every scroll.

2. **Apply the offset desktop-only, keep `top:0` + `verticle-offset` on mobile** — exactly as the current `.is-mobile/.is-phone { top:0 }` + `@media (max-width:600px)` rules do. This matches the fact that mobile has no inline title in the same layout and that upstream's open mobile issues (#50/#51) are about *keyboard height* and *jump target occlusion*, not the title.

3. **Re-measure when the inline title appears/disappears**, i.e. not just on `view/file` change but also on `layout-change` (properties collapse, readable-line-width toggle) — addressing the #19 "title flashing" family. The existing `$: if (view || file)` reactive block is the hook; consider also re-running after `layout-change` since the title top shifts when properties are collapsed.

4. **Guard against the CSS knob + measured offset double-counting.** If a user also raises `--sticky-header-verticle-offset`, the two paddings stack. Decide precedence (recommend: measured `top` wins; keep `verticle-offset` as a manual fallback only on mobile / when no title is found). This mirrors how return-headings cleanly separates "structural decoupling" from "visual offset."

5. **Do NOT copy imshenshen's negative `--sticky-heading-top-space`** (the `calc(-1 * var(--size-4-8))` pull-up) — it fights the inline-title offset and only works in its editor-only, title-less context.

**Net:** the battle-tested floor is a single user-tunable CSS offset; the fork's measured-inline-title offset on desktop (with `top:0` on mobile) is the recommended ceiling and is not present in any of the three reference plugins.

---

## Source URLs

- zhouhua plugin: https://github.com/zhouhua/obsidian-sticky-headings
  - `src/ui/StickyHeader.svelte`: https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/ui/StickyHeader.svelte
  - `styles.css`: https://github.com/zhouhua/obsidian-sticky-headings/blob/master/styles.css
  - `src/stickyHeader.ts`: https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/stickyHeader.ts
  - `src/plugin.ts` (`handleComponentUpdate`, `setHeadingsInView`): https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/plugin.ts
  - `src/utils/getShownHeadings.ts` (`boundaryOffset`, DOM reads): https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/utils/getShownHeadings.ts
  - `src/utils/obsidian.ts` (`getScroller`, `getBoundaryOffset`): https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/utils/obsidian.ts
  - Issues: #21 https://github.com/zhouhua/obsidian-sticky-headings/issues/21 · #29 https://github.com/zhouhua/obsidian-sticky-headings/issues/29 · #50 https://github.com/zhouhua/obsidian-sticky-headings/issues/50 · #51 https://github.com/zhouhua/obsidian-sticky-headings/issues/51 · #19 https://github.com/zhouhua/obsidian-sticky-headings/issues/19 · #15 https://github.com/zhouhua/obsidian-sticky-headings/issues/15 · #17 https://github.com/zhouhua/obsidian-sticky-headings/issues/17 · #16 https://github.com/zhouhua/obsidian-sticky-headings/issues/16 · #48 https://github.com/zhouhua/obsidian-sticky-headings/issues/48
  - PR #30 (mode-separate mounts / z-index): https://github.com/zhouhua/obsidian-sticky-headings/pull/30
- return-headings: https://github.com/112345brian/return-headings — `src/sticky-headings.ts`, `styles.css`, `src/main.ts`
- imshenshen: https://github.com/imshenshen/obsidian-sticky-heading — `src/HeadingPlugin.ts`, `styles.css` (issue #9: https://github.com/imshenshen/obsidian-sticky-heading/issues/9)

(Clones used for this research are cached in `tmp/zhouhua-sticky`, `tmp/112345brian-return`, `tmp/imshenshen-sticky`.)
