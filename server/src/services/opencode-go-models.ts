import type { AdapterModel } from "@paperclipai/adapter-utils";

const OPENCODE_GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";

/** OpenCode Go model IDs carry the gateway namespace (`opencode-go/<id>`). */
export function isOpenCodeGoModelId(value: string): boolean {
  return value.startsWith("opencode-go/") && value.length > "opencode-go/".length;
}


let cached: { until: number; models: AdapterModel[] } | undefined;
let pending: Promise<AdapterModel[]> | undefined;

/**
 * OpenCode Go's catalog is public for discovery, so it is read directly rather
 * than shelled out of the host.
 *
 * The gateway answers `{ object: "list", data: [{ id, object, created,
 * owned_by }] }` and names its models without a provider prefix or a slash
 * (`glm-5.1`, `kimi-k2.5`). Everything the rest of the stack routes through
 * this provider carries the `opencode-go/` namespace, so discovery adds it and
 * the picker offers ids the gateway's own names resolve to.
 */
export async function listOpenCodeGoModels(refresh = false): Promise<AdapterModel[]> {
  if (!refresh && cached && cached.until > Date.now()) return cached.models;
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch(OPENCODE_GO_MODELS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Could not load OpenCode Go models. Retry or enter a model ID manually.");
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data)) throw new Error("OpenCode Go returned an invalid model catalog.");
    const models = body.data.flatMap((model) => {
      if (typeof model.id !== "string") return [];
      const id = model.id.trim();
      return id ? [{ id: `opencode-go/${id}`, label: `opencode-go/${id}` }] : [];
    });
    cached = { until: Date.now() + 60_000, models };
    return models;
  })();
  try { return await pending; } finally { pending = undefined; }
}
