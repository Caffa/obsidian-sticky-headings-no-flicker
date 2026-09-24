# Obsidian Sticky-Headings Plugins: Sticky Header Positioning Strategies

Research task: how popular Obsidian sticky-heading plugins position their sticky header so it doesn't overlap Obsidian's inline title / file path display in live preview and reading modes.

Date: 2026-09-24

---

## TL;DR — Key Positioning Strategies

| Plugin (repo) | Mounted into | Vertical offset mechanism | Overlap-with-inline-title strategy |
|---|---|---|---|
| **zhouhua/obsidian-sticky-headings** ("Another Sticky Headings", current maintainer, 52★) | `view.previewMode.containerEl` (reading) and `view.editMode.editorEl` (edit/live preview), i.e. the markdown view wrappers | `position:absolute; top:0` + `padding-top: var(--sticky-header-verticle-offset)` (default 0px, **user-adjustable** via Style Settings) + per-mode boundary offset (`boundaryOffset` px/% subtracted from heading trigger offsets) | **Does NOT detect inline title/breadcrumb height automatically.** User must manually set the `verticle offset` CSS variable to push the bar down past the inline title/floating search bar. The offset variable is a free-form px style-settings knob. |
| **imshenshen/obsidian-sticky-heading** ("Sticky Heading", the original community plugin) | `view.dom` (`.cm-editor`), edit/source/live-preview only (CodeMirror `ViewPlugin`) | `position:absolute; top:0` + a `--sticky-heading-top-space: calc(-1 * var(--size-4-8))` body variable (negative top margin trick); computes content-to-scroller distance at runtime | Overlays the top of the editor; inline-title overlap is handled implicitly by the negative top-space variable, not by measuring the title. |
| **112345brian/return-headings** (fork/adaptation of zhouhua) | Reading: `.markdown-reading-view` (prepended as first child, host gets `.rh-position-relative`). Edit: `view.dom` via CM6 `ViewPlugin` | `position:absolute; top:0; left:0; right:0; z-index:10` over the non-scrolling wrapper; content scrolls underneath. Reading view uses `getBoundingClientRect()` of `h1`–`h6` | **No inline-title offset** — bar just sits at `top:0`. Uses `markdown-preview-section` headings directly (inline title is not an `h1` in the section, so it's naturally excluded from the context stack). |
| **GottZ/sticky-headings** (archived, 1★) | N/A (archived skeleton, no substantive positioning code) | — | — |
| **jwczju/sticky-table-headers** (adjacent, useful trick) | Clones table header into a `position:fixed` wrapper | `position:fixed; top:0` (cloned wrapper pinned to viewport) | N/A (tables only) |

**Bottom line:** None of these plugins *mechanically* measure the inline title's height. They all position at `top:0` of a `position:relative`/absolute container and rely on either (a) a user-adjustable style-settings offset variable (zhouhua's `--sticky-header-verticle-offset`), or (b) a negative-top-space CSS var (imshenshen), or (c) just overlay the top and let the user accept it. **No plugin uses CSS `position: sticky` or `IntersectionObserver`** — they all use scroll events + manual top positioning. All treat the file path / inline title as "content that scrolls under the bar" rather than something to vertically offset around.

---

## 1. zhouhua/obsidian-sticky-headings (primary reference)

Repo: https://github.com/zhouhua/obsidian-sticky-headings
Community plugin ID: `another-sticky-headings` (marketplace name "Another Sticky Headings")
Version checked: 2.1.3 (master)

### 1a. Mount target

Two Svelte `StickyHeader` components are mounted — one per mode — in `src/stickyHeader.ts`:

```ts
const previewContentEl = view.previewMode.containerEl;   // reading mode
const sourceContentEl = view.editMode.editorEl;          // edit / live preview
this.stickyHeaderComponents = [
  new StickyHeader({ target: previewContentEl, ... }),
  new StickyHeader({ target: sourceContentEl, ... }),
];
```

So both mount **into the markdown view wrapper** that contains the scrollable content — NOT into `.cm-scroller` directly. The actual scroll container used for metrics is `getScroller(view)` in `src/utils/obsidian.ts`:

```ts
export const getScroller = (view: MarkdownView) =>
  isEditMode(view) ? view.editor.cm.scrollDOM : view.previewMode.renderer.previewEl;
```

### 1b. Vertical offset calculation (this is the key part)

`src/ui/StickyHeader.svelte` (lines 150-159) positions the bar absolutely at the top and uses `padding-top` driven by a CSS variable:

