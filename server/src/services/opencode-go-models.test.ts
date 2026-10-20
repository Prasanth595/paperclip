import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("lists and caches the public OpenCode Go catalog with the namespace every id routes by", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ object: "list", data: [
    { id: "deepseek-v4-pro", object: "model", created: 1792163383, owned_by: "opencode" },
    { id: "glm-5.1", object: "model", created: 1792163383, owned_by: "opencode" },
    { id: 42 },
  ] }) });
  vi.stubGlobal("fetch", fetch);
  const { listOpenCodeGoModels } = await import("./opencode-go-models.js");
  expect(await listOpenCodeGoModels()).toEqual([
    { id: "opencode-go/deepseek-v4-pro", label: "opencode-go/deepseek-v4-pro" },
    { id: "opencode-go/glm-5.1", label: "opencode-go/glm-5.1" },
  ]);
  await listOpenCodeGoModels();
  expect(fetch).toHaveBeenCalledTimes(1);
  // No headers: the gateway answers discovery without anyone's credentials.
  expect(fetch).toHaveBeenCalledWith("https://opencode.ai/inference/go/v1/models", { signal: expect.any(AbortSignal) });
  await listOpenCodeGoModels(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("allows retry after a public catalog failure", async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
  vi.stubGlobal("fetch", fetch);
  const { listOpenCodeGoModels } = await import("./opencode-go-models.js");
  await expect(listOpenCodeGoModels()).rejects.toThrow("Retry or enter a model ID manually");
  await expect(listOpenCodeGoModels()).resolves.toEqual([]);
});
