import { Platform } from 'obsidian';
import type { MarkdownView } from 'obsidian';
import type { ISetting } from '../types';

export function computeEffectiveTop(main: HTMLElement | undefined, view: MarkdownView, settings: ISetting): number {
  const userNudge = Platform.isMobile ? settings.mobileTopOffset : settings.desktopTopOffset;

  if (!main?.parentElement) {
    return Math.max(0, userNudge);
  }

  const anchorRect = view.contentEl.getBoundingClientRect();
  const containerRect = main.parentElement.getBoundingClientRect();

  if (!anchorRect.height || !containerRect.height) {
    return Math.max(0, userNudge);
  }

  return Math.max(0, Math.round(anchorRect.top - containerRect.top + userNudge));
}
