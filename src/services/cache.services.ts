type CacheValue = unknown;

class CacheEntry {
  constructor(
    public value: CacheValue,
    public lastAccessed: number,
    public expiresAt: number | null = null,
  ) {}
}

export class CacheService {
  private store = new Map<string, CacheEntry>();
  constructor(private readonly capacity: number) {
    if (capacity < 1) {
      throw new Error("Capacity must be at least 1");
    }
  }

  private keys: string[] = [];
  private keyIndex = new Map<string, number>();

  private addKey(key: string): void {
    this.keyIndex.set(key, this.keys.length);
    this.keys.push(key);
  }

  private delete(key: string): boolean {
    if (!this.store.has(key)) return false;

    this.store.delete(key);

    const index = this.keyIndex.get(key)!;
    const lastKey = this.keys[this.keys.length - 1]!;

    this.keys[index] = lastKey;
    this.keyIndex.set(lastKey, index);

    this.keys.pop();
    this.keyIndex.delete(key);

    return true;
  }

  private evictSampledLRU(sampleSize = 5): void {
    const count = Math.min(sampleSize, this.keys.length);
    const sampledIndices = new Set<number>();

    while (sampledIndices.size < count) {
      sampledIndices.add(Math.floor(Math.random() * this.keys.length));
    }

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const index of sampledIndices) {
      const key = this.keys[index]!;
      const entry = this.store.get(key)!;

      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.store.delete(oldestKey);
    }
  }

  get(key: string): CacheValue | null {
    const entry = this.store.get(key);

    if (!entry) return null;

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    entry.lastAccessed = Date.now();
    return entry.value;
  }

  set(key: string, value: CacheValue, ttlMs?: number): void {
    if (ttlMs !== undefined && ttlMs <= 0) {
      this.store.delete(key);
      return;
    }

    const expiresAt = ttlMs === undefined ? null : Date.now() + ttlMs;

    const existing = this.store.get(key);

    if (existing) {
      existing.value = value;
      existing.lastAccessed = Date.now();
      existing.expiresAt = expiresAt;
      return;
    }

    this.store.set(key, new CacheEntry(value, Date.now(), expiresAt));
    if (this.store.size > this.capacity) {
      this.evictSampledLRU();
    }
  }
}
