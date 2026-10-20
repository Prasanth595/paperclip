import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
const COPILOT_TIMEOUT_MS = 15_000;

export const COPILOT_REQUEST_HEADERS = Object.freeze({
  "Editor-Version": "vscode/1.104.1",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "Copilot-Integration-Id": "vscode-chat",
  "Openai-Intent": "conversation-panel",
  "X-GitHub-Api-Version": "2025-05-01",
  "User-Agent": "GitHubCopilotChat/0.26.7",
});

export type CopilotEndpointProtocol = "responses" | "chat" | "messages";

export interface CopilotModelMetadata {
  id: string;
  label: string;
  vendor?: string;
  pickerEnabled: boolean;
  supportedEndpoints: string[];
  protocol: CopilotEndpointProtocol;
}

export interface CopilotVerificationResult {
  status: "verified";
  version: "1.0.88";
  profileDigest: string;
  models: Array<{ id: string; label: string }>;
  catalog: CopilotModelMetadata[];
  baseUrl: string;
  apiToken: string;
  promptSent: false;
}

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};

const endpointProtocolCache = new Map<string, { baseUrl: string; apiToken: string; models: Map<string, CopilotModelMetadata>; expiresAt: number }>();

function getCachedCopilotEndpoint(token: string) {
  const entry = endpointProtocolCache.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    endpointProtocolCache.delete(token);
    return undefined;
  }
  return entry;
}

/**
 * Determine which endpoint protocol to use for a Copilot model based on its
 * `supported_endpoints` array (from `GET /models`) and model ID / vendor.
 *
 * Prevents `/responses` API errors:
 * - Models that ONLY support `/responses` (e.g. `gpt-5.3-codex`, `gpt-5.2-codex`,
 *   `gpt-5.1-codex*`, or GHE `gpt-5.4-mini`, `grok-4.7`, `mai-code-*`) MUST use
 *   `POST /responses` (`store: false`, `input` array).
 * - Models that ONLY support `/chat/completions` (e.g. `gemini-*`, `gpt-4.1`,
 *   `gpt-4o`, `gpt-5-mini`, `kimi-*`, `grok-code-fast-1`) MUST use `POST /chat/completions`.
 * - Models that ONLY support `/v1/messages` (e.g. `claude-opus-4.7`) MUST use `POST /v1/messages`.
 */
export function resolveCopilotModelProtocol(
  modelId: string,
  supportedEndpoints?: readonly string[],
  vendor?: string,
): CopilotEndpointProtocol {
  const lower = modelId.trim().toLowerCase();
  const endpoints = Array.isArray(supportedEndpoints) ? supportedEndpoints : [];

  if (endpoints.length > 0) {
    const hasResponses = endpoints.includes("/responses");
    const hasChat = endpoints.includes("/chat/completions");
    const hasMessages = endpoints.includes("/v1/messages");

    if (hasResponses && !hasChat && !hasMessages) return "responses";
    if (hasMessages && !hasChat && !hasResponses) return "messages";
    if (hasChat && !hasResponses && !hasMessages) return "chat";

    // Anthropic models with `/v1/messages` should use the native Anthropic Messages API
    // because Copilot CAPI's `/chat/completions` translation for Claude omits `object: "chat.completion"`.
    if (hasMessages && (lower.startsWith("claude-") || vendor?.toLowerCase() === "anthropic")) {
      return "messages";
    }

    // When multiple endpoints are supported:
    // - Codex / GPT-5+ / GPT-6+ / Grok-4.7 / MAI models prefer `/responses` if listed
    if (hasResponses && (/(?:^|[-_.])codex(?:$|[-_.])/.test(lower) || /^gpt-5/.test(lower) || /^gpt-6/.test(lower) || /^mai-/.test(lower))) {
      return "responses";
    }
    // - Chat Completions is the safest universal path for GPT/Gemini when listed
    if (hasChat) return "chat";
    if (hasResponses) return "responses";
    if (hasMessages) return "messages";
  }

  // Fallback heuristics when `/models` metadata is not cached:
  if (lower.startsWith("claude-") || vendor?.toLowerCase() === "anthropic") return "messages";
  if (
    /(?:^|[-_.])codex(?:$|[-_.])/.test(lower) ||
    /^gpt-5\.[3-9]/.test(lower) ||
    /^gpt-6/.test(lower) ||
    /^mai-/.test(lower) ||
    /^grok-4\.[5-9]/.test(lower)
  ) {
    return "responses";
  }
  return "chat";
}

function isTrustedCopilotApiUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (
      host === "api.githubcopilot.com" ||
      host.endsWith(".githubcopilot.com") ||
      host.endsWith(".ghe.com") ||
      host === "copilot-proxy.githubusercontent.com"
    ) {
      return url.href.replace(/\/+$/, "");
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Copilot API base URL and bearer token for a GitHub token (`gho_`, `ghu_`, `github_pat_`).
 * Checks `https://api.github.com/copilot_internal/user` first, then falls back to exchange or direct CAPI.
 */
export async function resolveCopilotApiEndpoint(
  rawToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ apiToken: string; baseUrl: string }> {
  const token = rawToken.trim();
  const candidates = [
    { userUrl: "https://api.github.com/copilot_internal/user", tokenUrl: "https://api.github.com/copilot_internal/v2/token", defaultBaseUrl: DEFAULT_COPILOT_API_BASE_URL },
    ...(process.env.GITHUB_COPILOT_API_URL
      ? [{ userUrl: "", tokenUrl: "", defaultBaseUrl: process.env.GITHUB_COPILOT_API_URL.replace(/\/+$/, "") }]
      : []),
    { userUrl: "https://api.microsoft.ghe.com/copilot_internal/user", tokenUrl: "https://api.microsoft.ghe.com/copilot_internal/v2/token", defaultBaseUrl: "https://copilot-api.microsoft.ghe.com" },
  ];

  for (const candidate of candidates) {
    if (!candidate.userUrl) {
      const trusted = isTrustedCopilotApiUrl(candidate.defaultBaseUrl);
      if (trusted) return { apiToken: token, baseUrl: trusted };
      continue;
    }
    try {
      const resp = await fetchImpl(candidate.userUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(COPILOT_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": COPILOT_REQUEST_HEADERS["User-Agent"],
        },
      });
      if (resp.ok) {
        const body = asRecord(await resp.json().catch(() => ({})));
        const endpoints = asRecord(body.endpoints);
        const apiUrl = typeof endpoints.api === "string" ? isTrustedCopilotApiUrl(endpoints.api) : null;
        return {
          apiToken: token,
          baseUrl: apiUrl ?? candidate.defaultBaseUrl,
        };
      }
      await resp.body?.cancel().catch(() => undefined);
    } catch {
      // Try next candidate
    }

    // Also try v2/token exchange for classic OAuth tokens
    if (candidate.tokenUrl && (token.startsWith("gho_") || token.startsWith("ghu_"))) {
      try {
        const resp = await fetchImpl(candidate.tokenUrl, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(COPILOT_TIMEOUT_MS),
          headers: {
            Accept: "application/json",
            Authorization: `token ${token}`,
            ...COPILOT_REQUEST_HEADERS,
          },
        });
        if (resp.ok) {
          const body = asRecord(await resp.json().catch(() => ({})));
          const exchanged = typeof body.token === "string" ? body.token.trim() : "";
          const endpoints = asRecord(body.endpoints);
          const apiUrl = typeof endpoints.api === "string" ? isTrustedCopilotApiUrl(endpoints.api) : null;
          if (exchanged) {
            return {
              apiToken: exchanged,
              baseUrl: apiUrl ?? candidate.defaultBaseUrl,
            };
          }
        }
        await resp.body?.cancel().catch(() => undefined);
      } catch {
        // Continue
      }
    }
  }

  return { apiToken: token, baseUrl: "https://api.githubcopilot.com" };
}

