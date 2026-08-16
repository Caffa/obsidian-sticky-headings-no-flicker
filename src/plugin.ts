/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { TFile } from 'obsidian';
import { MarkdownView, Plugin } from 'obsidian';
import type { FileResolveEntry, Heading, ISetting } from './types';
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
import { animateScroll } from './utils/scroll';

type FileResolveMap = Map<string, FileResolveEntry>;

export default class StickyHeadingsPlugin extends Plugin {
  settings: ISetting = defaultSettings;
  headingEl: StickyHeaderComponent | undefined;
  statusBarItemEl: StatusBarItemComponent | undefined;
  fileResolveMap: FileResolveMap = new Map();
  statusBarEl: HTMLElement | undefined;
  statusBarClickHandler: (() => void) | undefined;
  markdownCache: Record<string, string> = {};

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onload() {
    try {
      await this.loadSettings();
    } catch (error) {
      console.warn('Failed to load sticky headings settings, using defaults:', error);
    }

    try {
      try {
        this.initStatusBarItem();
      } catch (error) {
        console.warn('Failed to init status bar item:', error);
      }

      try {
        this.registerEvent(
          this.app.workspace.on('active-leaf-change', () => {
            // timeout to wait for cm.editor to load
            setTimeout(() => {
              this.checkFileResolveMap();
            }, 100);
          })
        );
      } catch (error) {
        console.warn('Failed to register active-leaf-change event:', error);
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

      this.addSettingTab(new StickyHeadingsSetting(this.app, this));
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
    if (!this.settings.showInStatusBar) {
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
          if (this.settings.scrollBehaviour === 'instant') {
            scroller.scrollTo({ top: offset - height - 4, behavior: 'instant' });
          } else {
            animateScroll(scroller, offset - height - 4, 1000);
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
            item.headingEl.predictHeadingsHeight(item.getExpectedHeadings(index));
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
      if (file && isMarkdownFile(file)) {
        const headings = await this.retrieveHeadings(file, view);
        if (!this.fileResolveMap.has(id)) {
          const headingEl = new StickyHeaderComponent(view, this.settings);
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          const layoutChangeEvent = this.app.workspace.on('layout-change', this.handleComponentUpdate.bind(this, view));
          const getExpected = makeExpectedHeadings(headings, this.settings.max, this.settings.mode);
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
          });
          this.registerEvent(layoutChangeEvent);
        } else {
          const item = this.fileResolveMap.get(id);
          if (item) {
            item.editMode = isEditSourceMode(view);
            item.headings = headings;
            item.getExpectedHeadings = makeExpectedHeadings(headings, this.settings.max, this.settings.mode);
            item.file = file;
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
      if (!item.headingEl.stickyHeaderComponents?.length) {
        item.headingEl.addStickyHeader(item.view, this.settings);
      }
      // Refresh headings — layout changed, so offsets need recomputing
      const headings = await this.retrieveHeadings(item.file, view);
      item.headings = headings;
      item.getExpectedHeadings = makeExpectedHeadings(headings, this.settings.max, this.settings.mode);

      // Remove existing scroll listener from the element it was actually attached to
      if (item.scrollListener && item.scrollListenerTarget) {
        const useCapture = item.scrollListenerTarget !== item.view.contentEl;
        item.scrollListenerTarget.removeEventListener('scroll', item.scrollListener, useCapture);
      }

      item.editMode = isEditSourceMode(item.view);
      try {
        item.headingEl.updateEditMode(isEditSourceMode(item.view));
      } catch (error) {
        console.warn('Failed to update edit mode on sticky header:', error);
      }

      if (scroller) {
        this.setHeadingsInView(scroller, item);
        // Create per-leaf throttled position detector
        item.detectPosition = throttle(
          (event: Event, throttledScroller: HTMLElement) => {
            this.setHeadingsInView(throttledScroller, item);
          },
          50,
          { leading: true, trailing: true }
        );
        const newScrollListener = (event: Event) => {
          item.detectPosition?.(event, scroller);
        };
        const useCapture = scroller !== item.view.contentEl;
        scroller.addEventListener('scroll', newScrollListener, useCapture);

        // Update the fileResolveMap with the new scroll listener and its target
        item.scrollListener = newScrollListener;
        item.scrollListenerTarget = scroller;
        this.fileResolveMap.set(id, item);
      } else {
        // If there's no scroller, ensure we remove any existing listener
        item.scrollListener = null;
        item.scrollListenerTarget = null;
        item.detectPosition = null;
        this.fileResolveMap.set(id, item);
      }
      this.updateHeadings(item.file, item.view, item);
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
        // Build a title cache map for O(1) lookup
        const titleMap = new Map<string, string>();
        for (const h of item.headings) {
          titleMap.set(h.heading, h.title);
        }
        const headings = freshHeadings.map(h => ({
          ...h,
          title: titleMap.get(h.heading) || h.title,
        }));
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
          item.view
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
          const headings = await this.retrieveHeadings(file, item.view);
          item.headings = headings;
          item.getExpectedHeadings = makeExpectedHeadings(headings, this.settings.max, this.settings.mode);
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
    }
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
              const useCapture = item.scrollListenerTarget !== item.view?.contentEl;
              item.scrollListenerTarget.removeEventListener('scroll', item.scrollListener, useCapture);
            }
          }
          this.fileResolveMap.delete(id);
        }
      });
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
        if (cacheKey in this.markdownCache) {
          title = this.markdownCache[cacheKey];
        } else {
          try {
            title = await parseMarkdown(heading.heading, this.app, view);
          } catch (error) {
            console.warn('Failed to parse markdown title, falling back to raw heading:', error);
            title = heading.heading;
          }
          this.markdownCache[cacheKey] = title;
        }
        return {
          ...heading,
          title,
        };
      })
    );
  }

  onSettingChanged() {
    this.fileResolveMap.forEach(item => {
      if (item.headingEl) {
        item.headingEl.updateSettings(this.settings);
      }
      item.getExpectedHeadings = makeExpectedHeadings(item.headings, this.settings.max, this.settings.mode);
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
          const useCapture = item.scrollListenerTarget !== item.view?.contentEl;
          item.scrollListenerTarget.removeEventListener('scroll', item.scrollListener, useCapture);
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
  }

  async loadSettings() {
    this.settings = {
      ...defaultSettings,
      ...((await this.loadData()) as ISetting),
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
