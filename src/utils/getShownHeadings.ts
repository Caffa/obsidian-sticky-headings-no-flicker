import type { HeadingCache, MarkdownView } from 'obsidian';
import type { Heading, ISetting } from 'src/types';
import { getBoundaryOffset, isEditMode } from './obsidian';

const isHeadingRegex = /^<h[1-6]/i;

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
    return headings.map<Heading>((heading, index) => ({
      ...heading,
      offset: -boundaryOffset,
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

export function getHeadingsWithOffsetSource(
  headings: HeadingCache[],
  view: MarkdownView,
  settings: ISetting
): Heading[] {
  try {
    const result = headings.map<Heading>((heading, i) => {
      const { position } = heading;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const containerEl = view?.editMode?.containerEl?.querySelector<HTMLElement>('.cm-contentContainer');
      const offset = containerEl?.offsetTop || 0;
      const boundaryOffset = getBoundaryOffset(view, settings);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const lineBlock = view?.editor?.cm?.lineBlockAt?.(position.start.offset);
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
    console.warn('Failed to compute source heading offsets, falling back to zero offsets:', error);
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
