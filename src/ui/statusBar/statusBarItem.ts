import StatusBarItem from './StatusBarItem.svelte';
import type { MarkdownView, TFile } from 'obsidian';
import type { Heading, ISetting } from '../../types';

export default class StickyHeaderComponent {
  statusBarItemComponent!: StatusBarItem;

  constructor(statusItemEl: HTMLElement, settings: ISetting, view?: MarkdownView) {
    this.addStatusBarItem(statusItemEl, settings, view);
  }

  addStatusBarItem(statusItemEl: HTMLElement, settings: ISetting, view?: MarkdownView) {
    this.statusBarItemComponent = new StatusBarItem({
      target: statusItemEl,
      props: {
        view,
        heading: undefined,
        file: undefined,
      },
    });
  }

  removeStickyHeader() {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this.statusBarItemComponent?.$destroy?.();
  }

  switchFile(file: TFile, heading: Heading, view: MarkdownView) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this.statusBarItemComponent?.$set?.({ file, heading, view });
  }

  updateHeading(heading?: Heading) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this.statusBarItemComponent?.$set?.({ heading });
  }

  hide() {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    this.statusBarItemComponent?.$set?.({
      file: undefined,
    });
  }
}
