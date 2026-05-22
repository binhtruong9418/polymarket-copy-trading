// LRU dedup cache with TTL. Keyed by trade signal ID to prevent
// duplicate order submissions from WS re-delivery or polling overlap.
export class DedupCache {
  private cache = new Map<string, number>(); // key → expiry ms
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs = 5 * 60 * 1000, maxSize = 500) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  // Returns true if the key was already seen (duplicate).
  isDuplicate(key: string): boolean {
    this.evictExpired();
    const expiry = this.cache.get(key);
    if (expiry !== undefined && expiry > Date.now()) return true;
    // Evict oldest entry if at capacity before inserting
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, Date.now() + this.ttlMs);
    return false;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, expiry] of this.cache) {
      if (expiry <= now) this.cache.delete(key);
      else break; // Map preserves insertion order; stop at first live entry
    }
  }

  size(): number {
    return this.cache.size;
  }
}
