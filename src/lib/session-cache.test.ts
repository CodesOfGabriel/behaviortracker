import { describe, expect, it, vi } from "vitest";
import { SessionCache, withTimeout } from "./session-cache";

describe("session reads", () => {
  it("shares concurrent requests and reuses successful data across remounts", async () => {
    const cache = new SessionCache();
    const load = vi.fn(async () => [1, 2, 3]);
    const first = cache.read(["experiment", "tracking", "sha"], load);
    expect(cache.read(["experiment", "tracking", "sha"], load)).toBe(first);
    const value = await first;
    expect(await cache.read(["experiment", "tracking", "sha"], load)).toBe(value);
    expect(cache.peek(["experiment", "tracking", "sha"])).toBe(value);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("isolates experiment, tracking and source digest and retries failed reads", async () => {
    const cache = new SessionCache();
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("disk")).mockResolvedValue("ready");
    await expect(cache.read(["e1", "j1", "sha1"], load)).rejects.toThrow("disk");
    expect(cache.peek(["e1", "j1", "sha1"])).toBeUndefined();
    await cache.read(["e1", "j1", "sha1"], load);
    await cache.read(["e2", "j1", "sha1"], load);
    await cache.read(["e1", "j2", "sha1"], load);
    await cache.read(["e1", "j1", "sha2"], load);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it("cannot repopulate a deleted or disconnected session with an old request", async () => {
    const cache = new SessionCache();
    let finish!: (value: string) => void;
    const pending = cache.read(["e1", "job"], () => new Promise<string>(resolve => { finish = resolve; }));
    await Promise.resolve();
    cache.invalidate(["e1"]);
    await cache.read(["e1", "job"], async () => "new session");
    finish("old session"); await pending;
    expect(cache.peek(["e1", "job"])).toBe("new session");
  });

  it("updates saved history without losing authors and invalidates a racing read", async () => {
    const cache = new SessionCache();
    await cache.read(["annotations", "job"], async () => [{ author: "original" }]);
    cache.update<{author:string}[]>(["annotations", "job"], old => [...old, {author:"current"}]);
    expect(cache.peek(["annotations", "job"])).toEqual([{author:"original"},{author:"current"}]);
    let finish!: (value: string[]) => void;
    const pending = cache.read(["reviews", "job"], () => new Promise<string[]>(resolve => {finish = resolve;}));
    await Promise.resolve();
    cache.update<string[]>(["reviews", "job"], old => [...old, "saved"]);
    finish(["old"]); await pending;
    expect(cache.peek(["reviews", "job"])).toBeUndefined();
  });

  it("refreshes mutable job lists and bounds retained tracking results", async () => {
    const cache = new SessionCache(2);
    await cache.read(["job1"], async () => "running");
    await cache.read(["job1"], async () => "succeeded", true);
    expect(cache.peek(["job1"])).toBe("succeeded");
    await cache.read(["job2"], async () => []);
    await cache.read(["job1"], async () => "unused");
    await cache.read(["job3"], async () => []);
    expect(cache.peek(["job2"])).toBeUndefined();
    expect(cache.peek(["job1"])).toBe("succeeded");
  });

  it("does not leave startup blocked by an optional model probe", async () => {
    vi.useFakeTimers();
    try {
      const result = expect(withTimeout(new Promise(() => {}), 5000, "Model timed out")).rejects.toThrow("Model timed out");
      await vi.advanceTimersByTimeAsync(5000);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
