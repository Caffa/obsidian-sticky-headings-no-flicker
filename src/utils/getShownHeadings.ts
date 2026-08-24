import type { HeadingCache, MarkdownView } from 'obsidian';
import type { Heading, ISetting } from 'src/types';
import { getBoundaryOffset, getScroller, isEditMode } from './obsidian';

const isHeadingRegex = /^<h[1-6]/i;

function getPreviewOffsetsDOM(view: MarkdownView, headings: HeadingCache[], boundaryOffset: number): Heading[] | null {
  const containerEl = view.previewMode.containerEl as HTMLElement | undefined;
  if (!containerEl) return null;
  const domHeadings = Array.from(containerEl.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'));
  if (domHeadings.length !== headings.length) return null;
  const scroller = getScroller(view);
  if (!scroller) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  return headings.map<Heading>((heading, i) => {
    const el = domHeadings[i];
    const rect = el.getBoundingClientRect();
    const top = rect.top - scrollerRect.top + scroller.scrollTop;
    return {
      ...heading,
      offset: top - boundaryOffset,
      indentLevel: heading.level - 1,
      title: heading.heading,
      index: i,
    };
  });
}

export function getHeadingsWithOffsetPreview(
  headings: HeadingCache[],
  view: MarkdownView,
  settings: ISetting
): Heading[] {
  const headingsOffset: number[] = [];
  const boundaryOffset = getBoundaryOffset(view, settings);
  let heightSum = 0;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const sections = view?.previewMode?.renderer?.sections;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!sections) {
    const domOffsets = getPreviewOffsetsDOM(view, headings, boundaryOffset);
    if (domOffsets) return domOffsets;
    console.warn('Preview renderer sections missing; falling back to fabricated offsets', {
      path: view.file?.path,
      headingCount: headings.length,
    });
    return headings.map<Heading>((heading, index) => ({
      ...heading,
      offset: index * 32 - boundaryOffset,
      indentLevel: heading.level - 1,
      title: heading.heading,
      index,
    }));
  }
  // @ts-expect-error height not defined in obsidian typing
  sections.forEach(({ html, height = 0 }) => {
    if (isHeadingRegex.test(html)) {
      headingsOffset.push(heightSum);
    }
    heightSum += height;
  });
  return headings.map<Heading>((heading, index) => ({
    ...heading,
    offset: (headingsOffset[index] || 0) - boundaryOffset,
    indentLevel: heading.level - 1,
    title: heading.heading,
    index,
  }));
}

function getSourceOffsetsDOM(view: MarkdownView, headings: HeadingCache[], boundaryOffset: number): Heading[] | null {
  const { containerEl } = view.editMode;
  if (!containerEl) return null;
  const lines = Array.from(containerEl.querySelectorAll<HTMLElement>('.cm-line'));
  if (lines.length === 0) return null;
  const scroller = getScroller(view);
  if (!scroller) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const cm = view?.editor?.cm;
  // Match the primary source path's reference frame: .cm-contentContainer's offsetTop
  const contentOffset =
    containerEl.querySelector<HTMLElement>('.cm-contentContainer')?.offsetTop || containerEl.offsetTop || 0;
  return headings.map<Heading>((heading, i) => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const lineBlock = cm?.lineBlockAt?.(heading.position?.start?.offset ?? 0);
    let top: number;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (lineBlock != null && typeof lineBlock.top === 'number') {
      top = lineBlock.top + contentOffset;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const lineIndex = Math.min(heading.position?.start?.line ?? 0, lines.length - 1);
      const el = lines[lineIndex];
      const rect = el.getBoundingClientRect();
      top = rect.top - scrollerRect.top + scroller.scrollTop;
    }
    return {
      ...heading,
      offset: top - boundaryOffset,
      indentLevel: heading.level - 1,
      title: heading.heading,
      index: i,
    };
  });
}

export function getHeadingsWithOffsetSource(
  headings: HeadingCache[],
  view: MarkdownView,
  settings: ISetting
): Heading[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const containerEl = view?.editMode?.containerEl?.querySelector<HTMLElement>('.cm-contentContainer');
    const offset = containerEl?.offsetTop || 0;
    const boundaryOffset = getBoundaryOffset(view, settings);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const cm = view?.editor?.cm;
    const result = headings.map<Heading>((heading, i) => {
      const { position } = heading;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const lineBlock = cm?.lineBlockAt?.(position.start.offset);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const { top = 0 } = lineBlock ?? { top: 0 };
      return {
        ...heading,
        offset: top + offset - boundaryOffset,
        indentLevel: heading.level - 1,
        title: heading.heading,
        index: i,
      };
    });
    return result;
  } catch (error) {
    console.warn('Internal source offset API failed, trying DOM fallback:', error);
    const boundaryOffset = getBoundaryOffset(view, settings);
    const domOffsets = getSourceOffsetsDOM(view, headings, boundaryOffset);
    if (domOffsets) return domOffsets;
    console.warn('DOM fallback for source heading offsets failed; falling back to zero offsets', {
      path: view.file?.path,
      headingCount: headings.length,
    });
    return headings.map<Heading>((heading, i) => ({
      ...heading,
      offset: 0,
      indentLevel: heading.level - 1,
      title: heading.heading,
      index: i,
    }));
  }
}

export function trivial(subHeadings: Heading[], result: Heading[], mode: 'default' | 'concise' | 'disable') {
  if (!subHeadings.length || mode === 'disable') {
    return result;
  }
  const topLevel = subHeadings.reduce((res, cur) => Math.min(res, cur.level), 6);
  const indexesOfTopLevel = subHeadings.reduce<number[]>((indexes, cur, index) => {
    if (cur.level === topLevel) {
      indexes.push(index);
    }
    return indexes;
  }, []);
  if (mode === 'concise') {
    if (indexesOfTopLevel.length >= 1) {
      result.push(subHeadings[indexesOfTopLevel[indexesOfTopLevel.length - 1]]);
    }
  } else {
    for (const index of indexesOfTopLevel) {
      result.push(subHeadings[index]);
    }
  }
  trivial(subHeadings.slice(indexesOfTopLevel[indexesOfTopLevel.length - 1] + 1), result, mode);
}
export function getHeadingsWithOffset(headings: HeadingCache[], view: MarkdownView, settings: ISetting): Heading[] {
  try {
    const getValidHeadings = isEditMode(view) ? getHeadingsWithOffsetSource : getHeadingsWithOffsetPreview;
    return getValidHeadings(headings, view, settings);
  } catch (error) {
    console.warn('Failed to get shown headings, returning empty list:', error);
    return [];
  }
}

export default getHeadingsWithOffset;
