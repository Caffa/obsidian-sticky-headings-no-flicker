import type { App, TAbstractFile } from 'obsidian';
import { TFile, MarkdownView, MarkdownRenderer } from 'obsidian';
import type { ISetting } from 'src/types';

export function isMarkdownFile(file: TFile | TAbstractFile) {
  if (!(file instanceof TFile)) {
    return false;
  }
  return ['md', 'markdown'].includes(file.extension);
}

const warnedPaths = new Set<string>();

export function getHeadings(file: TFile, app: App) {
  try {
    const cache = app.metadataCache.getFileCache(file);

    if (cache?.headings) {
      return cache.headings;
    }
    return [];
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const path = file?.path ?? '<unknown>';
    if (!warnedPaths.has(path)) {
      warnedPaths.add(path);
      if (document.body.dataset.stickyHeadingsDebug === '1') {
        console.warn('[sticky-headings] getHeadings failed:', { path, error });
      }
    }
    return [];
  }
}

export function parseMarkdown(markdown: string, app: App, view?: MarkdownView): Promise<string> {
  const div = document.createElement('div');
  const activeView = view ?? app.workspace.getActiveViewOfType(MarkdownView);

  if (!activeView) {
    console.warn('No active markdown view is available.');
    return Promise.resolve(markdown); // Return the original markdown if rendering is not possible
  }

  return MarkdownRenderer.render(app, '# ' + markdown, div, '', activeView).then(() => {
    return div.querySelector('h1')?.innerHTML || '';
  });
}

// used to check if we are in source mode AND NOT live preview
export const isEditSourceMode = (view: MarkdownView) =>
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  view?.editMode?.sourceMode &&
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  view?.currentMode?.type !== 'preview';

// used to check if we are in source mode OR live preview
export const isEditMode = (view: MarkdownView | null | undefined) =>
  view?.currentMode != null && view.currentMode.type !== 'preview';

const warnedBranches = new WeakMap<MarkdownView, Set<string>>();

function warnOnce(view: MarkdownView, branch: string, mode: string, filePath: string | undefined) {
  let set = warnedBranches.get(view);
  if (!set) {
    set = new Set();
    warnedBranches.set(view, set);
  }
  if (set.has(branch)) return;
  set.add(branch);
  console.warn('[sticky-headings] getScroller fallback', { mode, branch, filePath });
}

/* eslint-disable @typescript-eslint/no-unnecessary-condition */
export const getScroller = (view: MarkdownView): HTMLElement | null => {
  const mode = isEditMode(view) ? 'edit' : 'preview';
  const filePath = view.file?.path;
  if (isEditMode(view)) {
    const scrollDOM = view?.editor?.cm?.scrollDOM;
    if (scrollDOM) return scrollDOM;

    warnOnce(view, 'edit.containerEl-cm-scroller', mode, filePath);
    const containerScroller = view?.editMode?.containerEl?.querySelector<HTMLElement>('.cm-scroller');
    if (containerScroller) return containerScroller;

    warnOnce(view, 'edit.containerEl', mode, filePath);
    const containerEl = view?.editMode?.containerEl;
    if (containerEl) return containerEl;

    warnOnce(view, 'edit.contentEl-cm-scroller', mode, filePath);
    const contentScroller = view?.contentEl?.querySelector<HTMLElement>('.cm-scroller');
    if (contentScroller) return contentScroller;

    warnOnce(view, 'edit.contentEl', mode, filePath);
    return view?.contentEl ?? null;
  }

  const previewContainer = view?.previewMode?.containerEl;
  if (previewContainer) return previewContainer;

  warnOnce(view, 'preview.renderer-previewEl', mode, filePath);
  const previewEl = view?.previewMode?.renderer?.previewEl;
  if (previewEl) return previewEl;

  warnOnce(view, 'preview.contentEl-markdown-preview-view', mode, filePath);
  const markdownPreview = view?.contentEl?.querySelector<HTMLElement>('.markdown-preview-view');
  if (markdownPreview) return markdownPreview;

  warnOnce(view, 'preview.contentEl-markdown-reading-view', mode, filePath);
  const markdownReading = view?.contentEl?.querySelector<HTMLElement>('.markdown-reading-view');
  if (markdownReading) return markdownReading;

  warnOnce(view, 'preview.contentEl', mode, filePath);
  return view?.contentEl ?? null;
};
/* eslint-enable @typescript-eslint/no-unnecessary-condition */

export const getContainerEl = (el: HTMLElement | Element) =>
  el
    .closest('.markdown-reading-view, .markdown-source-view, .markdown-preview-view, .cm-editor, .view-content')
    ?.querySelector('.sticky-headings-root');

export function needShowFileName(file: TFile, app: App): boolean {
  const headings = getHeadings(file, app);
  if (headings.length === 0) {
    return false;
  }
  const firstLevel = headings[0].level;
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level <= firstLevel) {
      return true;
    }
  }
  return false;
}

export function getBoundaryOffset(view: MarkdownView, settings: ISetting) {
  const { boundaryOffset } = settings;
  if (boundaryOffset.endsWith('%')) {
    const percentage = parseFloat(boundaryOffset);
    const scroller = getScroller(view);
    const refHeight = scroller?.clientHeight ?? 0;
    return (refHeight * percentage) / 100 || 0;
  }
  return parseFloat(boundaryOffset) || 0;
}
