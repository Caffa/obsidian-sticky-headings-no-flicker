import type { App, HeadingCache, TFile } from 'obsidian';

/**
 * Build a stable signature for the current heading structure of a file.
 * Used as an equality gate so unchanged metadata does not trigger a full
 * heading rebuild / markdown re-parse on every 'resolve' event.
 *
 * Offsets are deliberately excluded: ANY edit before a heading shifts every
 * downstream heading's start offset, so including offsets made the gate miss
 * on nearly every keystroke (defeating the "skip rebuild when heading
 * structure unchanged" purpose). The gate detects heading-structure changes
 * only (heading added/removed/renamed/level changed). Display offsets are
 * recomputed live from the metadata cache in the shown-headings path each
 * scroll tick, so stale stored offsets cannot affect rendering.
 *
 * A missing cache (null/undefined) and a zero-heading cache both yield the
 * empty string — handled consistently.
 */
export function computeHeadingSignature(file: TFile, app: App): string {
  const headings = app.metadataCache.getFileCache(file)?.headings;
  if (!headings || headings.length === 0) {
    return '';
  }
  return headings.map(h => `${h.level}|${h.heading}`).join('\n');
}

/**
 * Position-layer counterpart of {@link computeHeadingSignature}. The title
 * gate is deliberately offset-invariant (since 2.4.1) so normal edits don't
 * miss on every keystroke, but that creates a blind spot: pasting text can
 * shift every downstream heading start offset with zero heading-structure
 * change, no scroll event fires, and the resolve skip gate stays closed. This
 * signature exposes exactly the excluded dimension (`line:offset` per
 * heading) so those reflows remain detectable.
 */
export function computeOffsetSignature(headings: HeadingCache[] | null | undefined): string {
  if (!headings || headings.length === 0) {
    return '';
  }
  return (
    headings
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      .map(h => `${h.position?.start?.line ?? -1}:${h.position?.start?.offset ?? -1}`)
      .join('\n')
  );
}
