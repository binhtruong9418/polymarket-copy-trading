import { describe, it, expect, vi, beforeEach } from "vitest";
import { DedupCache } from "../../src/execution/dedup-cache.js";

describe("DedupCache", () => {
  let cache: DedupCache;

  beforeEach(() => {
    cache = new DedupCache(5_000, 5); // 5s TTL, max 5 entries
  });

  it("returns false for first-seen key (not duplicate)", () => {
    expect(cache.isDuplicate("tx1")).toBe(false);
  });

  it("returns true for same key seen again within TTL", () => {
    cache.isDuplicate("tx1");
    expect(cache.isDuplicate("tx1")).toBe(true);
  });

  it("returns false for different keys", () => {
    cache.isDuplicate("tx1");
    expect(cache.isDuplicate("tx2")).toBe(false);
  });

  it("evicts oldest entry when at max capacity", () => {
    for (let i = 1; i <= 5; i++) cache.isDuplicate(`tx${i}`);
    // Adding 6th should evict tx1
    cache.isDuplicate("tx6");
    // tx1 evicted — should be treated as new
    expect(cache.isDuplicate("tx1")).toBe(false);
  });

  it("returns false for expired key (after TTL)", () => {
    const shortCache = new DedupCache(100, 100); // 100ms TTL
    shortCache.isDuplicate("tx1");
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(shortCache.isDuplicate("tx1")).toBe(false);
        resolve();
      }, 200);
    });
  });

  it("tracks size correctly", () => {
    cache.isDuplicate("a");
    cache.isDuplicate("b");
    expect(cache.size()).toBe(2);
  });
});
