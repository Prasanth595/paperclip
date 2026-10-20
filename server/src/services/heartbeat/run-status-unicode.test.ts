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
});