/**
 * Discover models directly from GitHub Copilot's `/models` endpoint and verify
 * optional model selection without sending a prompt.
 */
export async function probeCopilotDirectApi(
  rawToken: string,
  requestedModel?: string,
  fetchImpl: typeof fetch = fetch,
  profileDigest = "sha256:1dad3d26d91e66c6f911dbfa43e7963f36c0bbf0d7709f4bbb568029a8b4b46a",
): Promise<
  | CopilotVerificationResult
  | { status: "failed"; code: string; message: string; promptSent: false }
> {
  const token = rawToken.trim();
  if (requestedModel && ["auto", "default"].includes(requestedModel.trim().toLowerCase())) {
    return { status: "failed", code: "COPILOT_MODEL_UNAVAILABLE", message: "Select an explicit Copilot model.", promptSent: false };
  }
  if (!token || token.includes("\0")) {
    return { status: "failed", code: "COPILOT_AUTH_REQUIRED", message: "Enter a valid GitHub Copilot token.", promptSent: false };
  }

  try {
    const { apiToken, baseUrl } = await resolveCopilotApiEndpoint(token, fetchImpl);
    const response = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(COPILOT_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
        ...COPILOT_REQUEST_HEADERS,
      },
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401) {
        return { status: "failed", code: "COPILOT_AUTH_REQUIRED", message: "GitHub Copilot rejected this token. Check your token and try again.", promptSent: false };
      }
      if (response.status === 403) {
        return { status: "failed", code: "COPILOT_ENTITLEMENT_DENIED", message: "This GitHub account does not have active Copilot access.", promptSent: false };
      }
      return { status: "failed", code: "COPILOT_REQUEST_FAILED", message: "Could not verify GitHub Copilot models.", promptSent: false };
    }

    const body = asRecord(await response.json());
    const rawModels = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    const catalog: CopilotModelMetadata[] = [];
    const seen = new Set<string>();

    for (const item of rawModels.slice(0, 200)) {
      const entry = asRecord(item);
      const id = typeof entry.id === "string" ? entry.id.trim() : typeof entry.modelId === "string" ? entry.modelId.trim() : "";
      if (!id || seen.has(id) || ["auto", "default"].includes(id.toLowerCase()) || id.startsWith("accounts/")) continue;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(id)) continue;
      const capabilities = asRecord(entry.capabilities);
      if (typeof capabilities.type === "string" && capabilities.type !== "chat") continue;
      const policy = asRecord(entry.policy);
      if (policy.state === "disabled" || policy.state === "unconfigured") continue;

      const supportedEndpoints = Array.isArray(entry.supported_endpoints)
        ? entry.supported_endpoints.filter((e): e is string => typeof e === "string")
        : [];
      const vendor = typeof entry.vendor === "string" ? entry.vendor : undefined;
      const rawName = typeof entry.name === "string" ? entry.name.trim() : id;
      const label = !/[\x00-\x1f\x7f]|github_pat_|gh[pousr]_/.test(rawName) && rawName ? rawName.slice(0, 200) : id;

      seen.add(id);
      catalog.push({
        id,
        label,
        vendor,
        pickerEnabled: entry.model_picker_enabled !== false,
        supportedEndpoints,
        protocol: resolveCopilotModelProtocol(id, supportedEndpoints, vendor),
      });
    }

    if (catalog.length === 0) {
      return { status: "failed", code: "COPILOT_MODEL_UNAVAILABLE", message: "No available Copilot models were discovered for this account.", promptSent: false };
    }

    if (requestedModel && !catalog.some((m) => m.id === requestedModel)) {
      return { status: "failed", code: "COPILOT_MODEL_UNAVAILABLE", message: "The selected Copilot model is unavailable for this account.", promptSent: false };
    }

    endpointProtocolCache.set(token, {
      baseUrl,
      apiToken,
      models: new Map(catalog.map((m) => [m.id, m])),
      expiresAt: Date.now() + 10 * 60_000,
    });

    const models = catalog.map(({ id, label }) => ({ id, label }));
    return {
      status: "verified",
      version: "1.0.88",
      profileDigest,
      models,
      catalog,
      baseUrl,
      apiToken,
      promptSent: false,
    };
  } catch {
    return { status: "failed", code: "COPILOT_REQUEST_FAILED", message: "Copilot metadata verification failed.", promptSent: false };
  }
}

