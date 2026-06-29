/**
 * Persistent store abstraction for durable domain data. Uses Redis when
 * REDIS_URL is set, otherwise falls back to an in-memory store (dev/test).
 *
 * DESIGN RULES:
 * - NEVER enumerate keyspaces (no KEYS, SCAN, or key-prefix iteration).
 * - Maintain explicit INDEX records for collections (e.g. memberIds[] on Team).
 * - All methods return Promises (async-safe for Redis; sync-ok in-memory).
 */

// ── Low-level KV interface ──────────────────────────────────────────────

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  /** Set with TTL in seconds (0 = no expiry). */
  setex(key: string, seconds: number, value: string): Promise<void>;
}

export interface JsonStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  setex<T>(key: string, seconds: number, value: T): Promise<void>;
}

// ── In-memory implementation ─────────────────────────────────────────────

class InMemoryKv implements KvStore {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt > 0 && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, { value, expiresAt: 0 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async setex(key: string, seconds: number, value: string): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: seconds > 0 ? Date.now() + seconds * 1000 : 0,
    });
  }
}

// ── Redis implementation ─────────────────────────────────────────────────

interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

class RedisKv implements KvStore {
  constructor(private url: string) {}

  private _client: RedisClient | null = null;

  private async client(): Promise<RedisClient> {
    if (this._client) return this._client;
    const { createRequire } = await import("node:module");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ioredis: any = createRequire(import.meta.url)("ioredis");
    const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
    this._client = new Redis(this.url, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    }) as RedisClient;
    return this._client;
  }

  async get(key: string): Promise<string | null> {
    return (await this.client()).get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await (await this.client()).set(key, value);
  }

  async del(key: string): Promise<void> {
    await (await this.client()).del(key);
  }

  async setex(key: string, seconds: number, value: string): Promise<void> {
    const c = await this.client();
    // ioredis exposes setex — cast via unknown
    await (c as unknown as Record<string, (...args: unknown[]) => unknown>).setex(key, seconds, value);
  }
}

// ── High-level JSON store ────────────────────────────────────────────────

const PREFIX = "asb:";

class JsonStoreImpl implements JsonStore {
  constructor(private kv: KvStore) {}

  private k(key: string): string {
    return PREFIX + key;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(this.k(key));
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.kv.set(this.k(key), JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    await this.kv.del(this.k(key));
  }

  async setex<T>(key: string, seconds: number, value: T): Promise<void> {
    await this.kv.setex(this.k(key), seconds, JSON.stringify(value));
  }
}

// ── Singleton resolution ─────────────────────────────────────────────────

let _store: JsonStore | null = null;

/** Get the persistent JSON store. Call once at startup. */
export function getStore(): JsonStore {
  if (_store) return _store;
  const redisUrl = process.env.REDIS_URL;
  const kv: KvStore = redisUrl ? new RedisKv(redisUrl) : new InMemoryKv();
  _store = new JsonStoreImpl(kv);
  return _store;
}

/**
 * Override the store for testing. Pass `null` to clear the override and
 * re-resolve from env on the next `getStore()` call.
 */
export function setStore(s: JsonStore | null): void {
  _store = s;
}

/** Reset the store (test hook — wipes all keys from the underlying KvStore
 *  if it's InMemoryKv). */
export async function resetStore(): Promise<void> {
  _store = null;
}
