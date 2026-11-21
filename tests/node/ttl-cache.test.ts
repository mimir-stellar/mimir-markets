import { describe, it, expect, vi } from "vitest";
import { cachedFor } from "@/lib/server/ttl-cache";

describe("cachedFor", () => {
  it("memoizes successful results within the TTL", async () => {
    const fn = vi.fn(async (a: number) => a * 2);
    const cached = cachedFor(fn, 1000);

    const [a, b] = await Promise.all([cached(2), cached(2)]);
    expect(a).toBe(4);
    expect(b).toBe(4);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("re-invokes fn after a rejection", async () => {
    const fn = vi.fn();
    fn.mockRejectedValueOnce(new Error("boom"));
    fn.mockResolvedValueOnce("ok");
    const cached = cachedFor(fn, 1000);

    await expect(cached()).rejects.toThrow("boom");
    await expect(cached()).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("evicts expired entries on access", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockResolvedValue("value");
      const cached = cachedFor(fn, 1000);

      await cached("a");
      expect(fn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1001);
      await cached("a");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never exceeds the max entries cap", () => {
    const fn = vi.fn(async (a: number) => a);
    const cached = cachedFor(fn, 1000, 3);

    for (let i = 0; i < 10; i++) {
      void cached(i);
    }

    // Only the most recent 3 keys should remain cached.
    for (let i = 0; i < 7; i++) {
      void cached(i);
    }
    for (let i = 7; i < 10; i++) {
      void cached(i);
    }

    // Keys 0-6 were evicted, so they re-invoke fn; keys 7-9 are cached.
    expect(fn.mock.calls.length).toBe(10 + 7);
  });
});

function controlledClock(start = 1000) {
  let now = start;
  const original = Date.now;
  Date.now = () => now;
  return {
    advance(ms: number) {
      now += ms;
    },
    restore() {
      Date.now = original;
    },
  };
}

it("cached-for returns the memoized value on a hit within the ttl", async () => {
  const clock = controlledClock();
  try {
    let calls = 0;
    const read = cachedFor(async (id: number) => {
      calls += 1;
      return id * 10;
    }, 5000);

    expect(await read(2)).toBe(20);
    clock.advance(4999);
    expect(await read(2)).toBe(20);
    expect(calls).toBe(1);
  } finally {
    clock.restore();
  }
});

it("cached-for re-invokes the function after the ttl expires", async () => {
  const clock = controlledClock();
  try {
    let calls = 0;
    const read = cachedFor(async (id: number) => {
      calls += 1;
      return id + calls;
    }, 1000);

    expect(await read(1)).toBe(2);
    clock.advance(1000);
    expect(await read(1)).toBe(3);
    expect(calls).toBe(2);
  } finally {
    clock.restore();
  }
});

it("cached-for keys entries by json-stringified arguments", async () => {
  const clock = controlledClock();
  try {
    const calls = new Map<string, number>();
    const read = cachedFor(async (args: { id: number }) => {
      const key = JSON.stringify(args);
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return args.id * 100;
    }, 5000);

    expect(await read({ id: 1 })).toBe(100);
    expect(await read({ id: 2 })).toBe(200);
    expect(calls.get(JSON.stringify({ id: 1 }))).toBe(1);
    expect(calls.get(JSON.stringify({ id: 2 }))).toBe(1);

    expect(await read({ id: 1 })).toBe(100);
    expect(calls.get(JSON.stringify({ id: 1 }))).toBe(1);
  } finally {
    clock.restore();
  }
});

it("cached-for shares one in-flight promise among concurrent callers", async () => {
  const clock = controlledClock();
  try {
    let calls = 0;
    let resolve: (value: number) => void = () => {};
    const pending = new Promise<number>((r) => {
      resolve = r;
    });
    const read = cachedFor((_id: number) => {
      calls += 1;
      return pending;
    }, 5000);

    const a = read(7);
    const b = read(7);
    const c = read(7);
    expect(calls).toBe(1);

    resolve(42);
    const results = await Promise.all([a, b, c]);
    expect(results).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
  } finally {
    clock.restore();
  }
});
