<svelte:options accessors={true} />

<script lang="ts">
  import { getIcon, MarkdownView, Platform } from 'obsidian';
  import type { Heading, ISetting } from '../types';
  import { onDestroy, onMount, tick } from 'svelte';
  import { getScroller } from 'src/utils/obsidian';
  import { delay } from '../utils/delay';
  import { animateScroll, computeScrollTop } from 'src/utils/scroll';
  import { computeEffectiveTop } from '../utils/viewportAnchor';
  import { logAnchor } from '../utils/anchorDebug';
  import type { AnchorTrigger } from '../utils/anchorDebug';
  import type { TFile } from 'obsidian';
  export let headings: Heading[];
  export let editMode: boolean;
  export let view: MarkdownView;
  export let settings: ISetting;
  export let getExpectedHeadings: (clickHeadingIndex: number) => Heading[];
  export let showFileName: boolean;
  export let expectedHeadings: Heading[] = [];
  export let file: TFile | undefined;
  let main: HTMLElement;
  let shadow: HTMLElement;
  let forceRenderingHeadings: Heading[] | null = null;
  let activeScrollCancel: (() => void) | null = null;
  let effectiveTop = 0;

  $: fontSizeStyle = settings.fontSize ? `${settings.fontSize}px` : '12px';
  $: lineHeightStyle = settings.fontSize ? `${Math.round(settings.fontSize * 1.5)}px` : '18px';
  $: userNudge = Platform.isMobile ? settings.mobileTopOffset : settings.desktopTopOffset;
  $: leftOffset = Platform.isMobile ? settings.mobileLeftOffset : settings.desktopLeftOffset;
  $: rootStyles =
    `--sticky-header-font-size:${fontSizeStyle};` +
    `--sticky-header-line-height:${lineHeightStyle};` +
    `top:${effectiveTop}px;` +
    `left:${leftOffset}px;`;

  let filename = file?.basename ?? '';
  $: filename = file?.basename ?? '';
  export const showIcons: boolean = true;

  const iconCache: Record<string, string> = {};
  const getIconHtml = (name: string) => (iconCache[name] ??= getIcon(name)?.outerHTML ?? '');

  let resizeObserver: ResizeObserver | null = null;
  let pendingAnimationFrame: number | null = null;
  let settleTimers: number[] = [];
  let observedContainer: HTMLElement | null = null;
  // Inline `position` the container had before we forced `relative`,
  // captured at overwrite time and restored on teardown.
  let previousContainerPosition = '';
  // The window the layout listeners were attached to, so removal targets the
  // same window even when `main` is already detached (closed popout).
  let attachedWindow: Window | null = null;

  const recomputeTop = (trigger: AnchorTrigger = 'mount') => {
    if (!main) {
      return;
    }
    const prevTop = effectiveTop;
    const nextTop = computeEffectiveTop(main, view, settings);
    logAnchor(trigger, main, view, prevTop, nextTop);
    // A `null` result means degenerate rects (hidden/detached leaf) — keep the
    // last good top instead of clobbering it with a fallback value.
    if (nextTop != null && nextTop !== effectiveTop) {
      effectiveTop = nextTop;
    }
  };

  let pendingTrigger: AnchorTrigger = 'mount';
  const throttledRecompute = (trigger: AnchorTrigger) => {
    pendingTrigger = trigger;
    if (pendingAnimationFrame !== null) {
      return;
    }
    pendingAnimationFrame = requestAnimationFrame(() => {
      pendingAnimationFrame = null;
      recomputeTop(pendingTrigger);
    });
  };

  // Stable wrapper references so add/removeEventListener stay paired.
  const onResizeObserved = () => throttledRecompute('ro');
  const onWindowResize = () => throttledRecompute('win-resize');
  const onVisualViewportResize = () => throttledRecompute('vv-resize');

  const scheduleSettle = () => {
    settleTimers.forEach(window.clearTimeout);
    settleTimers = [];
    settleTimers = [
      window.setTimeout(() => recomputeTop('settle-300'), 300),
      window.setTimeout(() => recomputeTop('settle-1000'), 1000),
    ];
  };

  const attachLayoutListeners = () => {
    if (!main) {
      return;
    }
    const contentEl = view.contentEl;
    const container = main.parentElement;
    if (!contentEl || !container) {
      return;
    }

    // Guard against duplicate listener registration on the same container.
    if (resizeObserver) {
      return;
    }

    const win = main.ownerDocument.defaultView ?? window;
    resizeObserver = new ResizeObserver(onResizeObserved);
    resizeObserver.observe(contentEl);
    resizeObserver.observe(container);

    win.addEventListener('resize', onWindowResize);
    win.visualViewport?.addEventListener('resize', onVisualViewportResize);
    attachedWindow = win;
  };

  const detachLayoutListeners = () => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    // Remove from the window the listeners were attached to: re-deriving from
    // `main` fails when `main` is already detached (closed popout), which
    // would leak the listeners on that window.
    const win = attachedWindow;
    win?.removeEventListener('resize', onWindowResize);
    win?.visualViewport?.removeEventListener('resize', onVisualViewportResize);
    attachedWindow = null;
    settleTimers.forEach(window.clearTimeout);
    settleTimers = [];
    // NOTE: deliberately do NOT reset `observedContainer` here — the
    // parent-change reactive block assigns it after re-attaching, and nulling
    // it here would clobber that assignment whenever `main` re-binds.
    if (pendingAnimationFrame !== null) {
      cancelAnimationFrame(pendingAnimationFrame);
      pendingAnimationFrame = null;
    }
  };

  $: if (main) {
    recomputeTop('main-bind');
  }

  $: if (settings && main) {
    recomputeTop('settings');
  }

  $: if (userNudge >= 0 && main) {
    recomputeTop('nudge');
  }

  $: if (main?.parentElement && main.parentElement !== observedContainer) {
    const container = main.parentElement;
    detachLayoutListeners();
    attachLayoutListeners();
    // Identity by construction: the measured ancestor is always the CSS
    // containing block, regardless of theme overrides or class refcount races.
    previousContainerPosition = container.style.position || '';
    container.style.position = 'relative';
    observedContainer = container;
    recomputeTop('parent-change');
    scheduleSettle();
  }

  export const refreshAnchor = () => {
    throttledRecompute('refreshAnchor');
  };

  onMount(() => {
    console.debug('mounted svelte component');
    recomputeTop('mount');
  });

  onDestroy(() => {
    detachLayoutListeners();
    // Restore the inline `position` we overwrote on the container. Harmless
    // if the element is already gone from the DOM; the component is destroyed
    // per parent, so last-wins on this variable is correct.
    if (observedContainer && observedContainer.style.position !== previousContainerPosition) {
      observedContainer.style.position = previousContainerPosition;
    }
  });

  const calculateExpectedHeight = async (index: number) => {
    expectedHeadings = getExpectedHeadings(index);
    // fixme: Is there a better way to run subsequent code after Shadow has rendered?
    await tick();
    // fixme: The expected height should not be the height of Shadow but the offset of the lower boundary of Shadow.
    return shadow?.clientHeight || 0;
  };

  const scrollTo = async (top: number) => {
    activeScrollCancel?.();
    activeScrollCancel = null;
    let scrollerSource = getScroller(view);
    if (!scrollerSource) {
      await delay(50);
      scrollerSource = getScroller(view);
    }
    if (!scrollerSource) {
      console.warn('No scroll container found for sticky header navigation');
      return;
    }
    const localForce = [...expectedHeadings];
    // When jumping, the currently clicked title should not appear in props.headings. This is different from the manual scrolling scenario and needs to be corrected.
    if (settings.scrollBehaviour === 'instant') {
      forceRenderingHeadings = localForce;
      scrollerSource.scrollTo({ top, behavior: 'instant' });
      // waiting for the throlled scroll to complete, the waiting time should be longer than the throlle wait time.
      await delay(80);
      headings = localForce;
      forceRenderingHeadings = null;
    } else {
      // fixme: add easing function;
      activeScrollCancel = animateScroll(scrollerSource, top, 1000, undefined, undefined, () => {
        headings = localForce;
        forceRenderingHeadings = null;
        activeScrollCancel = null;
      });
      // A tricky way to suppress the scroll event.
      forceRenderingHeadings = localForce;
    }
  };

  const handleScrollClick = async (heading: Heading) => {
    const expectedHeight = await calculateExpectedHeight(heading.index);
    const top = computeScrollTop(heading.offset, expectedHeight);
    scrollTo(top);
  };
