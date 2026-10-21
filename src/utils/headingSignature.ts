import type { App, TFile } from 'obsidian';

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
