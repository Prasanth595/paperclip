// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultCreateValues } from "./agent-config-defaults";

describe("defaultCreateValues", () => {
  it("defaults the dangerous adapter flags to off", () => {
    expect(defaultCreateValues.dangerouslySkipPermissions).toBe(false);
    expect(defaultCreateValues.dangerouslyBypassSandbox).toBe(false);
  });
});
