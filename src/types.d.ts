import type { DebouncedFunc } from 'lodash';
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
  desktopTopOffset: number;
  mobileTopOffset: number;
  desktopLeftOffset: number;
  mobileLeftOffset: number;
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
  retryTimer?: number;
  retryCount?: number;
  // Pending mutex-aware dirty-flush retry (see flushDirtyLeaf).
  dirtyFlushRetryTimer?: number;
  watchdogRecoveries?: number;
  watchdogRecoveryWindowStart?: number;
  watchdogRecovering?: boolean;
  handleUpdateInFlight?: boolean;
  handleUpdateInFlightSince?: number;
  editMode: boolean;
  currentIndex: number;
  resolveRevision: number;
  // Plan A+B equality gate + deferred layout update state.
  lastHeadingSignature?: string;
  // Position-layer counterpart of lastHeadingSignature (deliberately
  // offset-invariant): catches paste reflows with unchanged heading structure.
  lastOffsetSignature?: string;
  dirty?: boolean;
  debouncedLayoutUpdate?: DebouncedFunc<() => void>;
}

export interface Heading extends HeadingCache {
  title: string;
  offset: number;
  indentLevel: number;
  index: number;
}

export interface RetrieveHeadingsResult {
  headings: Heading[];
  /** True when the 1.5s MarkdownRenderer timeout won: titles are RAW unparsed heading text. */
  timedOut: boolean;
}

declare module 'obsidian' {
  interface MarkdownSubView {
    type: 'source' | 'preview';
    containerEl?: HTMLElement;
  }
  interface MarkdownPreviewView {
    containerEl: HTMLElement;
  }
  interface MarkdownSourceView {
    containerEl?: HTMLElement;
  }
  interface RendererSection {
    height: number;
  }
}