/**
 * Create an AI SDK v4 LanguageModel for `github` (GitHub Copilot) that routes
 * each model to its supported endpoint (`/responses`, `/chat/completions`, or `/v1/messages`)
 * and injects required Copilot headers + `store: false` on `/responses`.
 */
export function createGitHubCopilotLanguageModel(
  credential: string,
  modelId: string,
  fetchImpl?: typeof fetch,
): Extract<LanguageModel, { specificationVersion: "v4" }> {
  const token = credential.trim();
  const cached = getCachedCopilotEndpoint(token);
  const cachedModel = cached?.models.get(modelId);
  const protocol = cachedModel?.protocol ?? resolveCopilotModelProtocol(modelId, cachedModel?.supportedEndpoints, cachedModel?.vendor);

  const copilotFetch: typeof fetch = async (inputUrl, init) => {
    const activeCache = getCachedCopilotEndpoint(token);
    let baseUrl = activeCache?.baseUrl;
    let apiToken = activeCache?.apiToken ?? token;
    if (!baseUrl) {
      const resolved = await resolveCopilotApiEndpoint(token, fetchImpl ?? globalThis.fetch);
      baseUrl = resolved.baseUrl;
      apiToken = resolved.apiToken;
    }

    const parsedUrl = new URL(String(inputUrl));
    const targetUrl = `${baseUrl.replace(/\/+$/, "")}${parsedUrl.pathname}${parsedUrl.search}`;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${apiToken}`);
    for (const [key, value] of Object.entries(COPILOT_REQUEST_HEADERS)) {
      if (!headers.has(key)) headers.set(key, value);
    }

    let body = init?.body;
    if (typeof body === "string" && parsedUrl.pathname.endsWith("/responses")) {
      try {
        const parsedBody = JSON.parse(body) as RecordValue;
        // Copilot Responses API requires store: false and input as message array
        if (parsedBody.store === undefined) parsedBody.store = false;
        if (typeof parsedBody.input === "string") {
          parsedBody.input = [{ role: "user", content: parsedBody.input }];
        }
        body = JSON.stringify(parsedBody);
      } catch {
        // Keep original body if not valid JSON
      }
    } else if (typeof body === "string" && parsedUrl.pathname.endsWith("/v1/messages")) {
      try {
        const parsedBody = JSON.parse(body) as RecordValue;
        // `@ai-sdk/anthropic` defaults unknown model IDs (e.g. claude-haiku-5.5, claude-sonnet-5)
        // to max_tokens: 128000, which exceeds some models' 64000 limit unless capped.
        if (typeof parsedBody.max_tokens !== "number" || parsedBody.max_tokens > 16384) {
          parsedBody.max_tokens = 4096;
        }
        body = JSON.stringify(parsedBody);
      } catch {
        // Keep original body if not valid JSON
      }
    }

    return (fetchImpl ?? globalThis.fetch)(targetUrl, {
      ...init,
      headers,
      body,
      redirect: "error",
    });
  };

  if (protocol === "messages") {
    return createAnthropic({
      baseURL: "https://api.githubcopilot.com/v1",
      authToken: token,
      fetch: copilotFetch,
    })(modelId);
  }

  const openai = createOpenAI({
    baseURL: "https://api.githubcopilot.com",
    apiKey: token,
    fetch: copilotFetch,
  });

  return protocol === "responses" ? openai.responses(modelId) : openai.chat(modelId);
}
