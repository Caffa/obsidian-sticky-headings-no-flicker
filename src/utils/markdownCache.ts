import type { TFile } from 'obsidian';

const MAX_CACHE_SIZE = 2000;

export function getCachedTitle(cache: Map<string, string>, key: string, fallback: string): string {
  return cache.get(key) ?? fallback;
}

function evictMarkdownCacheIfNeeded(cache: Map<string, string>) {
  if (cache.size > MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (firstKey) {
      cache.delete(firstKey);
    }
  }
}

export function setCachedTitle(cache: Map<string, string>, key: string, title: string): void {
  cache.set(key, title);
  evictMarkdownCacheIfNeeded(cache);
}

export function invalidateMarkdownCacheForFile(cache: Map<string, string>, file: TFile) {
  const prefix = `${file.path}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}
