type BoundedTtlCacheDependencies = {
  maxEntries: number;
  now?: () => number;
  ttlMs: number;
};
type BoundedTtlCacheEntry<Value> = {
  expiresAt: number;
  value: Value;
};

export class BoundedTtlCache<Value> {
  private readonly entries = new Map<string, BoundedTtlCacheEntry<Value>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly ttlMs: number;

  public constructor(dependencies: BoundedTtlCacheDependencies) {
    this.maxEntries = Math.max(0, dependencies.maxEntries);
    this.now = dependencies.now ?? Date.now;
    this.ttlMs = Math.max(0, dependencies.ttlMs);
  }

  public get(key: string): Value | undefined {
    const entry = this.entries.get(key);
    if (undefined === entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: Value) {
    if (0 === this.maxEntries || 0 === this.ttlMs) {
      return;
    }

    this.deleteExpiredEntries();
    if (true === this.entries.has(key)) {
      this.entries.delete(key);
    }

    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (undefined === oldestKey) {
        break;
      }

      this.entries.delete(oldestKey);
    }

    this.entries.set(key, {
      expiresAt: this.now() + this.ttlMs,
      value,
    });
  }

  public get size(): number {
    this.deleteExpiredEntries();
    return this.entries.size;
  }

  private deleteExpiredEntries() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
