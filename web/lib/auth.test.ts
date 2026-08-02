/// <reference types="node" />
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearStoredUser, getStoredSessionToken, getStoredUserId, storeUser } from "./auth";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

describe("auth storage", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
    (globalThis as { window?: unknown }).window = globalThis;
  });

  it("stores and clears user + session token", () => {
    storeUser("u1", "a@b.com", "u1.sig");
    assert.equal(getStoredUserId(), "u1");
    assert.equal(getStoredSessionToken(), "u1.sig");
    clearStoredUser();
    assert.equal(getStoredUserId(), null);
    assert.equal(getStoredSessionToken(), null);
  });
});
