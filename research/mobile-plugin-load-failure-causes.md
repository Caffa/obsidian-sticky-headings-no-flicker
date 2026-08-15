# Research: Obsidian Mobile "Failed to Load Plugin" — Causes & Fixes

**Date:** 2026-08-15
**Plugin:** `sticky-headings-no-flicker` (Sticky Headings, No Flicker) v2.1.3
**Scope:** Research only — no files modified.

---

## TL;DR — Top likely causes, in priority order

1. **A runtime exception thrown during `onload()` (or at module top-level) is the #1 cause of "Failed to load plugin" on mobile.** The plugin's `onload()` is `async` and calls `checkFileResolveMap()` → `initStickyHeaderComponent()` → `getShownHeadings()` → `view.editor.cm.lineBlockAt()` / `view.previewMode.renderer.sections`. These are **undocumented internal APIs** that are timing-sensitive. If any throws on mobile (e.g. `view.editor.cm` not yet ready, or `renderer.sections` shape differs), the plugin is marked failed. **This is the most probable cause given the codebase.**
2. **`view.editor.cm` / `view.editMode` / `view.previewMode.renderer` are internal, untyped APIs.** They are *not* part of the public Obsidian API. They exist on both desktop and mobile (mobile is CM6-only), but they are **not guaranteed** and are timing-sensitive. Accessing them during `onload()` before the editor is ready can throw.
3. **CJS vs ESM output is NOT the cause here.** The official `obsidian-sample-plugin` ships `format: 'cjs'` and works on mobile. The `require("obsidian")` calls in the bundle are expected. The Claudian issue claiming "Obsidian 1.7+ has no require" was **closed as not planned / stale** and is contradicted by the official template and npm docs.
4. **The lodash `require("util")` is SAFE.** It is wrapped in `try/catch` with `Rt.require &&` short-circuit guards, so it never throws even when `require` is undefined. Not a cause.
5. **`window.i18next` access is SAFE.** It is wrapped in `try/catch` in `src/i18n.ts`. Not a cause.
6. **`isDesktopOnly: false` is correct** — the plugin does not use Node/Electron APIs. Not a cause.
7. **Folder-name == manifest `id` mismatch** — already fixed in commit `7144d7e`. This was a real cause previously, but is now resolved.

---

## Detailed findings

### 1. What "Failed to load plugin" actually means

Obsidian shows "Failed to load plugin" when the plugin's `main.js` **throws during evaluation** (module top-level) **or during `onload()`**. The error is surfaced in the Developer Console (desktop) or via remote debugging (mobile). The most common triggers, per the Obsidian forum and community troubleshooting guides:

- A `TypeError`/`ReferenceError` thrown at module load or in `onload()`.
- Invalid `manifest.json` (syntax, missing required fields, invalid `id`).
- A dependency that calls a Node/Electron API that doesn't exist on mobile (e.g. `buffer`, `fs`, `process`).
- Folder name not matching manifest `id` (mobile is stricter about this).

Sources:
- https://forum.obsidian.md/t/failed-to-load-plugin/98136
- https://tonsofskills.com/skills/obsidian-common-errors/ ("Plugin failed to load — Syntax or Manifest Errors")
- https://marcusolsson.github.io/obsidian-plugin-docs/getting-started/plugin-anatomy

### 2. The plugin's `onload()` path is the highest-risk area

`src/plugin.ts` `onload()` is `async` and synchronously calls `checkFileResolveMap()` (line 71), which calls `initStickyHeaderComponent()` → `retrieveHeadings()` → `getShownHeadings()` → `getHeadingsWithOffsetSource()` which does:

```ts
view.editor.cm.lineBlockAt(position.start.offset)   // getShownHeadings.ts:40
view.editMode.containerEl.querySelector(...)        // getShownHeadings.ts:38
```

and `getScroller()` does:

```ts
view.editor.cm.scrollDOM : view.previewMode.renderer.previewEl   // obsidian.ts:37
```

and `getHeadingsWithOffsetPreview()` does:

```ts
view.previewMode.renderer.sections.forEach(...)      // getShownHeadings.ts:16
```

**Key risk:** `view.editor.cm` and `view.previewMode.renderer` are **internal, undocumented properties** (confirmed by the official docs, which say the CM6 editor is "not actually exposed" and requires `@ts-expect-error` to access). They are present on both desktop and mobile (mobile is CM6-only), but:

- They are **timing-sensitive** — `view.editor.cm` may not be initialized when `onload()` runs, especially on mobile where the editor mounts asynchronously.
- `view.previewMode.renderer.sections` is an internal renderer detail that can change shape between versions.

If any of these throws during `onload()`, the plugin fails to load. **This is the most likely cause** given the codebase, and it's the first thing to verify by checking the mobile console.

**Recommended fix:** Wrap the risky internal-API access in try/catch, defer it until the editor is ready (e.g. wait for `active-leaf-change` + a longer timeout, or use `requestAnimationFrame`/`setTimeout`), and guard `view.editor.cm` / `view.previewMode.renderer` with null checks. Prefer the public `view.editor` API where possible.

### 3. CJS vs ESM — NOT the cause