</script>

{#if settings.mode !== 'disable'}
  {#if (forceRenderingHeadings || headings).length > 0}
    <div class={`sticky-headings-root sticky-headings-theme-${settings.theme}`} bind:this={main} style={rootStyles}>
      <div class="sticky-headings-container">
        {#if showFileName && filename}
          <div
            class="sticky-headings-item"
            on:click={() => scrollTo(0)}
            role="button"
            tabindex="0"
            on:keydown={e => {
              if (e.key === 'Enter') scrollTo(0);
            }}
          >
            {#if settings.showIcon}
              <div class="sticky-headings-icon">
                {@html getIconHtml('heading')}
              </div>
            {/if}
            {filename}
          </div>
        {/if}
        {#each forceRenderingHeadings || headings as heading (heading.index)}
          <div
            class="sticky-headings-item"
            data-indent-level={heading.indentLevel + (showFileName ? 1 : 0)}
            on:click={() => handleScrollClick(heading)}
            role="button"
            tabindex="0"
            on:keydown={e => {
              if (e.key === 'Enter') handleScrollClick(heading);
            }}
          >
            {#if settings.showIcon}
              {#if editMode}
                {#each { length: heading.level } as _, i}
                  #
                {/each}
              {:else}
                <div class="sticky-headings-icon">
                  {@html getIconHtml(`heading-${heading.level}`)}
                </div>
              {/if}
            {/if}
            {@html heading.title}
          </div>
        {/each}
      </div>
    </div>
  {/if}
  <div
    class={`sticky-headings-root sticky-headings-shadow sticky-headings-theme-${settings.theme}`}
    bind:this={shadow}
    style={rootStyles}
  >
    <div class="sticky-headings-container">
      {#if showFileName && filename}
        <div class="sticky-headings-item">
          {filename}
        </div>
      {/if}
      {#each expectedHeadings as heading (heading.index)}
        <div class="sticky-headings-item sticky-headings-shadow-item" data-indent-level={0}>
          {@html heading.title}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .sticky-headings-shadow {
    opacity: 0 !important;
    pointer-events: none !important;
  }

  .sticky-headings-container {
    max-width: min(var(--file-line-width), var(--max-width));
    margin: 0 auto;
    font-size: var(--sticky-header-font-size, 12px);
  }

  .sticky-headings-root {
    height: fit-content;
    overflow: hidden;
    position: absolute;
    /* top and left are set via the inline style attribute so they react
       immediately when plugin settings change (Style Settings variables
       require a reload). */
    /* Only as wide as the heading text so the inline title can show through
       on the rest of the line. */
    width: fit-content;
    max-width: min(var(--file-line-width), var(--max-width));
    padding: 0 var(--file-margins);
    /* Above editor content but narrow enough that the inline title shows
       on either side / behind overlapping character descenders. */
    z-index: 1;
    padding-top: var(--sticky-header-verticle-offset);
  }

  .sticky-headings-item {
    line-height: var(--sticky-header-line-height, 18px);
    display: flex;
    align-items: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: var(--cursor-link);
    width: fit-content;
    /* Each item carries its own background so the header is only opaque
       behind the actual text, not the full editor width. */
    background-color: var(--background-primary);
  }

  .sticky-headings-item :global(p) {
    margin: 0 !important;
  }

  .sticky-headings-icon {
    display: flex;
    align-items: center;
  }

  .sticky-headings-icon :global(svg) {
    width: 16px;
    height: 16px;
    margin-right: 8px;
    color: var(--link-color);
  }

  .sticky-headings-item[data-indent-level='1'] {
    padding-left: var(--sticky-header-indent-width);
  }

  .sticky-headings-item[data-indent-level='2'] {
    padding-left: calc(var(--sticky-header-indent-width) * 2);
  }

  .sticky-headings-item[data-indent-level='3'] {
    padding-left: calc(var(--sticky-header-indent-width) * 3);
  }

  .sticky-headings-item[data-indent-level='4'] {
    padding-left: calc(var(--sticky-header-indent-width) * 4);
  }

  .sticky-headings-item[data-indent-level='5'] {
    padding-left: calc(var(--sticky-header-indent-width) * 5);
  }

  .sticky-headings-item[data-indent-level='6'] {
    padding-left: calc(var(--sticky-header-indent-width) * 6);
  }

  .sticky-headings-theme-blur .sticky-headings-container {
    padding: 12px;
    backdrop-filter: blur(8px);
    border-bottom-left-radius: 8px;
    border-bottom-right-radius: 8px;
    position: relative;
    z-index: 2;
    background: linear-gradient(to bottom, var(--background-primary) 0%, transparent 50%);
  }

  .sticky-headings-theme-float.sticky-headings-root {
    padding: 10px 20%;
    padding-top: calc(var(--sticky-header-verticle-offset) + 10px);
    padding-bottom: 0;
  }

  @media (max-width: 600px) {
    .sticky-headings-theme-float.sticky-headings-root {
      padding: 10px 4%;
    }
  }

  .sticky-headings-theme-float .sticky-headings-container {
    border-radius: 32px;
    background-color: var(--sticky-header-float-background-color);
    color: var(--sticky-header-float-text-color);
    padding: 10px 32px;
  }
</style>
