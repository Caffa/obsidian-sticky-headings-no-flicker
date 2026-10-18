import type { App, TFile } from 'obsidian';

/**
 * Build a stable signature for the current heading structure of a file.
 * Used as an equality gate so unchanged metadata does not trigger a full
 * heading rebuild / markdown re-parse on every 'resolve' event.
 *
 * A missing cache (null/undefined) and a zero-heading cache both yield the
 * empty string — handled consistently.
 */
export function computeHeadingSignature(file: TFile, app: App): string {
  const headings = app.metadataCache.getFileCache(file)?.headings;
  if (!headings || headings.length === 0) {
    return '';
  }
  return headings.map(h => `${h.level}|${h.heading}|${h.position.start.offset}`).join('\n');
}
