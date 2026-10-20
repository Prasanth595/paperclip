import { describe, expect, it, vi } from "vitest";
import { validateAiApiKey } from "./ai-api-key-test.js";

function reply(status: number) {
  return new Response(null, { status });
}

describe("validateAiApiKey", () => {
  it("rejects an invalid OpenCode key at the authenticated endpoint", async () => {
    const request = vi.fn().mockResolvedValue(reply(401));
    await expect(
      validateAiApiKey("opencode", "invalid-key", request as unknown as typeof fetch),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "ai_connection_api_key_rejected" },
    });
    expect(request).toHaveBeenCalledWith(
      "https://opencode.ai/console/api/v2/config",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("accepts a valid OpenCode key", async () => {
    const request = vi.fn().mockResolvedValue(reply(200));
    await expect(
      validateAiApiKey("opencode", "valid-key", request as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });

  it("maps a provider outage to a retryable verification failure", async () => {
    const request = vi.fn().mockResolvedValue(reply(503));
    await expect(
      validateAiApiKey("opencode", "valid-key", request as unknown as typeof fetch),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "ai_connection_verification_failed" },
    });
  });
});
