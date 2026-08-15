import type { App, TAbstractFile } from 'obsidian';
import { TFile, MarkdownView, MarkdownRenderer } from 'obsidian';
import type { ISetting } from 'src/types';

export function isMarkdownFile(file: TFile | TAbstractFile) {
  if (!(file instanceof TFile)) {
    return false;
  }
  return ['md', 'markdown'].includes(file.extension);
}

export function getHeadings(file: TFile, app: App) {
  return app.metadataCache.getFileCache(file)?.headings ?? [];
}

export function parseMarkdown(markdown: string, app: App): Promise<string> {
  const div = document.createElement('div');
  const activeView = app.workspace.getActiveViewOfType(MarkdownView);

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

export const getScroller = (view: MarkdownView): HTMLElement | null => {
  if (isEditMode(view)) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return view?.editor?.cm?.scrollDOM ?? null;
  }
  // preview / reading mode — prefer public containerEl, fall back to internal previewEl
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return view?.previewMode?.containerEl ?? view?.previewMode?.renderer?.previewEl ?? null;
};

export const getContainerEl = (el: HTMLElement | Element) =>
  el.closest('.markdown-reading-view, .markdown-source-view')?.querySelector('.sticky-headings-root');

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
