<svelte:options accessors={true} />

<script lang="ts">
  import { getIcon, MarkdownView, Platform } from 'obsidian';
  import type { Heading, ISetting } from '../types';
  import { onDestroy, onMount, tick } from 'svelte';
  import { getScroller } from 'src/utils/obsidian';
  import { delay } from '../utils/delay';
  import { animateScroll, computeScrollTop } from 'src/utils/scroll';
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

  $: fontSizeStyle = settings.fontSize ? `${settings.fontSize}px` : '12px';
  $: lineHeightStyle = settings.fontSize ? `${Math.round(settings.fontSize * 1.5)}px` : '18px';
  $: rootStyles = `--sticky-header-font-size:${fontSizeStyle};--sticky-header-line-height:${lineHeightStyle};--sticky-header-top-offset:${inlineTitleTopOffset}px;`;

  let filename = file?.basename ?? '';
  $: filename = file?.basename ?? '';
  export const showIcons: boolean = true;

  // Distance from the top of the mount container to the start of actual note
  // content, so the sticky header does not overlap Obsidian's inline title.
  let inlineTitleTopOffset = 0;
  let lastMeasuredInlineTitle: HTMLElement | null = null;
  let inlineTitleResizeObserver: ResizeObserver | null = null;

  const iconCache: Record<string, string> = {};
  const getIconHtml = (name: string) => (iconCache[name] ??= getIcon(name)?.outerHTML ?? '');

  function setInlineTitleOffset(value: number) {
    inlineTitleTopOffset = Math.max(0, Math.round(value));
  }

  function observeInlineTitle(el: HTMLElement) {
    if (lastMeasuredInlineTitle === el && inlineTitleResizeObserver) return;
    inlineTitleResizeObserver?.disconnect();
    lastMeasuredInlineTitle = el;
    inlineTitleResizeObserver = new ResizeObserver(() => measureInlineTitleOffset());
    inlineTitleResizeObserver.observe(el);
  }

  function measureInlineTitleOffset() {
    // Only apply the inline-title offset on desktop. On mobile the previous
    // hardcoded top: 0 keeps the bar in the right place.
    if (Platform.isMobile) {
      setInlineTitleOffset(0);
      return;
    }
    try {
      const scroller = getScroller(view);
      if (!scroller) return;
      // The active inline title is inside the active scroller. Avoid fallbacks
      // to hidden containers (source vs preview in live preview) because their
      // rects are stale/zero when not active.
      const inlineTitle = scroller.querySelector<HTMLElement>('.inline-title');
      if (!inlineTitle) {
        setInlineTitleOffset(0);
        inlineTitleResizeObserver?.disconnect();
        lastMeasuredInlineTitle = null;
        return;
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const titleRect = inlineTitle.getBoundingClientRect();
      // If the view is hidden (tab switch, window not focused), rects are 0
      // and the old value is more trustworthy than 0.
      if (scrollerRect.width === 0 || scrollerRect.height === 0 || titleRect.width === 0 || titleRect.height === 0) {
        return;
      }
      // Convert the title's viewport-relative bottom to a scroll-independent
      // content coordinate so the offset stays correct after scrolling.
      const offset = titleRect.bottom - scrollerRect.top + (scroller.scrollTop || 0);
      setInlineTitleOffset(offset);
      observeInlineTitle(inlineTitle);
    } catch {
      setInlineTitleOffset(0);
    }
  }

  onMount(() => {
    console.debug('mounted svelte component');
    // Defer until layout is settled; this also avoids measuring while a tab is
    // still hidden during a layout change.
    requestAnimationFrame(() => measureInlineTitleOffset());
  });

  onDestroy(() => {
    console.debug('destroyed');
    inlineTitleResizeObserver?.disconnect();
    inlineTitleResizeObserver = null;
    lastMeasuredInlineTitle = null;
  });

  // Re-measure when the view or file changes (inline title may appear/disappear).
  $: if (view || file) {
    if (typeof window !== 'undefined') {
      requestAnimationFrame(() => measureInlineTitleOffset());
    }
  }

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
    top: var(--sticky-header-top-offset, 0);
    width: 100%;
    padding: 0 var(--file-margins);
    z-index: 1;
    padding-top: var(--sticky-header-verticle-offset);
  }

  :global(.is-mobile) .sticky-headings-root,
  :global(.is-phone) .sticky-headings-root {
    top: 0;
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

  .sticky-headings-theme-flat .sticky-headings-container {
    background-color: var(--background-primary);
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
