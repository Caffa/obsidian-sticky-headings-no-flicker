import StickyHeader from './ui/StickyHeader.svelte';
import type { MarkdownView } from 'obsidian';
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

export default class StickyHeaderComponent {
  stickyHeaderComponents!: [StickyHeader, StickyHeader];
  private lastHeadings: Heading[] = [];
  private lastGetExpectedHeadings: ((index: number) => Heading[]) | null = null;
  private lastShowFileName: boolean | undefined;
  private lastView: MarkdownView | null = null;

  constructor(view: MarkdownView, settings: ISetting) {
    this.addStickyHeader(view, settings);
  }

  addStickyHeader(view: MarkdownView, settings: ISetting) {
    const previewContentEl = view.previewMode.containerEl;
    const sourceContentEl = view.editMode.editorEl;
    this.stickyHeaderComponents = [
      new StickyHeader({
        target: previewContentEl,
        props: {
          headings: [],
          editMode: false,
          view,
          getExpectedHeadings: () => [],
          settings,
          showFileName: false,
          expectedHeadings: [],
        },
      }),
      new StickyHeader({
        target: sourceContentEl,
        props: {
          headings: [],
          editMode: false,
          view,
          getExpectedHeadings: () => [],
          settings,
          showFileName: false,
          expectedHeadings: [],
        },
      }),
    ];
  }

  removeStickyHeader() {
    this.stickyHeaderComponents.forEach(conponent => conponent.$destroy());
  }

  updateHeadings(
    headings: Heading[],
    getExpectedHeadings: (index: number) => Heading[],
    showFileName: boolean,
    view: MarkdownView
  ) {
    if (
      headingsEqual(headings, this.lastHeadings) &&
      getExpectedHeadings === this.lastGetExpectedHeadings &&
      showFileName === this.lastShowFileName &&
      view === this.lastView
    ) {
      return;
    }
    this.lastHeadings = headings;
    this.lastGetExpectedHeadings = getExpectedHeadings;
    this.lastShowFileName = showFileName;
    this.lastView = view;
    this.stickyHeaderComponents.forEach(conponent =>
      conponent.$set({ headings, getExpectedHeadings, showFileName, view })
    );
  }

  predictHeadingsHeight(headings: Heading[]) {
    this.stickyHeaderComponents.forEach(component => component.$set({ expectedHeadings: headings }));
  }

  updateEditMode(editMode: boolean) {
    this.stickyHeaderComponents.forEach(conponent => conponent.$set({ editMode }));
  }

  updateSettings(settings: ISetting) {
    this.stickyHeaderComponents.forEach(conponent => conponent.$set({ settings }));
  }
}
