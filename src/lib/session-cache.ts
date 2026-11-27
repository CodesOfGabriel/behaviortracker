type Key = readonly string[];
type Entry = { value?: unknown; ready: boolean; pending?: Promise<unknown> };

// Session only: never put video frames or researcher annotations in localStorage.
// Identity checks also prevent an invalidated request from repopulating the cache.
export class SessionCache {
  private entries = new Map<string, Entry>();
  constructor(private readonly capacity = 128) {}

  peek<T>(key: Key): T | undefined {
    const entry = this.entries.get(JSON.stringify(key));
    return entry?.ready ? entry.value as T : undefined;
  }

  read<T>(key: Key, load: () => Promise<T>, refresh = false): Promise<T> {
    const id = JSON.stringify(key);
    const previous = this.entries.get(id);
    if (previous?.pending) return previous.pending as Promise<T>;
    if (previous?.ready && !refresh) {
      this.entries.delete(id);
      this.entries.set(id, previous);
      return Promise.resolve(previous.value as T);
    }
    const entry: Entry = { ready: false };
    this.entries.set(id, entry);
    entry.pending = Promise.resolve().then(load).then(value => {
      if (this.entries.get(id) === entry) {
        entry.value = value;
        entry.ready = true;
        entry.pending = undefined;
        this.trim();
      }
      return value;
    }, error => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
      throw error;
    });
    return entry.pending as Promise<T>;
  }

  update<T>(key: Key, change: (old: T) => T) {
    const old = this.peek<T>(key);
    this.invalidate(key);
    if (old !== undefined) this.entries.set(JSON.stringify(key), { ready: true, value: change(old) });
  }

  invalidate(prefix: Key = []) {
    for (const id of this.entries.keys()) {
      const key: string[] = JSON.parse(id);
      if (prefix.every((part, index) => key[index] === part)) this.entries.delete(id);
    }
  }

  private trim() {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      if (!entry.pending) this.entries.delete(id);
    }
  }
}

export const sessionCache = new SessionCache();
// Full tracking results are large. Keep only the three most recently used runs.
export const trackingResultCache = new SessionCache(3);
let analysisCacheGeneration = 0;
export const currentAnalysisCacheGeneration = () => analysisCacheGeneration;
export function clearAnalysisCache() {
  analysisCacheGeneration++;
  sessionCache.invalidate();
  trackingResultCache.invalidate();
}

export function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
