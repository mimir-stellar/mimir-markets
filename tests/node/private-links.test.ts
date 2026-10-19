import { test } from "node:test";
import assert from "node:assert";

import {
  rememberPrivateInviteKey,
  getStoredPrivateInviteKey,
  generatePrivateInviteKey,
} from "../../lib/private-links";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

function installWindowShim(): MemoryStorage {
  const storage = new MemoryStorage();
  const globals = globalThis as typeof globalThis & {
    window?: unknown;
  };
  globals.window = { localStorage: storage };
  return storage;
}

function resetWindowShim(): void {
  const globals = globalThis as typeof globalimport .This & { window?: unknown };
  delete globals.window;
}

test("rememberPrivateInviteKey ignores empty keys", () => {
  const storage = installWindowShim();
  try {
    rememberPrivateInviteKey("", "invite-key");
    rememberPrivateInviteKey("  ", "invite-key");

    assert.deepStrictEqual(getStoredPrivateInviteKey(), {});
    assert.strictEqual(storage.length, 0);
  } finally {
    resetWindowShim();
  }
});

test("rememberPrivateInviteKey round trips through localStorage", () => {
  const storage = installWindowShim();
  try {
    rememberPrivateInviteKey("invite-key", "key-123");
    rememberPrivateInviteKey("another-invite", "key-456");

    assert.deepStrictEqual(getStoredPrivateInviteKey(), {
      "invite-key": "key-123",
      "another-invite": "key-456",
    });

    const raw = storage.getItem("proven.privateInviteKeys");
    assert.strictEqual(typeof raw, "string");
    assert.deepStrictEqual(JSON.parse(raw as string), {
      "invite-key": "key-123",
      "another-invite": "key-456",
    });
  } finally {
    resetWindowShim();
  }
});

test("getStoredPrivateInviteKey returns empty map for corrupted JSON", () => {
  const storage = installWindowShim();
  try {
    storage.setItem("proven.privateInviteKeys", "{not valid json");
    assert.deepStrictEqual(getStoredPrivateInviteKey(), {});
  } finally {
    resetWindowShim();
  }
});

test("generatePrivateInviteKey returns 32 hex characters", () => {
  const key = generatePrivateInviteKey();
  assert.strictEqual(key.length, 32);
  assert.match(key, /^[0-9a-f]{32}$/);
});
