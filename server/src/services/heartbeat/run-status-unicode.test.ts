import { describe, expect, it } from "vitest";
import {
  sanitizeRunPatchForPostgres,
  sanitizeRunScopeForPostgres,
  sanitizeRunStringForPostgres,
} from "./run-status-unicode.js";

describe("sanitizeRunStringForPostgres", () => {
  it("drops NUL characters", () => {
    expect(sanitizeRunStringForPostgres("a\u0000b\u0000")).toBe("ab");
  });

  it("replaces lone high and low surrogates", () => {
    expect(sanitizeRunStringForPostgres("\uD800")).toBe("\uFFFD");
    expect(sanitizeRunStringForPostgres("\uDC00")).toBe("\uFFFD");
    expect(sanitizeRunStringForPostgres("a\uD83Db")).toBe("a\uFFFDb");
    expect(sanitizeRunStringForPostgres("a\uDE80b")).toBe("a\uFFFDb");
  });

  it("preserves valid surrogate pairs", () => {
    expect(sanitizeRunStringForPostgres("rocket \u{1F680}")).toBe("rocket \u{1F680}");
    expect(sanitizeRunStringForPostgres("\u{1F600}\u{1F601}")).toBe("\u{1F600}\u{1F601}");
  });

  it("returns the same string instance when clean", () => {
    const value = "clean \u{1F680}";
    expect(sanitizeRunStringForPostgres(value)).toBe(value);
  });
});

describe("sanitizeRunScopeForPostgres", () => {
  it("sanitizes nested result_json values", () => {
    const patch = {
      resultJson: {
        summary: "ok\u0000",
        transcript: ["nul\u0000", { detail: "lone\uD800" }],
        emoji: "\u{1F680}",
      },
    };
    expect(sanitizeRunPatchForPostgres(patch)).toEqual({
      resultJson: {
        summary: "ok",
        transcript: ["nul", { detail: "lone\uFFFD" }],
        emoji: "\u{1F680}",
      },
    });
  });

  it("preserves deep object identity when nothing changed", () => {
    const resultJson = { summary: "done", nested: { emoji: "\u{1F680}" } };
    const patch = { status: "succeeded", resultJson };
    const sanitized = sanitizeRunPatchForPostgres(patch);
    expect(sanitized).toBe(patch);
    expect(sanitized.resultJson).toBe(resultJson);
    expect(sanitized.resultJson.nested).toBe(resultJson.nested);
  });

  it("does not mutate the input", () => {
    const patch = { resultJson: { summary: "ok\u0000", raw: "\uD800" } };
    const sanitized = sanitizeRunPatchForPostgres(patch);
    expect(patch.resultJson).toEqual({ summary: "ok\u0000", raw: "\uD800" });
    expect(sanitized).not.toBe(patch);
  });

  it("preserves Date and binary values", () => {
    const finishedAt = new Date("2026-10-19T00:00:00.000Z");
    const bytes = new Uint8Array([1, 2, 3]);
    const sanitized = sanitizeRunScopeForPostgres({ finishedAt, bytes });
    expect(sanitized.finishedAt).toBe(finishedAt);
    expect(sanitized.bytes).toBe(bytes);
  });

  it("leaves primitives and nullish values untouched", () => {
    expect(sanitizeRunScopeForPostgres(null)).toBeNull();
    expect(sanitizeRunScopeForPostgres(undefined)).toBeUndefined();
    expect(sanitizeRunScopeForPostgres(12)).toBe(12);
    expect(sanitizeRunScopeForPostgres(false)).toBe(false);
  });

  it("terminates on cyclic objects", () => {
    const cyclic: Record<string, unknown> = { summary: "clean" };
    cyclic.self = cyclic;
    expect(() => sanitizeRunScopeForPostgres(cyclic)).not.toThrow();
  });

  it("sanitizes property names", () => {
    const sanitized = sanitizeRunScopeForPostgres({
      ["bad\u0000key"]: "value",
      ["lone\uD800key"]: "value",
    });
    expect(sanitized).toEqual({
      badkey: "value",
      "lone\uFFFDkey": "value",
    });
  });

  it("keeps the last value when two property names sanitize to the same key", () => {
    const sanitized = sanitizeRunScopeForPostgres({ ["a\u0000"]: 1, a: 2 });
    expect(sanitized).toEqual({ a: 2 });
  });

  it("sanitizes strings at any depth", () => {
    let deep: Record<string, unknown> = { note: "bottom\u0000" };
    for (let index = 0; index < 20; index += 1) deep = { nested: deep };
    const sanitized = sanitizeRunScopeForPostgres(deep);
    let cursor = sanitized as Record<string, unknown>;
    for (let index = 0; index < 20; index += 1) cursor = cursor.nested as Record<string, unknown>;
    expect(cursor.note).toBe("bottom");
  });

  it("sanitizes a shared object at every reference", () => {
    const shared = { note: "nul\u0000" };
    const sanitized = sanitizeRunScopeForPostgres({ left: shared, right: shared });
    expect(sanitized).toEqual({
      left: { note: "nul" },
      right: { note: "nul" },
    });
  });

  it("sanitizes very deep structures without overflowing the stack", () => {
    let deep: unknown = "bottom\u0000";
    for (let index = 0; index < 4000; index += 1) deep = [deep];
    const sanitized = sanitizeRunScopeForPostgres(deep);
    let cursor = sanitized as unknown[];
    for (let index = 0; index < 4000; index += 1) cursor = cursor[0] as unknown[];
    expect(cursor).toBe("bottom");
  });

  it("keeps a sanitized __proto__ key as an own property", () => {
    const parsed = JSON.parse('{"__pro\\u0000to__":{"polluted":true}}') as Record<string, unknown>;
    const sanitized = sanitizeRunScopeForPostgres(parsed) as Record<string, unknown>;
    expect(Object.keys(sanitized)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(sanitized, "__proto__")?.value).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