```css
.sticky-headings-root {
  height: fit-content;
  overflow: hidden;
  position: absolute;
  top: 0;
  width: 100%;
  padding: 0 var(--file-margins);
  z-index: 1;
  padding-top: var(--sticky-header-verticle-offset);   /* ← the vertical offset knob */
}
```

- `position: absolute; top: 0` anchors the bar to the top of `previewMode.containerEl` / `editMode.editorEl` (which is `position: relative` because the plugin sets `.view-content { position: relative }` in `styles.css`).
- The default variable is defined in `styles.css` (note the author's spelling):
  ```css
  :root {
    --sticky-header-indent-width: 1em;
    --sticky-header-verticle-offset: 0px;   /* default 0 */
    ...
  }
  ```
- It's exposed as a **Style Settings** knob (not a runtime measurement):
  ```
  id: sticky-header-verticle-offset
  title: verticle offset
  description: The verticle offset in px units
  type: variable-number
  default: 0
  format: px
  ```
- The `theme-float` variant pushes it further:
  ```css
  .sticky-headings-theme-float.sticky-headings-root {
    padding: 10px 20%;
    padding-top: calc(var(--sticky-header-verticle-offset) + 10px);
  }
  ```

There is also a **runtime "boundary offset"** concept (`settings.boundaryOffset`, default `'0px'`, editable as px or %) that shifts how far down a heading must scroll before it "sticks" — it is **subtracted from heading trigger offsets**, not from the bar's `top`. From `src/utils/getShownHeadings.ts`:

- Reading mode: `offset: (headingsOffset[index] || 0) - boundaryOffset`
- Source/live-preview: `offset: top + offset - boundaryOffset` where `top` = `view.editor.cm.lineBlockAt(...)`, plus `.cm-contentContainer`'s `offsetTop`.

The boundary offset is exposed in settings (`settings.ts`) with validation `/^-?\d+(%|px)$/`. This does NOT move the visual bar down; it changes when the sticky header "activates" relative to page top.

### 1c. Inline title / breadcrumbs / file path handling

- **No automatic detection of inline title or breadcrumb height.** The plugin positions at `top:0` (or `padding-top: --sticky-header-verticle-offset`).
- The **file name** is handled as *content inside the bar*, not as an offset: the bar can render the filename itself as the first clickable item when `autoShowFileName` is on (see `src/ui/StickyHeader.svelte` lines 73-90 and `needShowFileName` in `src/utils/obsidian.ts`). This is a workaround: since the bar may hide the real inline title, the plugin re-displays the file name at the top of its own bar.
- The **inline title / file path in Obsidian** is simply *content that scrolls underneath* the absolutely-positioned bar. There is no code that measures `.inline-title` or `.view-header` and adds its height to the offset.
- To avoid overlapping a floating search bar or an inline title, users must manually raise `--sticky-header-verticle-offset`.

### 1d. Scroll tracking mechanism

- **Scroll events + throttling** (NOT CSS sticky, NOT IntersectionObserver). In `src/plugin.ts`:
  ```ts
  detectPosition = throttle((event, scroller, item) => {
    const container = target?.closest('.view-content');
    if (container) this.setHeadingsInView(scroller, item);
  }, 50, { leading: true, trailing: true });
  ```
  Attached with capture via `item.view.contentEl.addEventListener('scroll', newScrollListener, true)`.
- `setHeadingsInView` filters headings using `stuckHeaderHeight = getContainerEl(scroller)?.clientHeight || 0` and `heading.offset < scrollTop + stuckHeaderHeight` — i.e. it computes which headings are "above the sticky bar" using the bar's own measured clientHeight.
- Click-to-jump in `src/ui/StickyHeader.svelte` computes `top = heading.offset - expectedHeight` where `expectedHeight` = the height of a hidden "shadow" copy of the bar (used to know how far to scroll so the target isn't covered). See `calculateExpectedHeight` and the `sticky-headings-shadow` div (opacity:0) in the same file.

### 1e. Relevant overlap / positioning issue discussions (from GitHub issues)

- **#29 "Will block search bar if it floats on the top area"** — confirms the `z-index` problem: an overlay search bar (e.g. theme *border*) is blocked because the sticky container has a higher z-index. This is precisely the inline-title/overlay overlap class of problem.
- **#48 "The left side of the sticky header has a gap in the note, which lets the note leak"** — margins/fill issue around `--file-margins`.
- **#50 "[FR] don't cover heading you've jumped to on Mobile"** — mobile: after tapping a heading link, the target is covered by the sticky bar (because Obsidian doesn't know the sticky bar reduced viewport height). Author suggests scrolling a bit further.
- **#51 "[FR] For mobile: to hide sticky heading when onscreen keyboard is shown"** — mobile keyboard + sticky bar = too little vertical space; no automatic handling.
- **#33** — sticky headings too close to window edge with multiple tab groups (horizontal margin issue).
- **#53 (open PR/issue) "feat: add breadcrumb display mode"** — plans a one-line horizontal breadcrumb (`a › b › c`) mode to save vertical space; confirms breadcrumbs as a first-class concern.
- #2.1.2 changelog: "Support for adjusting how far from the top boundary a heading needs to be to trigger the sticky effect" → the `boundaryOffset` feature.

---

## 2. imshenshen/obsidian-sticky-heading (the original "Sticky Heading")

Repo: https://github.com/imshenshen/obsidian-sticky-heading
Community plugin ID: `sticky-heading` (marketplace name "Sticky Heading")
Note: the user's prompt guessed "yshalsager / sameer Jain" — the actual original community-plugin author is **imshenshen**. (There is no yshalsager or sameerajain sticky-headings repo.)

### 2a. Mount target

A CodeMirror `ViewPlugin` (`src/HeadingPlugin.ts`) appends the bar to `view.dom` (the `.cm-editor`):

```ts
init(view: EditorView) {
  view.dom.appendChild(this.stickyDom);          // into .cm-editor
  view.scrollDOM.addEventListener("scroll", this.handleScroll.bind(this));
  ...
}
```

It is **edit/live-preview only** (no reading mode).

### 2b. Vertical offset

`styles.css`:

```css
body {
  --sticky-heading-top-space: calc(-1 * var(--size-4-8));  /* negative top margin trick */
  --sticky-heading-bg-color: var(--titlebar-background);
}
.obsidian-sticky-heading {
  position: absolute;
  top: 0;
  width: 100%;
  z-index: 1;
}
```

The negative `--sticky-heading-top-space` body variable nudges the bar upward (`--size-4-8` = one step of Obsidian's size scale), a simple hard-coded visual tweak rather than a measured offset.

The plugin also computes content-to-scroller distance at runtime (`getDistanceFromContentToScroller` in `src/HeadingPlugin.ts`) to translate `scrollTop` into a document-relative heading offset:

```ts
let distance = 0;
while (currentElement != null && currentElement != scroller) {
  distance += currentElement.offsetTop;
  currentElement = currentElement.offsetParent;
}
```

Offset of the stickiness trigger is adjusted in `findHeaders`: `let height = view.scrollDOM.scrollTop - distance + offset;` where `offset` is `-10` (first pass) or the sticky DOM's own `clientHeight - 16` (for `prevToH1` mode).

### 2c. Inline title handling

No automatic inline-title offset. The top-space variable is a coarse static nudge. No breadcrumbs, no file-path display.

### 2d. Mechanism

Scroll event + `EditorView.requestMeasure()` read/write cycle. No `IntersectionObserver`, no CSS `position: sticky`.

---

## 3. 112345brian/return-headings (fork/adaptation of zhouhua)

Repo: https://github.com/112345brian/return-headings

### 3a. Mount target (two different hosts)

From `src/sticky-headings.ts`:

- **Edit / live preview:** CM6 `ViewPlugin` (`buildStickyBarExtension`) appends `.rh-sticky-bar` into `view.dom` (`.cm-editor`).
- **Reading view:** `ReadingViewStickyBar.attach()` prepends the bar into the **outer non-scrolling wrapper** `.markdown-reading-view` and adds `.rh-position-relative` to it:
  ```ts
  const hostEl = containerEl.querySelector('.markdown-reading-view');
  hostEl.addClass('rh-position-relative');
  hostEl.prepend(this.bar);
  // scroll container is the inner .markdown-preview-view
  this.scrollEl = containerEl.querySelector('.markdown-preview-view') ?? this.findScrollParent(hostEl);
  ```

So it deliberately mounts into "the outer wrapper that does NOT scroll" so the bar stays fixed while `.markdown-preview-view` scrolls beneath it — a clean way to avoid the CMS-scroller positioning problem.

### 3b. Vertical offset

`styles.css` lines 67-80:

```css
.rh-sticky-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  background: transparent;
  padding: 0;
  overflow: visible;
  pointer-events: none;   /* let clicks through by default */
}
```

Each `.rh-sticky-line` carries its own solid `background-color: var(--background-primary)` (so scrolling content shows through cleanly) with `height: calc(var(--line-height-normal, 1.5) * 1em + 2px)`.

### 3c. Inline title / file path handling

**Bar sits at `top:0` with no inline-title offset.** However, the reading view derives the context stack from rendered heading elements within `.markdown-preview-section` (`querySelectorAll('h1,h2,...')`) — the **inline title is not part of that section**, so it naturally never becomes a "sticky crumb". It deliberately filters out headings inside `.markdown-embed` (embedded notes) so embeds don't pollute the parent's context.

The bar is positioned relative to `getBoundingClientRect().bottom` of itself (`const barBottom = this.bar.getBoundingClientRect().bottom + 2`) and only keeps headings whose bottom is above the bar's bottom. It exposes no user offset for the inline-title region.

### 3d. Mechanism

Scroll event + rAF throttle (`rafPending` flag). rAF-based, not IntersectionObserver, not CSS sticky.

---

## 4. GottZ/sticky-headings (archived)

Repo: https://github.com/GottZ/sticky-headings (archived, 1★). The archived repo contains only a skeleton (`main.ts`, empty `styles.css`, `src/index.ts`) — no usable positioning code. Include only as a note that it never shipped a position strategy.

---

## 5. Adjacent repos with reusable positioning tricks

### jwczju/sticky-table-headers (`sticky-table-headers` community ID)
Repo: https://github.com/jwczju/sticky-table-headers
Positioning: clones the table header into a wrapper pinned to the **viewport**:

```css
.tsh-clone-wrapper {
  position: fixed;      /* pinned to viewport, not to a scroller */
  z-index: 100;
  overflow: hidden;
  pointer-events: none;
  ...
  top: 0;
}
```

Useful if the goal is to float over *everything* regardless of Obsidian's scrolling structure. Not heading-specific.

### yaye-work/obsidian-sticky-properties (`sticky-properties` community ID)
Repo: https://github.com/yaye-work/obsidian-sticky-properties — `styles.css` at `main` is 404 (different default branch / removed). I could not retrieve positioning source. Worth a manual look if the inline-title/properties overlap is in scope.

---

## 6. Summary of strategies for the "no-flicker / no-overlap" goal

If rebuilding a sticky headings component that must clear Obsidian's inline title / file-path / breadcrumbs without overlap, the three viable positioning strategies observed across these plugins are:

1. **Absolute + user offset knob (zhouhua)** — `position:absolute; top:0` in the markdown view wrapper + a Style-Settings-offset CSS var (`padding-top: var(--sticky-header-verticle-offset)`). Simple and robust; requires the user (or a theme) to provide the offset that clears the inline title. Most popular approach.
2. **Absolute into the non-scrolling outer wrapper (return-headings)** — mount into `.markdown-reading-view` and add `position:relative` to it, so the bar is structurally decoupled from `.markdown-preview-view`'s scroller. Then derive context from headings inside `.markdown-preview-section` (inline title excluded automatically).
3. **Fixed to viewport (sticky-table-headers)** — `position:fixed; top:0` on a cloned element. Simplest for true floating overlays but fights multi-column/multi-tab geometry.

**None auto-measure the inline title.** The cleanest fix (not implemented by any of them) would be to read `.inline-title`/`.view-header` height via `getBoundingClientRect()` and add it to the `top` offset — which is exactly what this project (`obsidian-sticky-headings-no-flicker`, `upstream-mobile-handling.md`) is presumably trying to improve.

---

## Source URLs

- https://github.com/zhouhua/obsidian-sticky-headings
- https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/ui/StickyHeader.svelte
- https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/stickyHeader.ts
- https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/plugin.ts
- https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/utils/obsidian.ts
- https://github.com/zhouhua/obsidian-sticky-headings/blob/master/src/utils/getShownHeadings.ts
- https://github.com/zhouhua/obsidian-sticky-headings/blob/master/styles.css
- https://github.com/imshenshen/obsidian-sticky-heading
- https://github.com/imshenshen/obsidian-sticky-heading/blob/master/src/HeadingPlugin.ts
- https://github.com/imshenshen/obsidian-sticky-heading/blob/master/styles.css
- https://github.com/112345brian/return-headings
- https://github.com/112345brian/return-headings/blob/master/src/sticky-headings.ts
- https://github.com/112345brian/return-headings/blob/master/styles.css
- https://github.com/jwczju/sticky-table-headers
- https://github.com/GottZ/sticky-headings

(Cloned copies used for this research are cached under the temp directory used during the session.)
