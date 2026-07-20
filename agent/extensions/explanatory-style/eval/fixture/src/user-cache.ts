export interface UserSnapshot {
  id: string;
  name: string;
}

interface CacheEntry {
  value: UserSnapshot;
  expiresAt: number;
}

export class UserCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(id: string): UserSnapshot | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.value;
  }

  set(user: UserSnapshot): void {
    this.entries.set(user.id, {
      value: { ...user },
      expiresAt: this.now() + this.ttlMs,
    });
  }

  delete(id: string): void {
    this.entries.delete(id);
  }
}
