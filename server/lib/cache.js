/**
 * Small in-memory TTL cache with LRU-ish eviction.
 *
 * Scryfall asks that clients cache aggressively rather than re-requesting the
 * same data, so every outbound call in this app goes through one of these.
 */
export class TtlCache {
  constructor({ ttlMs = 60 * 60 * 1000, maxEntries = 5000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency so the hottest keys survive eviction.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  /** Run `producer` on a miss, caching (and de-duplicating) the in-flight promise. */
  async wrap(key, producer, ttlMs = this.ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = producer().then(
      (value) => {
        this.set(key, value, ttlMs);
        return value;
      },
      (err) => {
        // Never cache a failure.
        this.map.delete(key);
        throw err;
      },
    );

    // Store the promise itself so concurrent callers share one request.
    this.set(key, pending, ttlMs);
    return pending;
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}
