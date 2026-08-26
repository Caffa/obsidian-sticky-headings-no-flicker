/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { TFile } from 'obsidian';
import { MarkdownView, Plugin } from 'obsidian';
import type { FileResolveEntry, Heading, ISetting } from './types';
import { Platform } from 'obsidian';
import StickyHeadingsSetting, { defaultSettings } from './settings';
import {
  getContainerEl,
  getHeadings,
  getScroller,
  isEditMode,
  isEditSourceMode,
  isMarkdownFile,
  needShowFileName,
  parseMarkdown,
} from './utils/obsidian';

import StickyHeaderComponent from './stickyHeader';
import StatusBarItemComponent from './ui/statusBar/statusBarItem';
import getShownHeadings, { trivial } from './utils/getShownHeadings';
import { throttle } from 'lodash';
import { calcIndentLevels } from './utils/calcIndentLevels';
import { makeExpectedHeadings } from './utils/makeExpectedHeadings';
import { HeadingSuggester } from './ui/statusBar/suggester';
import { animateScroll, computeScrollTop } from './utils/scroll';
import { getCachedTitle, invalidateMarkdownCacheForFile, setCachedTitle } from './utils/markdownCache';

type FileResolveMap = Map<string, FileResolveEntry>;

export default class StickyHeadingsPlugin extends Plugin {
  settings: ISetting = { ...defaultSettings };
  headingEl: StickyHeaderComponent | undefined;
  statusBarItemEl: StatusBarItemComponent | undefined;
  fileResolveMap: FileResolveMap = new Map();
  statusBarEl: HTMLElement | undefined;
  statusBarClickHandler: (() => void) | undefined;
  markdownCache: Map<string, string> = new Map();
  private lastActiveLeafId: string | null = null;

  private normalizeSettings(data?: Partial<ISetting>): ISetting {
    return { ...defaultSettings, ...(data ?? {}) };
  }

  private dumpDiagnostics(view: MarkdownView, item: FileResolveEntry) {
    try {
      const scroller = getScroller(view);
      const mountTargets = item.headingEl?.stickyHeaderComponents?.length ?? 0;
      const headingCount = item.headings?.length ?? 0;
      const diag = {
        leafId: view?.leaf?.id,
        mode: isEditMode(view) ? 'edit' : 'preview',
        platform: Platform.isMobile ? 'mobile' : 'desktop',
        scrollerFound: !!scroller,
        scrollerSummary: scroller ? { tag: scroller.tagName, classList: Array.from(scroller.classList) } : null,
        mountTargets,
        headingCount,
        retryCount: item.retryCount ?? 0,
        hasScrollListener: !!item.scrollListener,
      };
      document.body.dataset.stickyHeadingsDebug = JSON.stringify(diag);
      console.warn('[sticky-headings] diag', diag);
    } catch (error) {
      console.warn('[sticky-headings] diag failed:', error);
    }
  }

