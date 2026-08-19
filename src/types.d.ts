import type { MarkdownView, TFile, HeadingCache, EventRef } from 'obsidian';
import type StickyHeaderComponent from './stickyHeader';

export interface ISetting {
  max: number;
  mode: 'default' | 'concise' | 'disable';
  theme: string;
  scrollBehaviour: ScrollBehavior;
  showIcon: boolean;
  autoShowFileName: boolean;
  showInStatusBar: boolean;
  boundaryOffset: string;
  fontSize: number;
}

export interface FileResolveEntry {
  resolve: boolean;
  file: TFile;
  view: MarkdownView;
  container: HTMLElement;
  headings: Heading[];
  getExpectedHeadings: (index: number) => Heading[];
  headingEl: StickyHeaderComponent;
  layoutChangeEvent: EventRef;
  scrollListener?: ((event: Event) => void) | null;
  scrollListenerTarget?: HTMLElement | null;
  detectPosition?: ((event: Event, scroller: HTMLElement) => void) | null;
  editMode: boolean;
  currentIndex: number;
  resolveRevision: number;
}

export interface Heading extends HeadingCache {
  title: string;
  offset: number;
  indentLevel: number;
  index: number;
}

declare module 'obsidian' {
  interface MarkdownSubView {
    type: 'source' | 'preview';
  }
  interface RendererSection {
    height: number;
  }
}
