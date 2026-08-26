import StickyHeader from './ui/StickyHeader.svelte';
import { defaultSettings } from './settings';
import type { MarkdownView, TFile } from 'obsidian';
import type { Heading, ISetting } from './types';

function headingsEqual(a: Heading[], b: Heading[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].index !== b[i].index ||
      a[i].level !== b[i].level ||
      a[i].indentLevel !== b[i].indentLevel ||
      a[i].title !== b[i].title
    ) {
      return false;
    }
  }
  return true;
}

/* eslint-disable @typescript-eslint/no-unnecessary-condition */
function resolveMountContainers(view: MarkdownView): HTMLElement[] {
  const targets: HTMLElement[] = [];
  const { contentEl } = view;
  if (!contentEl) return targets;

  // Use the container matching the active view mode so we don't mount a phantom
  // header into the hidden preview/source container in live preview.
  const mode = view.getMode?.();
  const isPreview = mode === 'preview';

  // Prefer a single preview/reading container.
  const previewContainer = view.previewMode?.containerEl;
  const readingView = contentEl.querySelector<HTMLElement>('.markdown-reading-view, .markdown-preview-view');
  const previewTarget = previewContainer ?? readingView ?? null;

  // Prefer a single source/live-preview container.
  const sourceTarget =
    view.editMode?.editorEl ??
    contentEl.querySelector<HTMLElement>('.markdown-source-view') ??
    view.editMode?.containerEl ??
    contentEl.querySelector<HTMLElement>('.cm-editor') ??
    null;

  if (isPreview) {
    if (previewTarget) targets.push(previewTarget);
  } else if (sourceTarget) {
    targets.push(sourceTarget);
  } else if (previewTarget) {
    // Fallback for any preview-like reading view when no source container exists.
    targets.push(previewTarget);
  }

  return targets;
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition */

export default class StickyHeaderComponent {
  stickyHeaderComponents: StickyHeader[] = [];
  private lastHeadings: Heading[] = [];
  private lastGetExpectedHeadings: ((index: number) => Heading[]) | null = null;
  private lastShowFileName: boolean | undefined;
  private lastView: MarkdownView | null = null;
  private lastFile: TFile | undefined;
  private mountRetryTimer: number | undefined;

  constructor(view: MarkdownView, settings: ISetting) {
    this.addStickyHeader(view, settings);
  }

  private isDescendant(parent: Element | null, child: Element | null): boolean {
    if (!parent || !child || parent === child) return false;
    return parent.contains(child);
  }

  private scheduleMountRetry(view: MarkdownView, settings: ISetting | undefined) {
    const backoffs = [100, 200, 300, 400, 500, 750, 1000, 1500];
    let count = 0;
    const tryMount = () => {
      if (!view.contentEl.isConnected) {
        this.mountRetryTimer = window.setTimeout(tryMount, backoffs[Math.min(count, backoffs.length - 1)]);
        return;
      }
      count++;
      const targets = resolveMountContainers(view);
      if (targets.length > 0) {
        this.mountTargets(view, settings, targets);
        this.mountRetryTimer = undefined;
        return;
      }
      console.warn('[sticky-headings] mount target missing, retry', count);
      if (count >= backoffs.length) {
        // Last resort: try resolveMountContainers one more time, then fall back to contentEl
        const finalTargets = resolveMountContainers(view);
        if (finalTargets.length > 0) {
          this.mountTargets(view, settings, finalTargets);
          this.mountRetryTimer = undefined;
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: view may be disconnected on mobile
        if (view.contentEl.isConnected) {
          console.warn('[sticky-headings] using contentEl as last-resort mount target', { path: view.file?.path });
          const fallbackRoot = view.contentEl.createDiv({ cls: 'sticky-headings-root' });
          this.mountTargets(view, settings, [fallbackRoot]);
          this.mountRetryTimer = undefined;
          return;
        }
        console.warn('[sticky-headings] mount target never resolved', { path: view.file?.path });
        this.mountRetryTimer = undefined;
        return;
      }
      this.mountRetryTimer = window.setTimeout(tryMount, backoffs[count]);
    };
    this.mountRetryTimer = window.setTimeout(tryMount, backoffs[0]);
  }

  private mountTargets(view: MarkdownView, settings: ISetting | undefined, targets: HTMLElement[]) {
    const safeSettings = settings || { ...defaultSettings };
    this.lastView = view;
    const components: StickyHeader[] = [];
    for (const target of targets) {
      components.push(
        new StickyHeader({
          target,
          props: {
            headings: [],
            editMode: false,
            view,
            getExpectedHeadings: () => [],
            settings: safeSettings,
            showFileName: false,
            expectedHeadings: [],
            file: undefined,
          },
        })
      );
    }

    this.stickyHeaderComponents = components;
    view.contentEl.addClass('has-sticky-headings');
  }

  addStickyHeader(view: MarkdownView, settings: ISetting | undefined) {
    this.removeStickyHeader();
    this.lastHeadings = [];
    this.lastGetExpectedHeadings = null;
    this.lastShowFileName = undefined;
    this.lastView = null;
    this.lastFile = undefined;

    const targets = resolveMountContainers(view);
    if (targets.length === 0) {
      console.warn('[sticky-headings] no mount target available; scheduling retry', {
        path: view.file?.path,
      });
      this.scheduleMountRetry(view, settings);
      return;
    }

    this.mountTargets(view, settings, targets);
  }

  removeStickyHeader() {
    if (this.mountRetryTimer) {
      window.clearTimeout(this.mountRetryTimer);
      this.mountRetryTimer = undefined;
    }
    this.stickyHeaderComponents.forEach(conponent => conponent.$destroy());
    this.stickyHeaderComponents = [];
    this.lastFile = undefined;
    if (this.lastView) {
      this.lastView.contentEl.removeClass('has-sticky-headings');
    }
    this.lastView = null;
  }

  updateHeadings(
    headings: Heading[],
    getExpectedHeadings: (index: number) => Heading[],
    showFileName: boolean,
    view: MarkdownView,
    file?: TFile
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!this.stickyHeaderComponents?.length) return;
    if (
      headingsEqual(headings, this.lastHeadings) &&
      getExpectedHeadings === this.lastGetExpectedHeadings &&
      showFileName === this.lastShowFileName &&
      view === this.lastView &&
      file === this.lastFile
    ) {
      return;
    }
    this.lastHeadings = headings;
    this.lastGetExpectedHeadings = getExpectedHeadings;
    this.lastShowFileName = showFileName;
    this.lastView = view;
    this.lastFile = file;
    this.stickyHeaderComponents.forEach(conponent =>
      conponent.$set({ headings, getExpectedHeadings, showFileName, view, file })
    );
  }

  predictHeadingsHeight(headings: Heading[]) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this.stickyHeaderComponents?.forEach(component => component.$set({ expectedHeadings: headings }));
  }

  updateEditMode(editMode: boolean) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this.stickyHeaderComponents?.forEach(conponent => conponent.$set({ editMode }));
  }

  updateSettings(settings: ISetting) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this.stickyHeaderComponents?.forEach(component => component.$set({ settings }));
  }
}