  private clearStickyDiagnostics() {
    try {
      delete document.body.dataset.stickyHeadingsDebug;
    } catch {
      // ignore
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onload() {
    try {
      await this.loadSettings();
    } catch (error) {
      console.warn('Failed to load sticky headings settings, using defaults:', error);
      this.settings = { ...defaultSettings };
    }

    try {
      try {
        this.initStatusBarItem();
      } catch (error) {
        console.warn('Failed to init status bar item:', error);
      }

      this.addSettingTab(new StickyHeadingsSetting(this.app, this));

      try {
        this.registerEvent(
          this.app.workspace.on('active-leaf-change', () => {
            const activeLeaf = this.app.workspace.getMostRecentLeaf();
            const activeLeafId = activeLeaf?.id ?? null;
            if (activeLeafId === this.lastActiveLeafId) return;
            this.lastActiveLeafId = activeLeafId;
            // timeout to wait for cm.editor to load
            setTimeout(() => {
              if (activeLeafId === this.lastActiveLeafId) {
                this.checkFileResolveMap();
              }
            }, 100);
          })
        );
      } catch (error) {
        console.warn('Failed to register active-leaf-change event:', error);
      }

      try {
        this.registerEvent(
          this.app.workspace.on('file-open', (file: TFile | null) => {
            if (!file || !isMarkdownFile(file)) return;
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) return;
            const leafId = view.leaf?.id;
            if (!leafId) return;
            const existing = this.fileResolveMap.get(leafId);
            // Only react when this is the same leaf as a previously-opened file
            // (new-leaf case is already handled by active-leaf-change).
            if (!existing) return;
            if (existing.file?.path === file.path) return; // no-op same file
            // Defer until Obsidian finishes rebuilding the view's preview/source DOM.
            setTimeout(() => {
              const stillActive = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf?.id === leafId;
              if (stillActive) this.checkFileResolveMap();
            }, 100);
          })
        );
      } catch (error) {
        console.warn('Failed to register file-open event:', error);
      }

      try {
        this.registerEvent(
          this.app.metadataCache.on('resolve', file => {
            this.handleResolve(file);
          })
        );
      } catch (error) {
        console.warn('Failed to register metadata resolve event:', error);
      }

      try {
        this.checkFileResolveMap();
      } catch (error) {
        console.warn('Failed to check file resolve map on load:', error);
      }
    } catch (error) {
      console.warn('Sticky headings plugin onload encountered an error:', error);
    }
  }

  initStatusBarItem() {
    this.statusBarEl = this.addStatusBarItem();
    if (!this.statusBarEl) {
      this.statusBarItemEl = undefined;
      return;
    }
    this.statusBarEl.addClass('mod-clickable');
    if (!this.settings?.showInStatusBar) {
      this.statusBarEl.style.display = 'none';
    }
    this.statusBarClickHandler = this.showSuggester.bind(this);
    this.statusBarEl.addEventListener('click', this.statusBarClickHandler);
    this.statusBarItemEl = new StatusBarItemComponent(this.statusBarEl, this.settings);
    this.addCommand({
      id: 'quick navigate headings',
      name: 'Quick Navigate Headings',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
          if (!checking) {
            this.showSuggester();
          }
          return true;
        }
        return false;
      },
    });
  }

  showSuggester() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      const { id } = view.leaf;
      const item = this.fileResolveMap.get(id || '');
      if (item) {
        const { headings, currentIndex } = item;
        const modal = new HeadingSuggester(view.app, headings, currentIndex, async ({ offset, index }) => {
          const height = await this.predictHeadingsHeight(index);
          const scroller = getScroller(view);
          if (!scroller) return;
          const top = computeScrollTop(offset, height);
          if (this.settings.scrollBehaviour === 'instant') {
            scroller.scrollTo({ top, behavior: 'instant' });
          } else {
            animateScroll(scroller, top, 1000);
          }
        });
        modal.open();
      }
    }
  }

  async predictHeadingsHeight(index: number) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      const { id } = view.leaf;
      if (id) {
        const item = this.fileResolveMap.get(id);
        if (item) {
          const rootEl = isEditMode(view) ? view?.editMode?.editorEl : view?.previewMode?.containerEl;
          if (!rootEl) return 0;
          const target = rootEl.find('.sticky-headings-shadow');
          if (!target) return 0;
          return new Promise<number>(resolve => {
            const controller = {
              settled: false,
              observer: null as MutationObserver | null,
              safetyTimeout: 0,
              finish(value: number) {
                if (this.settled) return;
                this.settled = true;
                clearTimeout(this.safetyTimeout);
                this.observer?.disconnect();
                resolve(value);
              },
            };
            controller.observer = new MutationObserver(records => {
              for (const record of records) {
                const added = Array.from(record.addedNodes);
                if (added.some(n => n instanceof HTMLElement && n.classList.contains('sticky-headings-shadow-item'))) {
                  controller.finish(target.clientHeight || 0);
                  return;
                }
              }
            });
            controller.observer.observe(target, {
              subtree: true,
              childList: true,
            });
            controller.safetyTimeout = window.setTimeout(() => {
              controller.finish(target.clientHeight || 0);
            }, 250);
            try {
              if (typeof item.headingEl?.predictHeadingsHeight !== 'function') {
                controller.finish(0);
              } else {
                Promise.resolve(item.headingEl.predictHeadingsHeight(item.getExpectedHeadings(index))).catch(error => {
                  console.warn('predictHeadingsHeight promise rejected, finishing with current target height:', error);
                  controller.finish(target?.clientHeight || 0);
                });
              }
            } catch (error) {
              console.warn('predictHeadingsHeight failed, finishing with current target height:', error);
              controller.finish(target?.clientHeight || 0);
            }
          });
        }
      }
    }
    return 0;
  }

  async initStickyHeaderComponent(view: MarkdownView) {
    try {
      const { id } = view?.leaf ?? {};
      if (!id) return;
      const file = view.getFile();
      const settings = this.settings ?? { ...defaultSettings };
      if (file && isMarkdownFile(file)) {
        const headings = await this.retrieveHeadings(file, view);
        if (!this.fileResolveMap.has(id)) {
          const headingEl = new StickyHeaderComponent(view, settings);
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          const layoutChangeEvent = this.app.workspace.on('layout-change', this.handleComponentUpdate.bind(this, view));
          const getExpected = makeExpectedHeadings(() => headings, this.settings.max, this.settings.mode);
          this.fileResolveMap.set(id, {
            resolve: true,
            file,
            container: view.contentEl,
            view,
            headings,
            getExpectedHeadings: getExpected,
            headingEl,
            layoutChangeEvent,
            editMode: isEditSourceMode(view),
            currentIndex: -1,
            resolveRevision: 0,
          });
          this.registerEvent(layoutChangeEvent);
        } else {
          const item = this.fileResolveMap.get(id);
          if (item) {
            // Tear down the previous mount + listeners bound to the now-stale DOM.
            try {
              item.headingEl?.removeStickyHeader?.();
            } catch (e) {
              console.warn('Failed to remove old sticky header on same-leaf file change:', e);
            }
            if (item.layoutChangeEvent) {
              this.app.workspace.offref(item.layoutChangeEvent);
            }
            if (item.scrollListener && item.scrollListenerTarget) {
              const useCapture = item.scrollListenerTarget === item.view?.contentEl;
              item.scrollListenerTarget.removeEventListener('scroll', item.scrollListener, useCapture);
            }
            if (item.view?.contentEl) {
              delete item.view.contentEl.dataset.stickyScrollCapture;
            }
            item.scrollListener = null;
            item.scrollListenerTarget = null;
            item.detectPosition = null;

            if (item.retryTimer) {
              window.clearTimeout(item.retryTimer);
              item.retryTimer = undefined;
            }

            // Rebind everything to the (reused) view with the new file.
            item.view = view;
            item.file = file;
            item.container = view.contentEl;
            item.editMode = isEditSourceMode(view);
            item.headings = headings;
            item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, settings.max, settings.mode);
            item.currentIndex = -1;
            item.resolveRevision++;
            item.retryCount = 0;

            const newHeadingEl = new StickyHeaderComponent(view, settings);
            item.headingEl = newHeadingEl;
            // eslint-disable-next-line @typescript-eslint/no-misused-promises
            const newLayoutChange = this.app.workspace.on('layout-change', this.handleComponentUpdate.bind(this, view));
            item.layoutChangeEvent = newLayoutChange;
            this.registerEvent(newLayoutChange);
          }
        }
        await this.handleComponentUpdate(view);
      }
    } catch (error) {
      console.warn('Failed to init sticky header component:', error);
    }
  }

  updateHeadings(file: TFile, view: MarkdownView, item: FileResolveEntry) {
    const scroller = getScroller(view);
    if (scroller) {
      this.setHeadingsInView(scroller, item);
    } else {
      // Keep the header populated even when the scroll container isn't ready yet
      // (common on mobile / during initial view construction). Recompute visible
      // headings synchronously so we don't display a stale subset from item.headings.
      const rawHeadings = getHeadings(file, this.app);
      const freshHeadings = getShownHeadings(rawHeadings, view, this.settings);
      const titleMap = new Map<string, string>();
      for (const h of item.headings) {
        if (file && h.position) {
          const key = `${file.path}::${h.position.start.offset}`;
          titleMap.set(key, h.title);
        }
      }
      const fallbackHeadings = freshHeadings.map(h => {
        if (file && h.position) {
          const key = `${file.path}::${h.position.start.offset}`;
          return {
            ...h,
            title: titleMap.get(key) || h.title,
          };
        }
        return h;
      });
      item.headingEl?.updateHeadings?.(
        fallbackHeadings,
        item.getExpectedHeadings,
        this.settings.autoShowFileName && needShowFileName(file, this.app),
        item.view,
        item.file
      );
      const { id } = view?.leaf ?? {};
      const isActiveLeaf =
        id != null &&
        this.fileResolveMap.has(id) &&
        this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf?.id === id &&
        !item.scrollListener;
      if (isActiveLeaf) {
        this.scheduleScrollerRetry(id, view);
      }
    }
    return item.headings;
  }

  async handleComponentUpdate(view: MarkdownView) {
    try {
      const scroller = getScroller(view);
      const { id } = view?.leaf ?? {};
      if (!id) return;
      const item = this.fileResolveMap.get(id);
      if (!item) return;

      // Refresh headings — layout changed, so offsets need recomputing
      const headings = await this.retrieveHeadings(item.file, view);
      if (this.fileResolveMap.get(id) !== item) return;
      item.headings = headings;
      item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);

      // Only mount / remount after we know this async call is still the latest for the leaf.
      if (!item.headingEl.stickyHeaderComponents?.length) {
        item.headingEl.addStickyHeader(item.view, this.settings);
      }

      // Remove existing scroll listener from the element it was actually attached to
      if (item.scrollListener && item.scrollListenerTarget) {
        const useCapture = item.scrollListenerTarget === item.view.contentEl;
        item.scrollListenerTarget.removeEventListener('scroll', item.scrollListener, useCapture);
      }

      if (item.view?.contentEl) {
        delete item.view.contentEl.dataset.stickyScrollCapture;
      }

      item.editMode = isEditSourceMode(item.view);
      try {
        item.headingEl.updateEditMode(isEditSourceMode(item.view));
      } catch (error) {
        console.warn('Failed to update edit mode on sticky header:', error);
      }

      if (scroller) {
        this.setHeadingsInView(scroller, item);
      }

      // Attach scroll listener to view.contentEl in capture phase so we never
      // miss scroll events on mobile where the true scroller may be nested or
      // swapped after layout changes. getScroller is still used for the read path.
      const scrollCaptureTarget = item.view.contentEl;
      if (scrollCaptureTarget) {
        // Create per-leaf throttled position detector
        item.detectPosition = throttle(
          (_event: Event, throttledScroller: HTMLElement) => {
            this.setHeadingsInView(throttledScroller, item);
          },
          50,
          { leading: true, trailing: true }
        );
        const newScrollListener = (event: Event) => {
          const currentScroller = getScroller(item.view);
          if (currentScroller) {
            item.detectPosition?.(event, currentScroller);
          }
        };
        scrollCaptureTarget.addEventListener('scroll', newScrollListener, true);
        scrollCaptureTarget.dataset.stickyScrollCapture = '1';

        item.scrollListener = newScrollListener;
        item.scrollListenerTarget = scrollCaptureTarget;
        item.retryCount = 0;
        this.fileResolveMap.set(id, item);
      } else {
        // If there's no contentEl, ensure we remove any existing listener.
        // Retry scheduling is handled by updateHeadings when appropriate.
        item.scrollListener = null;
        item.scrollListenerTarget = null;
        item.detectPosition = null;
        this.fileResolveMap.set(id, item);
      }
      this.updateHeadings(item.file, item.view, item);
      this.dumpDiagnostics(item.view, item);
    } catch (error) {
      console.warn('Failed to handle component update:', error);
    }
  }

  setHeadingsInView(scroller: HTMLElement, item: FileResolveEntry) {
    try {
      const { scrollTop } = scroller;
      const stuckHeaderHeight = getContainerEl(scroller)?.clientHeight || 0;
      if (item) {
        // Recompute offsets (synchronous, fast) but reuse cached titles (expensive part)
        const rawHeadings = getHeadings(item.file, this.app);
        if (!rawHeadings || rawHeadings.length === 0) {
          this.statusBarItemEl?.hide();
          return;
        }
        let freshHeadings: Heading[];
        try {
          freshHeadings = getShownHeadings(rawHeadings, item.view, this.settings);
        } catch (error) {
          console.warn('Failed to get shown headings in view, hiding status bar:', error);
          this.statusBarItemEl?.hide();
          return;
        }
        // Build a title cache map for O(1) lookup, keyed by file path + heading
        // start offset so titles from a different note or position don't leak in.
        const titleMap = new Map<string, string>();
        for (const h of item.headings) {
          if (item.file && h.position) {
            const key = `${item.file.path}::${h.position.start.offset}`;
            titleMap.set(key, h.title);
          }
        }
        const headings = freshHeadings.map(h => {
          if (item.file && h.position) {
            const key = `${item.file.path}::${h.position.start.offset}`;
            return {
              ...h,
              title: titleMap.get(key) || h.title,
            };
          }
          return h;
        });
        // Update cache with fresh offsets + preserved titles
        item.headings = headings;

        const headingsInView = headings.filter(heading => heading.offset < scrollTop + stuckHeaderHeight);
        let findalHeadings: Heading[] = [];
        // If no heading is "in view" yet we're at the very top, show the first one.
        const effectiveHeadingsInView = headingsInView.length || scrollTop > 0 ? headingsInView : headings.slice(0, 1);
        trivial(effectiveHeadingsInView, findalHeadings, this.settings.mode);
        if (this.settings.max) {
          findalHeadings = findalHeadings.slice(-this.settings.max);
        }
        item.currentIndex = findalHeadings.length ? findalHeadings[findalHeadings.length - 1].index : -1;
        const indentList = calcIndentLevels(findalHeadings);
        item.headingEl?.updateHeadings?.(
          findalHeadings.map((heading, i) => ({
            ...heading,
            indentLevel: indentList[i] || 0,
          })),
          item.getExpectedHeadings,
          this.settings.autoShowFileName && needShowFileName(item.file, this.app),
          item.view,
          item.file
        );
        this.statusBarItemEl?.switchFile(item.file, findalHeadings[findalHeadings.length - 1], item.view);
      } else {
        this.statusBarItemEl?.hide();
      }
    } catch (error) {
      console.warn('Failed to set headings in view:', error);
      this.statusBarItemEl?.hide();
    }
  }

  handleEditorChange(file: TFile | null) {
    if (file && isMarkdownFile(file)) {
      this.fileResolveMap.forEach(item => {
        if (item.file.path === file.path) {
          item.resolve = false;
        }
      });
    }
  }

  async handleResolve(file: TFile) {
    if (isMarkdownFile(file)) {
      const ids: string[] = [];
      for (const [id, item] of this.fileResolveMap) {
        if (item.file.path === file.path) {
          // Refresh headings — file content changed
          const myRev = ++item.resolveRevision;
          invalidateMarkdownCacheForFile(this.markdownCache, file);
          const headings = await this.retrieveHeadings(file, item.view);
          if (myRev !== item.resolveRevision) {
            return;
          }
          item.headings = headings;
          item.getExpectedHeadings = makeExpectedHeadings(
            () => item.headings,
            this.settings?.max ?? defaultSettings.max,
            this.settings?.mode ?? defaultSettings.mode
          );
          this.updateHeadings(file, item.view, item);

          if (!item.resolve) {
            item.resolve = true;
            ids.push(id);
          }
        }
      }
      if (ids.length > 0) {
        this.checkFileResolveMap();
      }

      if (this.fileResolveMap.size === 0) {
        this.clearStickyDiagnostics();
      }
    }
  }

  private scheduleScrollerRetry(id: string, view: MarkdownView) {
    const item = this.fileResolveMap.get(id);
    if (!item) return;
    if (item.retryTimer) {
      window.clearTimeout(item.retryTimer);
    }
    if (item.scrollListener) return; // already have a listener
    item.retryCount = (item.retryCount ?? 0) + 1;
    const MAX_RETRIES = 20;
    if (item.retryCount > MAX_RETRIES) return;
    const delay = Math.min(100 + item.retryCount ** 2 * 10, 3500);
    console.warn('[sticky-headings] scroller retry', { leafId: id, retryCount: item.retryCount });
    item.retryTimer = window.setTimeout(() => {
      item.retryTimer = undefined;
      if (!this.fileResolveMap.has(id)) return;
      if (this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf?.id !== id) return;
      this.handleComponentUpdate(view);
    }, delay);
  }

  checkFileResolveMap() {
    try {
      const validIds = new Set<string>();
      this.app.workspace.iterateAllLeaves(leaf => {
        try {
          if (leaf.view instanceof MarkdownView) {
            const { id } = leaf;
            if (id) {
              validIds.add(id);
              this.initStickyHeaderComponent(leaf.view);
            }
          }
        } catch (error) {
          console.warn('Error iterating leaf:', error);
        }
      });

      this.fileResolveMap.forEach((_, id) => {
        if (!validIds.has(id)) {
          const item = this.fileResolveMap.get(id);
          if (item) {
            item.headingEl?.removeStickyHeader?.();

            if (item.layoutChangeEvent) {
              this.app.workspace.offref(item.layoutChangeEvent);
            }

            if (item.scrollListener && item.scrollListenerTarget) {
              const useCapture = item.scrollListenerTarget === item.view?.contentEl;
              item.scrollListenerTarget.removeEventListener('scroll', item.scrollListener, useCapture);
            }

            if (item.retryTimer) {
              window.clearTimeout(item.retryTimer);
              item.retryTimer = undefined;
            }

            if (item.view?.contentEl) {
              delete item.view.contentEl.dataset.stickyScrollCapture;
            }
          }
          this.fileResolveMap.delete(id);
        }
      });

      if (this.fileResolveMap.size === 0) {
        this.clearStickyDiagnostics();
      }
    } catch (error) {
      console.warn('Failed to check file resolve map:', error);
    }
  }

  async retrieveHeadings(file: TFile, view: MarkdownView): Promise<Heading[]> {
    const headings = getHeadings(file, this.app);

    if (!headings || headings.length === 0) return [];

    return await Promise.all(
      getShownHeadings(headings, view, this.settings).map(async heading => {
        const cacheKey = `${file.path}::${heading.heading}`;
        let title: string;
        if (this.markdownCache.has(cacheKey)) {
          title = getCachedTitle(this.markdownCache, cacheKey, heading.heading);
        } else {
          try {
            title = await parseMarkdown(heading.heading, this.app, view);
          } catch (error) {
            console.warn('Failed to parse markdown title, falling back to raw heading:', error);
            title = heading.heading;
          }
          setCachedTitle(this.markdownCache, cacheKey, title);
        }
        return {
          ...heading,
          title,
        };
      })
    );
  }

  onSettingChanged() {
    this.settings = this.settings || { ...defaultSettings };
    this.fileResolveMap.forEach(item => {
      if (item.headingEl) {
        item.headingEl.updateSettings(this.settings);
      }
      item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);
    });
    if (this.statusBarEl) {
      if (this.settings.showInStatusBar) {
        this.statusBarEl.style.display = 'inline-flex';
      } else {
        this.statusBarEl.style.display = 'none';
      }
    }
  }

  onunload() {
    this.fileResolveMap.forEach((item, id) => {
      try {
        item?.headingEl?.removeStickyHeader?.();

        if (item?.layoutChangeEvent) {
          this.app.workspace.offref(item.layoutChangeEvent);
        }

        if (item?.scrollListener && item?.scrollListenerTarget) {
          const useCapture = item.scrollListenerTarget === item.view?.contentEl;
          item.scrollListenerTarget.removeEventListener('scroll', item.scrollListener, useCapture);
        }

        if (item?.retryTimer) {
          window.clearTimeout(item.retryTimer);
          item.retryTimer = undefined;
        }

        if (item?.view?.contentEl) {
          delete item.view.contentEl.dataset.stickyScrollCapture;
        }
      } catch (error) {
        console.warn(`Error unloading sticky header for leaf ${id}:`, error);
      }
    });

    try {
      this.statusBarItemEl?.removeStickyHeader?.();
      this.statusBarItemEl = undefined;
      if (this.statusBarEl && this.statusBarClickHandler) {
        this.statusBarEl.removeEventListener('click', this.statusBarClickHandler);
      }
    } catch (error) {
      console.warn('Error unloading status bar item:', error);
    }

    this.fileResolveMap.clear();
    this.clearStickyDiagnostics();
  }

  async loadSettings() {
    this.settings = this.normalizeSettings((await this.loadData()) as Partial<ISetting> | undefined);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
