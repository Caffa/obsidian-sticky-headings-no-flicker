/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { TFile } from 'obsidian';
import { MarkdownView, Plugin } from 'obsidian';
import type { FileResolveEntry, Heading, ISetting, RetrieveHeadingsResult } from './types';
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

import StickyHeaderComponent, { resolveMountContainers } from './stickyHeader';
import StatusBarItemComponent from './ui/statusBar/statusBarItem';
import getShownHeadings, { trivial } from './utils/getShownHeadings';
import { throttle, debounce } from 'lodash';
import { calcIndentLevels } from './utils/calcIndentLevels';
import { makeExpectedHeadings } from './utils/makeExpectedHeadings';
import { HeadingSuggester } from './ui/statusBar/suggester';
import { animateScroll, computeScrollTop } from './utils/scroll';
import { configureAnchorDebugSink, traceEvent } from './utils/anchorDebug';
import { computeHeadingSignature } from './utils/headingSignature';
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
  // Per-leaf init serialization (same string keying as fileResolveMap).
  // Prevents concurrent initStickyHeaderComponent calls for the same leaf from
  // both passing the fileResolveMap has(id) re-check inside the await window
  // and building duplicate StickyHeaderComponents.
  private initInFlight = new Set<string>();

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
      if (document.body.dataset.stickyHeadingsDebug === '1') {
        console.warn('[sticky-headings] diag', diag);
      }
    } catch (error) {
      console.warn('[sticky-headings] diag failed:', error);
    }
  }

  /**
   * lazy-plugins / hot-reload disable→enable the plugin at every app start.
   * The debug flag (`document.body.dataset.stickyHeadingsDebug`) is set from
   * the marker file and is deliberately NEVER cleared on unload or map-empty:
   * clearing it here blinded the tracer for the re-enabled instance, hiding
   * every trace after the first lifecycle cycle.
   */

  /**
   * lazy-plugins / hot-reload disable→enable the plugin at every app start.
   * The debug flag (`document.body.dataset.stickyHeadingsDebug`) is set from
   * the marker file and is deliberately NEVER cleared on unload or map-empty:
   * clearing it here blinded the tracer for the re-enabled instance, hiding
   * every trace after the first lifecycle cycle.
   */

  /**
   * When the plugin is disabled→re-enabled mid-session (lazy-plugins at app
   * start, hot-reload deploys) or a leaf's view is swapped while we were
   * dead, `item.view` is stale: components keep rendering (font changes still
   * apply via rootStyles) but rect reads hit the dead `view.contentEl` and
   * `computeEffectiveTop` returns null — the position freezes forever. The
   * leaf object itself is stable; `leaf.view` always points at the live view,
   * so rebind from it before anything measures the stale DOM.
   */
  private rebindItemViewIfStale(id: string, item: FileResolveEntry): boolean {
    try {
      const liveView = item.view?.leaf?.view;
      if (liveView && liveView !== item.view && liveView instanceof MarkdownView && liveView.getFile()) {
        item.view = liveView;
        item.container = liveView.contentEl;
        if (document.body.dataset.stickyHeadingsDebug === '1') {
          console.warn('[sticky-headings] rebound stale item.view from leaf', id);
        }
        return true;
      }
      return false;
    } catch (error) {
      if (document.body.dataset.stickyHeadingsDebug === '1') {
        console.warn('[sticky-headings] rebindItemViewIfStale failed:', { id, error });
      }
      return false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onload() {
    // File-based debug trace: drop a `debug.txt` into the plugin folder to
    // enable anchor debug logging and mirror it to `debug-trace.jsonl` next to
    // it. Uses the vault DataAdapter (paths are vault-root-relative, matching
    // `manifest.dir`) so it works wherever the vault lives — no node fs.
    void (async () => {
      try {
        const { adapter } = this.app.vault;
        const marker = `${this.manifest.dir}/debug.txt`;
        if (await adapter.exists(marker)) {
          document.body.dataset.stickyHeadingsDebug = '1';
          const tracePath = `${this.manifest.dir}/debug-trace.jsonl`;
          // Append-only: every onload/reload appends a fresh `trace-open`
          // line, so prior sessions' lines survive as evidence of reload
          // loops (e.g. lazy-plugins/hot-reload kill+revive cycles).
          // Fire-and-forget per-line appends. A serial promise chain here
          // black-holes every later line the moment one append stays pending;
          // independent writes can never block each other.
          const sink = (line: string) => {
            void adapter.append(tracePath, line + '\n').catch(() => {});
          };
          configureAnchorDebugSink(sink, this.manifest);
        }
      } catch {
        // never interfere with plugin startup
      }
    })();

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
            // A freshly shown tab should correct its anchor position within a
            // frame instead of waiting for the async update chain below.
            const item = activeLeafId ? this.fileResolveMap.get(activeLeafId) : undefined;
            try {
              item?.headingEl?.refreshAnchor?.();
            } catch (error) {
              if (document.body.dataset.stickyHeadingsDebug === '1') {
                console.warn('Failed to refresh anchor on leaf activation:', error);
              }
            }
            // timeout to wait for cm.editor to load
            setTimeout(() => {
              if (activeLeafId === this.lastActiveLeafId) {
                this.checkFileResolveMap();
                // Plan B: flush work deferred while this leaf sat in the
                // background (resolve events marked it dirty instead of
                // rebuilding). Inactive-leaf headers are invisible, but the
                // freshly-shown leaf must not render stale headings.
                const activeItem = activeLeafId ? this.fileResolveMap.get(activeLeafId) : undefined;
                if (activeLeafId && activeItem?.dirty) {
                  this.flushDirtyLeaf(activeItem, activeLeafId);
                }
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
            void this.handleResolve(file).catch(error => {
              if (document.body.dataset.stickyHeadingsDebug === '1') {
                console.warn('[sticky-headings] handleResolve rejected:', error);
              }
            });
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

      try {
        this.registerInterval(
          window.setInterval(
            () => {
              void this.healthCheckActiveLeaf();
            },
            Platform.isMobile ? 30000 : 5000
          )
        );
      } catch (error) {
        console.warn('Failed to register health check interval:', error);
      }

      try {
        // Catch-up pass: leaves already open before the plugin loaded (enable
        // toggle, app reload, hot-swap deploy) never fire active-leaf-change,
        // so without this they stay header-less until manually re-focused.
        // Strictly idempotent and silent — anything skipped here (no file yet,
        // metadata pending) is covered later by the event handlers above.
        this.app.workspace.onLayoutReady(() => {
          this.app.workspace.iterateAllLeaves(leaf => {
            try {
              const view = leaf?.view;
              if (!(view && view instanceof MarkdownView)) return;
              const leafId = view.leaf?.id;
              if (!leafId) return;
              if (this.fileResolveMap.has(leafId)) return; // idempotent: never re-init
              if (this.settings.mode === 'disable') return;
              if (!view.getFile()) return; // metadata not ready yet
              this.initStickyHeaderComponent(view);
            } catch (error) {
              if (document.body.dataset.stickyHeadingsDebug === '1') {
                console.warn('[sticky-headings] layout-ready leaf init failed:', error);
              }
            }
          });
        });
      } catch (error) {
        console.warn('Failed to register layout-ready leaf catch-up:', error);
      }
    } catch (error) {
      console.warn('Sticky headings plugin onload encountered an error:', error);
    }
  }

  async healthCheckActiveLeaf() {
    // Heartbeat: steady-state trace output proving whether init completes and
    // components exist even when nothing else fires. Best-effort only.
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const leafId = view?.leaf?.id ?? null;
      const item = leafId ? this.fileResolveMap.get(leafId) : undefined;
      traceEvent('heartbeat', {
        items: this.fileResolveMap.size,
        leafId,
        components: item?.headingEl?.stickyHeaderComponents?.length ?? 0,
        headingsLen: item?.headings?.length ?? 0,
      });
    } catch {
      // heartbeat must never break the health check
    }
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) return;
      const leafId = view.leaf?.id;
      if (!leafId) return;

      const item = this.fileResolveMap.get(leafId);
      if (!item) {
        this.initStickyHeaderComponent(view);
        return;
      }

      // The active view may have been swapped while we held a stale item.view
      // (lazy-plugins/hot-reload). Rebind, then let the full update rebuild
      // mount targets against the live view; return so the watchdog below
      // doesn't also fire against the stale reference.
      if (this.rebindItemViewIfStale(leafId, item)) {
        void this.handleComponentUpdate(item.view).catch(() => {});
        return;
      }

      const healthy =
        view.contentEl.isConnected &&
        (item.headingEl?.stickyHeaderComponents?.length ?? 0) > 0 &&
        item.scrollListener != null &&
        item.headingEl?.hasMountTargetFor(view);

      if (healthy) {
        item.watchdogRecoveries = 0;
        item.watchdogRecoveryWindowStart = undefined;
        return;
      }

      if (item.retryTimer || item.watchdogRecovering || item.handleUpdateInFlight) {
        // Force-clear an in-flight guard that has been stuck for too long.
        if (
          item.handleUpdateInFlight &&
          item.handleUpdateInFlightSince &&
          Date.now() - item.handleUpdateInFlightSince > 3000
        ) {
          if (document.body.dataset.stickyHeadingsDebug === '1') {
            console.warn('[sticky-headings] healthCheck clearing stuck in-flight guard', leafId);
          }
          item.handleUpdateInFlight = false;
          item.handleUpdateInFlightSince = undefined;
        } else {
          return;
        }
      }

      const now = Date.now();
      if (!item.watchdogRecoveryWindowStart || now - item.watchdogRecoveryWindowStart > 60000) {
        item.watchdogRecoveryWindowStart = now;
        item.watchdogRecoveries = 0;
      }
      item.watchdogRecoveries = (item.watchdogRecoveries ?? 0) + 1;

      if ((item.watchdogRecoveries ?? 0) > 5) {
        if (document.body.dataset.stickyHeadingsDebug === '1') {
          console.warn('[sticky-headings] healthCheck giving up on leaf', leafId);
        }
        return;
      }

      if (document.body.dataset.stickyHeadingsDebug === '1') {
        console.warn('[sticky-headings] healthCheck recover leaf', leafId);
      }
      item.watchdogRecovering = true;
      try {
        await this.handleComponentUpdate(view);
      } finally {
        item.watchdogRecovering = false;
        // Reset recovery counters if the recovery left the leaf healthy.
        if (item.headingEl?.stickyHeaderComponents?.length > 0 && item.scrollListener != null) {
          item.watchdogRecoveries = 0;
          item.watchdogRecoveryWindowStart = undefined;
        }
      }
    } catch (error) {
      if (document.body.dataset.stickyHeadingsDebug === '1') {
        console.warn('[sticky-headings] healthCheck failed:', error);
      }
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

  /**
   * Plan B: per-leaf layout-change coalescing. Obsidian fires layout-change
   * in bursts (pane resizes, mode toggles) and each full update is an async
   * retrieveHeadings + remount check. Leading+trailing debounce keeps the
   * first reaction immediate and collapses the burst into one follow-up.
   * The debounced fn owns the update work; event registration stays
   * one-per-leaf so teardown can offref + cancel it.
   */
  private createDebouncedLayoutUpdate(view: MarkdownView) {
    return debounce(
      () => {
        void this.handleComponentUpdate(view).catch(() => {});
      },
      300,
      { leading: true, trailing: true }
    );
  }

  async initStickyHeaderComponent(view: MarkdownView) {
    // Serialize per-leaf init: layout-ready catch-up, checkFileResolveMap
    // timers, and the 5s health check can overlap for the same leaf id. Both
    // callers would pass the fileResolveMap has(id) re-check while
    // retrieveHeadings is in flight and each build a StickyHeaderComponent —
    // the second map-set orphans the first, whose DOM + EventRef stay mounted
    // forever. Mirrors the handleUpdateInFlight pattern.
    const leafId = view?.leaf?.id;
    if (!leafId) return;
    traceEvent('leaf-init', { leafId, path: view.file?.path ?? null });
    if (this.initInFlight.has(leafId)) return;
    this.initInFlight.add(leafId);
    try {
      const { id } = view?.leaf ?? {};
      if (!id) return;
      const file = view.getFile();
      const settings = this.settings ?? { ...defaultSettings };
      if (file && isMarkdownFile(file)) {
        // Already initialized for the same file: nothing to (re)init. Background
        // dirty-flush is handled by the active-leaf-change handler, and health
        // issues are handled by the health-check watchdog.
        const existing = this.fileResolveMap.get(id);
        if (existing && existing.file?.path === file.path) {
          return;
        }

        const { headings, timedOut } = await this.retrieveHeadings(file, view);
        if (!this.fileResolveMap.has(id)) {
          const headingEl = new StickyHeaderComponent(view, settings);
          const debouncedLayoutUpdate = this.createDebouncedLayoutUpdate(view);
          const layoutChangeEvent = this.app.workspace.on('layout-change', debouncedLayoutUpdate);
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
            debouncedLayoutUpdate,
            // Seed the gate so the first resolve after init can hit the skip path,
            // but only when the retrieve did not time out (raw titles must stay
            // gate-open until a healthy resolve self-heals).
            lastHeadingSignature: !timedOut ? computeHeadingSignature(file, this.app) : undefined,
            editMode: isEditSourceMode(view),
            currentIndex: -1,
            resolveRevision: 0,
          });
          this.registerEvent(layoutChangeEvent);
        } else {
          const item = this.fileResolveMap.get(id);
          if (item) {
            // Tear down the previous mount + listeners bound to the now-stale DOM
            // before constructing the new component. This prevents the ref count
            // from dropping to 0 when both components share the same target.
            try {
              item.headingEl?.removeStickyHeader?.();
            } catch (e) {
              if (document.body.dataset.stickyHeadingsDebug === '1') {
                console.warn('Failed to remove old sticky header on same-leaf file change:', e);
              }
              // The old component is still mounted and working; never continue
              // into reinit with a half-torn-down mount target.
              return;
            }
            item.debouncedLayoutUpdate?.cancel();
            if (item.layoutChangeEvent) {
              this.app.workspace.offref(item.layoutChangeEvent);
            }
            if (item.scrollListener && item.scrollListenerTarget) {
              const useCapture = item.scrollListenerTarget === item.view?.contentEl;
              item.scrollListenerTarget.removeEventListener('scroll', item.scrollListener, useCapture);
            }
            item.scrollListener = null;
            item.scrollListenerTarget = null;
            item.detectPosition = null;

            if (item.retryTimer) {
              window.clearTimeout(item.retryTimer);
              item.retryTimer = undefined;
            }
            if (item.dirtyFlushRetryTimer) {
              window.clearTimeout(item.dirtyFlushRetryTimer);
              item.dirtyFlushRetryTimer = undefined;
            }

            // Build new state after old teardown so shared DOM targets keep
            // their positioning-context classes throughout the swap.
            const newHeadingEl = new StickyHeaderComponent(view, settings);
            const newDebouncedUpdate = this.createDebouncedLayoutUpdate(view);
            const newLayoutChange = this.app.workspace.on('layout-change', newDebouncedUpdate);

            // Rebind everything to the (reused) view with the new file.
            item.view = view;
            item.file = file;
            item.container = view.contentEl;
            item.editMode = isEditSourceMode(view);
            item.headings = headings;
            item.lastHeadingSignature = !timedOut ? computeHeadingSignature(file, this.app) : undefined;
            item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, settings.max, settings.mode);
            item.currentIndex = -1;
            item.resolveRevision++;
            item.retryCount = 0;

            item.headingEl = newHeadingEl;
            item.layoutChangeEvent = newLayoutChange;
            item.debouncedLayoutUpdate = newDebouncedUpdate;
            this.registerEvent(newLayoutChange);
            // Work was just completed for this leaf; don't re-flush it on next activation.
            item.dirty = false;
          }
        }
        await this.handleComponentUpdate(view);
        traceEvent('leaf-init-done', {
          leafId,
          components: this.fileResolveMap.get(id)?.headingEl?.stickyHeaderComponents?.length ?? 0,
        });
      }
    } catch (error) {
      console.warn('Failed to init sticky header component:', error);
    } finally {
      this.initInFlight.delete(leafId);
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
    const { id } = view?.leaf ?? {};
    if (!id) return;
    const item = this.fileResolveMap.get(id);
    if (!item) return;
    // Rebind before touching item.view: after a lazy-plugins/hot-reload
    // reload or a view swap, item.view may reference a dead view whose
    // contentEl reports zero rects (position frozen while font updates still
    // applied). From here on, measure the item's live view, not the possibly
    // stale parameter — the mount-target checks below already read item.view.
    this.rebindItemViewIfStale(id, item);
    ({ view } = item);
    if (item.handleUpdateInFlight) return;
    traceEvent('component-update', {
      leafId: id,
      components: item.headingEl?.stickyHeaderComponents?.length ?? 0,
      headingsLen: item.headings.length,
    });
    item.handleUpdateInFlight = true;
    item.handleUpdateInFlightSince = Date.now();
    try {
      // Refresh the anchor EARLY, before the async heading retrieval: fast
      // mode toggles and layout churn must not leave the header pinned to a
      // stale top for seconds while retrieveHeadings is in flight.
      try {
        item.headingEl?.refreshAnchor?.();
      } catch (error) {
        if (document.body.dataset.stickyHeadingsDebug === '1') {
          console.warn('Failed to refresh anchor early on component update:', error);
        }
      }

      const scroller = getScroller(view);

      // Always use the live file when available; item.file may be stale after swaps.
      const liveFile = view.getFile() ?? item.file;

      // Refresh headings — layout changed, so offsets need recomputing
      const { headings, timedOut } = await this.retrieveHeadings(liveFile, view);
      if (this.fileResolveMap.get(id) !== item) {
        return;
      }

      // Defensive: don't overwrite existing rendered headings with an empty result
      // when the live file still matches the tracked file.
      if (headings.length === 0 && item.headings.length > 0 && liveFile.path === item.file.path) {
        if (document.body.dataset.stickyHeadingsDebug === '1') {
          if (document.body.dataset.stickyHeadingsDebug === '1') {
            console.warn('[sticky-headings] handleComponentUpdate preserving non-empty headings', {
              file: liveFile.path,
            });
          }
        }
      } else {
        item.headings = headings;
        // Refresh the gate alongside the committed headings so layout-driven
        // recomputes keep it valid — a stale signature would wrongly skip later
        // resolves for genuinely-changed heading structures. This must stay
        // INSIDE the commit branch: the preserved-fallback branch above left
        // item.headings describing the OLD shown state, so storing the fresh
        // signature there would make every later resolve hit the skip gate
        // with stale headers frozen forever. With an offset-invariant gate,
        // a timed-out retrieve must also leave the gate open so the next
        // healthy resolve self-heals instead of freezing raw titles.
        if (!timedOut) {
          item.lastHeadingSignature = computeHeadingSignature(liveFile, this.app);
        }
      }
      item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);

      // Only mount / remount after we know this async call is still the latest for the leaf.
      const currentTargets = resolveMountContainers(item.view);
      const mountContextLost =
        currentTargets.length > 0 &&
        currentTargets.some(
          target => !target.hasClass('sticky-headings-mount') || !item.view.contentEl.hasClass('has-sticky-headings')
        );
      const needsRemount =
        !item.headingEl.stickyHeaderComponents?.length ||
        (currentTargets.length > 0 && !item.headingEl.hasMountTargetFor(item.view)) ||
        mountContextLost;
      if (needsRemount) {
        item.headingEl.addStickyHeader(item.view, this.settings);
      }

      // If the mount still produced no components, schedule a scroller retry so
      // we don't leave the leaf stuck without a sticky header.
      if (item.headingEl.stickyHeaderComponents?.length === 0) {
        this.scheduleScrollerRetry(id, view);
      }

      // Remove existing scroll listener from the element it was actually attached to
      if (item.scrollListener && item.scrollListenerTarget) {
        const useCapture = item.scrollListenerTarget === item.view.contentEl;
        item.scrollListenerTarget.removeEventListener('scroll', item.scrollListener, useCapture);
      }

      item.editMode = isEditSourceMode(item.view);
      try {
        item.headingEl.updateEditMode(isEditSourceMode(item.view));
      } catch (error) {
        if (document.body.dataset.stickyHeadingsDebug === '1') {
          console.warn('Failed to update edit mode on sticky header:', error);
        }
      }

      try {
        item.headingEl?.refreshAnchor?.();
      } catch (error) {
        if (document.body.dataset.stickyHeadingsDebug === '1') {
          console.warn('Failed to refresh anchor on sticky header:', error);
        }
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
      this.updateHeadings(liveFile, item.view, item);
      this.dumpDiagnostics(item.view, item);
    } catch (error) {
      if (document.body.dataset.stickyHeadingsDebug === '1') {
        console.warn('[sticky-headings] Failed to handle component update:', error);
      }
    } finally {
      item.handleUpdateInFlight = false;
      item.handleUpdateInFlightSince = undefined;
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

  async handleResolve(file: TFile) {
    if (isMarkdownFile(file)) {
      const ids: string[] = [];
      for (const [id, item] of this.fileResolveMap) {
        try {
          // Defensive stale-file guard: skip if the tracked file is unloaded or
          // the live view has moved on to a different file.
          const liveFile = item.view?.getFile?.();
          if (!item.file || (liveFile && liveFile.path !== item.file.path)) {
            continue;
          }

          if (item.file.path === file.path) {
            // Plan A equality gate: the signature is computed BEFORE the cache
            // invalidation. Resolve fires for every metadata pass, but only a
            // heading-structure change needs the parse + rebuild.
            const sig = computeHeadingSignature(file, this.app);
            const activeLeafId = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf?.id;
            const isActiveLeaf = id === activeLeafId;
            if (sig === item.lastHeadingSignature && item.headings?.length) {
              traceEvent('resolve-skip', { path: file.path, leafId: id, active: isActiveLeaf });
              if (!item.resolve) {
                item.resolve = true;
                ids.push(id);
              }
              continue;
            }
            // Plan B background gating: inactive-leaf headers are invisible,
            // so defer the rebuild until the leaf is activated again. Do NOT
            // store the signature here: this branch defers retrieve+commit,
            // so storing sig with no commit behind it would freeze subsequent
            // resolves behind the skip gate. The flush commit stores a fresh,
            // commit-backed signature.
            if (!isActiveLeaf) {
              item.dirty = true;
              traceEvent('leaf-dirty-defer', { path: file.path, leafId: id });
              if (!item.resolve) {
                item.resolve = true;
                ids.push(id);
              }
              continue;
            }
            traceEvent('resolve-rebuild', { path: file.path, leafId: id });
            // Refresh headings — file content changed
            const myRev = ++item.resolveRevision;
            invalidateMarkdownCacheForFile(this.markdownCache, file);
            const { headings, timedOut } = await this.retrieveHeadings(file, item.view);
            if (myRev !== item.resolveRevision) {
              return;
            }
            item.headings = headings;
            // Store the gate signature only for a fully-parsed commit. The
            // 1.5s timeout fallback commits RAW unparsed titles; leaving the
            // OLD signature untouched then makes the next resolve gate-miss
            // and self-heal via a re-parse. (Storing before/without parsed
            // headings would freeze the raw titles behind the skip gate.)
            if (!timedOut) {
              item.lastHeadingSignature = sig;
            }
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
        } catch (error) {
          if (document.body.dataset.stickyHeadingsDebug === '1') {
            console.warn('[sticky-headings] handleResolve iteration failed:', { id, file: file.path, error });
          }
          try {
            item.resolve = false;
            ids.push(id);
          } catch {
            // ignore
          }
        }
      }
      if (ids.length > 0) {
        this.checkFileResolveMap();
      }
    }
  }

  /**
   * Flush a leaf's deferred (dirty) rebuild. Mutex-aware: handleComponentUpdate
   * silently no-ops while an update is already in flight (its retrieveHeadings
   * can hold the mutex up to ~1.5s), so the dirty flag is only cleared once the
   * update actually starts. While busy, keep `dirty` set and retry after a
   * short window — guarded against stacking, and aborted if the leaf was
   * replaced or went inactive again (the next activation re-flushes).
   */
  private flushDirtyLeaf(item: FileResolveEntry, leafId: string) {
    if (item.handleUpdateInFlight) {
      if (item.dirtyFlushRetryTimer) return; // retry already pending
      traceEvent('leaf-dirty-flush-retry', { leafId, path: item.file?.path ?? null });
      item.dirtyFlushRetryTimer = window.setTimeout(() => {
        item.dirtyFlushRetryTimer = undefined;
        // Same mutex-aware decision as the initial flush: re-mark (dirty was
        // never cleared) + re-schedule if still busy, else clear + update.
        if (this.fileResolveMap.get(leafId) !== item) return;
        if (this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf?.id !== leafId) return;
        if (!item.dirty) return; // already flushed
        this.flushDirtyLeaf(item, leafId);
      }, 300);
      return;
    }
    item.dirty = false;
    traceEvent('leaf-dirty-flush', { leafId, path: item.file?.path ?? null });
    void this.handleComponentUpdate(item.view).catch(() => {});
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
    if (document.body.dataset.stickyHeadingsDebug === '1') {
      console.warn('[sticky-headings] scroller retry', { leafId: id, retryCount: item.retryCount });
    }
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
            item.debouncedLayoutUpdate?.cancel();

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
            if (item.dirtyFlushRetryTimer) {
              window.clearTimeout(item.dirtyFlushRetryTimer);
              item.dirtyFlushRetryTimer = undefined;
            }
          }
          this.fileResolveMap.delete(id);
        }
      });
    } catch (error) {
      console.warn('Failed to check file resolve map:', error);
    }
  }

  async retrieveHeadings(file: TFile, view: MarkdownView): Promise<RetrieveHeadingsResult> {
    const headings = getHeadings(file, this.app);

    if (!headings || headings.length === 0) return { headings: [], timedOut: false };

    const shownHeadings = getShownHeadings(headings, view, this.settings);
    traceEvent('retrieve-start', { path: file.path, shown: shownHeadings.length });

    const renderPromise = Promise.all(
      shownHeadings.map(async heading => {
        const cacheKey = `${file.path}::${heading.heading}`;
        let title: string;
        if (this.markdownCache.has(cacheKey)) {
          title = getCachedTitle(this.markdownCache, cacheKey, heading.heading);
        } else {
          try {
            title = await parseMarkdown(heading.heading, this.app, view);
          } catch (error) {
            if (document.body.dataset.stickyHeadingsDebug === '1') {
              console.warn('Failed to parse markdown title, falling back to raw heading:', error);
            }
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

    let timeoutId = 0;
    let timedOut = false;
    const timeoutPromise = new Promise<Heading[]>(resolve => {
      timeoutId = window.setTimeout(() => {
        timedOut = true;
        if (document.body.dataset.stickyHeadingsDebug === '1') {
          console.warn('[sticky-headings] retrieveHeadings timeout', { file: file.path, count: headings.length });
        }
        resolve(shownHeadings.map(h => ({ ...h, title: h.heading })));
      }, 1500);
    });

    const result = await Promise.race([renderPromise, timeoutPromise]);
    // Defuse whichever side lost the race: render won → stop the timer;
    // timeout won → the render keeps running (its per-heading setCachedTitle
    // writes still land in markdownCache) but its result goes unused, and a
    // rejection must never surface as unhandled.
    window.clearTimeout(timeoutId);
    void renderPromise.catch(() => {});
    traceEvent('retrieve-done', { path: file.path, len: result.length, timedOut });
    // `timedOut` lets callers distinguish a fully-parsed result from the RAW
    // unparsed-title fallback — an equality-gate commit must never treat the
    // fallback as final (see handleResolve).
    return { headings: result, timedOut };
  }

  onSettingChanged() {
    this.settings = this.settings || { ...defaultSettings };
    traceEvent('settings-changed', {
      desktopTopOffset: this.settings.desktopTopOffset,
      mobileTopOffset: this.settings.mobileTopOffset,
      fontSize: this.settings.fontSize,
      items: this.fileResolveMap.size,
    });
    this.fileResolveMap.forEach((item, leafId) => {
      // max/mode change which headings are shown → drop the gate signature so
      // the next resolve for each file recomputes once instead of skipping.
      item.lastHeadingSignature = undefined;
      // lazy-plugins/hot-reload can leave item.view pointing at a dead view;
      // rebinding first lets updateSettings + the follow-up full update run
      // against the live DOM instead of freezing the position on null rects.
      const rebound = this.rebindItemViewIfStale(leafId, item);
      if (item.headingEl) {
        item.headingEl.updateSettings(this.settings);
      }
      traceEvent('apply-settings', { leafId });
      item.getExpectedHeadings = makeExpectedHeadings(() => item.headings, this.settings.max, this.settings.mode);
      try {
        item.headingEl?.refreshAnchor?.();
      } catch (error) {
        if (document.body.dataset.stickyHeadingsDebug === '1') {
          console.warn('Failed to refresh anchor after setting change:', error);
        }
      }
      if (rebound) {
        // Fire-and-forget: handleComponentUpdate has its own in-flight mutex
        // and re-runs mount-target drift, headings and refreshAnchor against
        // the fresh view.
        void this.handleComponentUpdate(item.view).catch(() => {});
      }
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
    // Outer guarantee: lazy-plugins awaits disablePluginAndSave(id) at every
    // app start before re-enabling us. An exception escaping onunload would
    // break that disable→enable cycle and leave the plugin half-unloaded.
    // Nothing below is allowed to propagate — the inner try/catches stay as
    // first-line defense, this one is the last resort.
    try {
      // First line of unload: stamp WHEN we were torn down, before any cleanup
      // can fail. onload → plugin-unload seconds later exposes reload loops
      // (lazy-plugins / hot-reload) directly in debug-trace.jsonl. Own try/catch
      // so tracing can never break unload.
      try {
        traceEvent('plugin-unload', { items: this.fileResolveMap.size });
      } catch {
        // ignore — tracing must never interfere with unload
      }
      // The settings modal persists across plugin toggles; its left-behind pane
      // stays bound to the destroyed plugin instance and absorbs slider events
      // with no tracing. Closing it on unload forces a rebuild bound to the
      // live instance.
      try {
        (this.app as unknown as { setting?: { close?: () => void } }).setting?.close?.();
      } catch {
        // settings modal may be gone at quit
      }
      this.fileResolveMap.forEach((item, id) => {
        try {
          item?.headingEl?.removeStickyHeader?.();
          item?.debouncedLayoutUpdate?.cancel();

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
          if (item?.dirtyFlushRetryTimer) {
            window.clearTimeout(item.dirtyFlushRetryTimer);
            item.dirtyFlushRetryTimer = undefined;
          }

          item.watchdogRecoveries = 0;
          item.watchdogRecoveryWindowStart = undefined;
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
    } catch (error) {
      if (document.body.dataset.stickyHeadingsDebug === '1') {
        console.warn('[sticky-headings] onunload outer guard caught:', error);
      }
    }
  }

  async loadSettings() {
    this.settings = this.normalizeSettings((await this.loadData()) as Partial<ISetting> | undefined);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
