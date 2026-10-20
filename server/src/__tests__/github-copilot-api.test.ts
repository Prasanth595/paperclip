import { describe, expect, it, vi } from "vitest";
import {
  resolveCopilotModelProtocol,
  probeCopilotDirectApi,
  createGitHubCopilotLanguageModel,
} from "../services/github-copilot-api.js";
import { fastResponsePrompt, runFastResponseProvider } from "../services/fast-response-provider.js";

const ack = "I’ll check the settings panel’s border styling and work on the fix.";

describe("github-copilot-api direct protocol routing & provider matrix", () => {
  it("routes models to the exact endpoint protocol required by Copilot CAPI", () => {
    // Responses-only models (Codex / GHE GPT-5.4-mini / Grok-4.7 / MAI)
    expect(resolveCopilotModelProtocol("gpt-5.3-codex", ["/responses"])).toBe("responses");
    expect(resolveCopilotModelProtocol("gpt-5.4-mini", ["/responses"])).toBe("responses");
    expect(resolveCopilotModelProtocol("grok-4.7", ["/responses"])).toBe("responses");
    expect(resolveCopilotModelProtocol("mai-code-1.1-flash", ["/responses"])).toBe("responses");

    // Dual-endpoint Codex/GPT-5.4 prefers /responses
    expect(resolveCopilotModelProtocol("gpt-5.4", ["/chat/completions", "/responses"])).toBe("responses");

    // Chat-Completions-only models (Google Gemini, Azure OpenAI gpt-5-mini, Grok Code Fast, Kimi)
    expect(resolveCopilotModelProtocol("gemini-4-argon", ["/chat/completions"])).toBe("chat");
    expect(resolveCopilotModelProtocol("gemini-3.1-pro-preview", ["/chat/completions"])).toBe("chat");
    expect(resolveCopilotModelProtocol("gpt-5-mini", ["/chat/completions"])).toBe("chat");
    expect(resolveCopilotModelProtocol("grok-code-fast-1", ["/chat/completions"])).toBe("chat");
    expect(resolveCopilotModelProtocol("kimi-k3", ["/chat/completions"])).toBe("chat");

    // Anthropic models: claude-opus-4.7 is /v1/messages-only; dual-endpoint Claude models use /v1/messages
    // because Copilot CAPI's /chat/completions translation for Claude omits `object: "chat.completion"`.
    expect(resolveCopilotModelProtocol("claude-opus-4.7", ["/v1/messages"], "Anthropic")).toBe("messages");
    expect(resolveCopilotModelProtocol("claude-sonnet-5", ["/v1/messages", "/chat/completions"], "Anthropic")).toBe("messages");
    expect(resolveCopilotModelProtocol("claude-sonnet-4.6", ["/v1/messages", "/chat/completions"], "Anthropic")).toBe("messages");
  });

  it("discovers models across all providers via /copilot_internal/user and /models", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/copilot_internal/user")) {
        return new Response(
          JSON.stringify({
            copilot_plan: "enterprise",
            endpoints: { api: "https://copilot-api.microsoft.ghe.com" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://copilot-api.microsoft.ghe.com/models") {
        return new Response(
          JSON.stringify({
            data: [
              { id: "gpt-5.4-mini", name: "GPT-5.4 mini", vendor: "OpenAI", supported_endpoints: ["/responses"], capabilities: { type: "chat" } },
              { id: "claude-sonnet-5", name: "Claude Sonnet 5", vendor: "Anthropic", supported_endpoints: ["/v1/messages", "/chat/completions"], capabilities: { type: "chat" } },
              { id: "claude-opus-4.7", name: "Claude Opus 4.7", vendor: "Anthropic", supported_endpoints: ["/v1/messages"], capabilities: { type: "chat" } },
              { id: "gemini-4-argon", name: "Gemini 4 Argon", vendor: "Google", supported_endpoints: ["/chat/completions"], capabilities: { type: "chat" } },
              { id: "grok-4.7", name: "Grok 4.7", vendor: "xAI", supported_endpoints: ["/responses"], capabilities: { type: "chat" } },
              { id: "mai-code-1.1-flash", name: "MAI-Code-1.1-Flash", vendor: "Microsoft", supported_endpoints: ["/responses"], capabilities: { type: "chat" } },
              { id: "gpt-5-mini", name: "GPT-5 mini", vendor: "Azure OpenAI", supported_endpoints: ["/chat/completions"], capabilities: { type: "chat" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const res = await probeCopilotDirectApi("gho_test_token_123", "gpt-5.4-mini", mockFetch);
    expect(res.status).toBe("verified");
    if (res.status === "verified") {
      expect(res.baseUrl).toBe("https://copilot-api.microsoft.ghe.com");
      expect(res.models.map((m) => m.id)).toEqual([
        "gpt-5.4-mini",
        "claude-sonnet-5",
        "claude-opus-4.7",
        "gemini-4-argon",
        "grok-4.7",
        "mai-code-1.1-flash",
        "gpt-5-mini",
      ]);
    }
  });

  it.each([
    { vendor: "OpenAI", model: "gpt-5.3-codex", expectedPath: "/responses" },
    { vendor: "Anthropic (Sonnet)", model: "claude-sonnet-4.6", expectedPath: "/v1/messages" },
    { vendor: "Anthropic (Opus)", model: "claude-opus-4.7", expectedPath: "/v1/messages" },
    { vendor: "Google", model: "gemini-3.1-pro-preview", expectedPath: "/chat/completions" },
    { vendor: "xAI", model: "grok-4.7", expectedPath: "/responses" },
    { vendor: "Microsoft", model: "mai-code-1.1-flash", expectedPath: "/responses" },
  ])("executes fastResponseProvider for $vendor ($model) via $expectedPath without /responses errors", async ({ model, expectedPath }) => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/copilot_internal/user")) {
        return new Response(
          JSON.stringify({ endpoints: { api: "https://api.individual.githubcopilot.com" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body: parsedBody });

      if (url.endsWith("/responses")) {
        expect(parsedBody.store).toBe(false);
        expect(Array.isArray(parsedBody.input)).toBe(true);
        return new Response(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            created_at: 1,
            model,
            status: "completed",
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: ack, annotations: [] }],
              },
            ],
            usage: { input_tokens: 40, output_tokens: 14, total_tokens: 54 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/v1/messages")) {
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text: ack }],
            stop_reason: "end_turn",
            usage: { input_tokens: 40, output_tokens: 14 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          object: "chat.completion",
          created: 1,
          model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: ack } }],
          usage: { prompt_tokens: 40, completion_tokens: 14, total_tokens: 54 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const outcome = await runFastResponseProvider(
      {
        metadata: { provider: "github", method: "api_key" },
        credential: "gho_fixture_token",
        model,
        prompt: fastResponsePrompt({ agentName: "Alex", message: "Fix the border" }),
        signal: AbortSignal.timeout(5000),
      },
      { fetch: mockFetch },
    );

    expect(outcome.errorCode).toBeUndefined();
    expect(outcome.text).toBe(ack);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.individual.githubcopilot.com${expectedPath}`);
  });

  it("expires cached Copilot endpoint entries after the 10-minute TTL", async () => {
    let now = 1_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let userCalls = 0;
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/copilot_internal/user")) {
        userCalls += 1;
        return new Response(
          JSON.stringify({ endpoints: { api: `https://api-${userCalls}.githubcopilot.com` } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "gpt-4.1", name: "GPT-4.1", vendor: "OpenAI", supported_endpoints: ["/chat/completions"], capabilities: { type: "chat" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl_ttl",
          object: "chat.completion",
          created: 1,
          model: "gpt-4.1",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: ack } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      await probeCopilotDirectApi("gho_ttl_token", "gpt-4.1", mockFetch);
      expect(userCalls).toBe(1);

      // Within TTL: uses cached endpoint without calling /copilot_internal/user again
      now += 5 * 60_000;
      await runFastResponseProvider(
        {
          metadata: { provider: "github", method: "api_key" },
          credential: "gho_ttl_token",
          model: "gpt-4.1",
          prompt: fastResponsePrompt({ agentName: "Alex", message: "Check TTL" }),
          signal: AbortSignal.timeout(5000),
        },
        { fetch: mockFetch },
      );
      expect(userCalls).toBe(1);

      // Past 10-minute TTL: refreshes endpoint via /copilot_internal/user
      now += 6 * 60_000;
      await runFastResponseProvider(
        {
          metadata: { provider: "github", method: "api_key" },
          credential: "gho_ttl_token",
          model: "gpt-4.1",
          prompt: fastResponsePrompt({ agentName: "Alex", message: "Check expired TTL" }),
          signal: AbortSignal.timeout(5000),
        },
        { fetch: mockFetch },
      );
      expect(userCalls).toBe(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