- The **official** `obsidian-sample-plugin` `esbuild.config.mjs` uses `format: 'cjs'` and works on mobile. (Verified: https://raw.githubusercontent.com/obsidianmd/obsidian-sample-plugin/master/esbuild.config.mjs)
- The npm `obsidian` package docs explicitly say plugins use `require('obsidian')` and "Must export a default class which extends Plugin". (https://www.npmjs.com/package/obsidian)
- The Claudian issue (#891) claiming "Obsidian 1.7+ sandbox has no require" is **closed as not planned / stale** and is contradicted by the official template. It was a misdiagnosis.
- The plugin's bundle correctly ends with `module.exports = Mm(Wv)` where `Wv.default` is the plugin class — this is the correct CJS export shape Obsidian expects.

**Conclusion:** `format: 'cjs'` is fine. Do not switch to ESM based on the Claudian issue.

### 4. lodash `require("util")` — SAFE

The bundled `main.js` contains exactly one `require("util")`, inside lodash's internal feature-detection:

```js
Ne = function(){ try { var g = Rt && Rt.require && Rt.require("util").types; ... } catch(y){} }()
```

It is guarded by `Rt.require &&` (short-circuit) **and** wrapped in `try/catch`. Even if `require` is undefined, it returns `undefined` without throwing. **Not a cause.**

### 5. `window.i18next` — SAFE

`src/i18n.ts` wraps the access in `try/catch`:

```ts
try { locale = (window.i18next.language || '').startsWith('zh') ? 'zh' : 'en'; } catch (e) {}
```

Even if `window.i18next` is undefined on mobile, it falls back to `'en'` without throwing. **Not a cause.**

### 6. `isDesktopOnly: false` — correct

The plugin uses only Obsidian API + DOM + Svelte + lodash + typesafe-i18n. It does **not** use Node.js or Electron APIs. Per the official mobile docs, `isDesktopOnly` should only be `true` if the plugin uses Node/Electron APIs. So `false` is correct and is **not** a cause.

### 7. Folder name == manifest `id` — already fixed

Commit `7144d7e` changed the manifest `id` from `another-sticky-headings` to `sticky-headings-no-flicker` to match the deploy folder. The official manifest docs confirm: "For local development, the `id` should match the plugin's folder name; otherwise some methods, such as `onExternalSettingsChange`, won't be called." This was a real cause previously and is now resolved. **Not the current cause** (assuming the deployed folder is `sticky-headings-no-flicker`).

### 8. Node built-ins / bundling lodash with process/util — SAFE here

- The bundle has **zero** `process.` references and **zero** unguarded `Buffer` references (all 8 `Buffer` occurrences are inside lodash's internal feature-detection, guarded by `try/catch` and `gr = As ? y.Buffer : r`).
- The `builtin-modules` package is used in `esbuild.config.mjs` to mark Node built-ins as external, which is correct.
- The known mobile failure mode (from the isomorphic-git / safe-buffer thread) is when a dependency **unconditionally** requires `node:buffer`/`node:util`. That is **not** the case here — lodash's `require("util")` is guarded.

### 9. Svelte / typesafe-i18n / CodeMirror on mobile

- **Svelte:** Bundled via `esbuild-svelte` with `css: 'injected'`. Svelte 4 compiles to plain JS and works on mobile. Not a cause by itself.
- **typesafe-i18n:** The generated `i18n-util.sync.ts` just imports locale objects and registers them — no Node/global access. The only global access (`window.i18next`) is guarded. Not a cause.
- **CodeMirror 6:** Mobile is CM6-only. The plugin's use of `view.editor.cm` (CM6) is actually *more* compatible with mobile than desktop (desktop can still use legacy CM5 in some configs). The risk is **timing**, not platform.

---

## Recommended fixes (in priority order)

1. **Harden the internal-API access in `onload()` path.**
   - Wrap `getShownHeadings()` / `getScroller()` / `initStickyHeaderComponent()` calls in `try/catch` so a transient error doesn't fail the whole plugin.
   - Add null/undefined guards for `view.editor.cm`, `view.previewMode.renderer`, and `view.previewMode.renderer.sections`.
   - Defer the first `checkFileResolveMap()` call until the editor is ready (increase the `setTimeout` in the `active-leaf-change` handler, or use `requestAnimationFrame`).

2. **Verify the actual error on mobile.**
   - On Android: enable USB debugging, open `chrome://inspect/`, read the console error.
   - On iOS: use Web Inspector (iOS 16.4+).
   - The exact error message will confirm whether it's the internal-API timing issue or something else.

3. **Do NOT change `format` to ESM** — CJS is correct and matches the official template.

4. **Do NOT change `isDesktopOnly`** — `false` is correct.

5. **Confirm the deployed folder name** still matches `sticky-headings-no-flicker` in all three vaults (the deploy script handles this, but verify no stale `obsidian-sticky-headings-no-flicker` folder remains).

---

## Sources

- Official sample plugin esbuild config (CJS): https://raw.githubusercontent.com/obsidianmd/obsidian-sample-plugin/master/esbuild.config.mjs
- npm obsidian package (require + default export): https://www.npmjs.com/package/obsidian
- Official mobile dev docs (Node/Electron APIs crash on mobile; isDesktopOnly): https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Plugins/Getting%20started/Mobile%20development.md
- Official manifest docs (id == folder name): https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/Manifest.md
- Official editor docs (CM6 not exposed; use @ts-expect-error): https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Plugins/Editor/Communicating%20with%20editor%20extensions.md
- Obsidian forum "Failed to load plugin": https://forum.obsidian.md/t/failed-to-load-plugin/98136
- Obsidian forum "require is not defined on android" (dataviewjs sandbox, not plugin main.js): https://forum.obsidian.md/t/referenceerror-require-is-not-defined-on-android/83320
- Obsidian forum "isomorphic-git / safe-buffer on mobile" (Node built-in failure mode): https://forum.obsidian.md/t/notes-on-getting-isomorphic-git-or-safe-buffer-work-on-mobile/90229
- Claudian issue #891 (CJS claim — closed as not planned): https://github.com/YishenTu/claudian/issues/891
- obsidian-git buffer error on iOS: https://github.com/Vinzent03/obsidian-git/issues/659
- Community troubleshooting guide: https://tonsofskills.com/skills/obsidian-common-errors/
