import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { createDb, companies, companyMemberships, companyObservability, companySecrets, companySecretBindings, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { DEFAULT_AGENT_OBSERVABILITY_CAPTURE, type UpdateAgentObservabilityRequest } from "@paperclipai/shared";
import { agentObservabilityService } from "../services/agent-observability.js";
import { agentObservabilityRoutes } from "../routes/agent-observability.js";
import { secretService } from "../services/secrets.js";
import * as secretsModule from "../services/secrets.js";
import { errorHandler } from "../middleware/index.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>, home: string;
beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-observability-")));
  vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "observability-test");
  database = await startEmbeddedPostgresTestDatabase("paperclip-observability-db-");
  db = createDb(database.connectionString);
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
let sequence = 0;
async function fixture() {
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Observability fixture", issuePrefix: `OB${++sequence}` });
  await db.insert(companyMemberships).values({ companyId, principalId: "alice", principalType: "user", status: "active", membershipRole: "owner" });
  return { companyId, service: agentObservabilityService(db) };
}
const braintrust = (expectedRevision: string | null = null): UpdateAgentObservabilityRequest => ({ expectedRevision,
  enabled: true, capture: { ...DEFAULT_AGENT_OBSERVABILITY_CAPTURE }, destination: { provider: "braintrust", projectId: randomUUID() },
  credentials: { mode: "replace", apiKey: "observability-secret-canary-123456" } });

describe("company agent observability", () => {
  it("creates atomically, returns no credentials, and rejects stale writes before rotation", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([f.service.configure(f.companyId, "alice", braintrust()), f.service.configure(f.companyId, "alice", braintrust())]);
    expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(row => row.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const saved = (await f.service.settings(f.companyId))!;
    expect(JSON.stringify(saved)).not.toContain("canary");
    expect(saved).not.toHaveProperty("credentialsSecretId");
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.companyId));
    expect(secret.latestVersion).toBe(1);
    await expect(f.service.configure(f.companyId, "alice", braintrust())).rejects.toMatchObject({ status: 409 });
    expect((await secretService(db).getById(secret.id))?.latestVersion).toBe(1);
    const resolved = await f.service.resolve(f.companyId);
    expect(resolved).toMatchObject({ state: "enabled", logsEndpoint: "https://api.braintrust.dev/otel/v1/logs", headers: { authorization: "Bearer observability-secret-canary-123456", "x-bt-parent": `project_id:${saved.destination.provider === "braintrust" ? saved.destination.projectId : ""}` } });
    const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(JSON.stringify(audit)).not.toContain("canary");
  });
  it("retains, updates, and removes write-only custom headers", async () => {
    const f = await fixture();
    let saved = await f.service.configure(f.companyId, "alice", { expectedRevision: null, enabled: true, capture: { ...DEFAULT_AGENT_OBSERVABILITY_CAPTURE },
      destination: { provider: "otlp", endpointBaseUrl: "https://collector.example.com/otel/" },
      credentials: { mode: "replace", headers: [{ name: "Authorization", value: "Bearer keep-me" }, { name: "X-Old", value: "remove-me" }] } });
    saved = await f.service.configure(f.companyId, "alice", { expectedRevision: saved.revision, enabled: true, capture: saved.capture, destination: saved.destination as { provider: "otlp"; endpointBaseUrl: string },
      credentials: { mode: "replace", headers: [{ name: "AUTHORIZATION" }, { name: "x-new", value: "new-value" }] } });
    const resolved = await f.service.resolve(f.companyId);
    expect(resolved).toMatchObject({ state: "enabled", logsEndpoint: "https://collector.example.com/otel/v1/logs", headers: { authorization: "Bearer keep-me", "x-new": "new-value" } });
    if (resolved.state === "enabled") expect(resolved.headers).not.toHaveProperty("x-old");
    await expect(f.service.configure(f.companyId, "alice", { expectedRevision: saved.revision, enabled: true, capture: saved.capture, destination: saved.destination as { provider: "otlp"; endpointBaseUrl: string },
      credentials: { mode: "replace", headers: [{ name: "renamed" }] } })).rejects.toMatchObject({ status: 422 });
    await f.service.remove(f.companyId, "alice", saved.revision);
    expect(await f.service.settings(f.companyId)).toBeNull();
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.companyId))).toEqual([]);
  });
  it("keeps project routing current and changes process compatibility on external key rotation", async () => {
    const f = await fixture(); const saved = await f.service.configure(f.companyId, "alice", braintrust());
    const before = await f.service.resolve(f.companyId);
    const [row] = await db.select().from(companyObservability).where(eq(companyObservability.companyId, f.companyId));
    await secretService(db).rotate(row.credentialsSecretId!, { value: JSON.stringify({ schema: "paperclip.agent_observability.credentials.v1", headers: { authorization: "Bearer rotated" } }) });
    const rotated = await f.service.resolve(f.companyId);
    expect(rotated.compatibilityKey).not.toBe(before.compatibilityKey);
    const projectId = randomUUID();
    await f.service.configure(f.companyId, "alice", { expectedRevision: saved.revision, enabled: true, capture: saved.capture, destination: { provider: "braintrust", projectId }, credentials: { mode: "keep" } });
    expect(await f.service.resolve(f.companyId)).toMatchObject({ headers: { authorization: "Bearer rotated", "x-bt-parent": `project_id:${projectId}` } });
  });
  it("uses the selected numeric credential version even when latest rotates before value resolution", async () => {
    const f = await fixture(); await f.service.configure(f.companyId, "alice", braintrust());
    const before = await f.service.resolve(f.companyId);
    const original = secretsModule.secretService;
    const spy = vi.spyOn(secretsModule, "secretService").mockImplementation(executor => {
      const service = original(executor);
      return { ...service, resolveSecretVersion: async (...args: Parameters<typeof service.resolveSecretVersion>) => {
        const version = await service.resolveSecretVersion(...args);
        await original(db).rotate(args[1], { value: JSON.stringify({ schema: "paperclip.agent_observability.credentials.v1", headers: { authorization: "Bearer concurrently-rotated" } }) });
        return version;
      } };
    });
    try {
      const resolved = await f.service.resolve(f.companyId);
      expect(resolved).toMatchObject({ state: "enabled", headers: { authorization: "Bearer observability-secret-canary-123456" } });
      expect(resolved.compatibilityKey).toBe(before.compatibilityKey);
    } finally { spy.mockRestore(); }
    expect(await f.service.resolve(f.companyId)).toMatchObject({ headers: { authorization: "Bearer concurrently-rotated" } });
  });
  it("can disable and remove when credentials are unavailable", async () => {
    const f = await fixture(); const saved = await f.service.configure(f.companyId, "alice", braintrust());
    const [row] = await db.select().from(companyObservability).where(eq(companyObservability.companyId, f.companyId));
    await secretService(db).update(row.credentialsSecretId!, { status: "disabled" });
    expect(await f.service.resolve(f.companyId)).toMatchObject({ state: "unavailable", reason: "credentials_unavailable" });
    const disabled = await f.service.configure(f.companyId, "alice", { ...braintrust(saved.revision), enabled: false, destination: saved.destination as { provider: "braintrust"; projectId: string }, credentials: { mode: "keep" } });
    expect(await f.service.resolve(f.companyId)).toMatchObject({ state: "disabled" });
    await f.service.remove(f.companyId, "alice", disabled.revision);
  });
  it("does not attach an old test receipt after another administrator saves", async () => {
    const f = await fixture(); const saved = await f.service.configure(f.companyId, "alice", braintrust());
    const updated = await f.service.configure(f.companyId, "alice", { ...braintrust(saved.revision), enabled: false, credentials: { mode: "keep" } });
    const signal = { status: "accepted" as const, httpStatus: 200, rejectedRecords: 0, errorCode: null, message: null, durationMs: 1 };
    await expect(f.service.recordTest(f.companyId, "alice", { revision: saved.revision, marker: "stale-test", source: "control_plane", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "accepted", signals: { logs: signal, traces: signal } })).rejects.toMatchObject({ status: 409 });
    expect(await f.service.settings(f.companyId)).toMatchObject({ revision: updated.revision, lastTest: null });
  });
  it("retires feature credentials inside the company deletion transaction", async () => {
    const f = await fixture(); await f.service.configure(f.companyId, "alice", braintrust());
    await db.transaction(async tx => { await agentObservabilityService(tx as unknown as typeof db).removeForCompanyDeletion(f.companyId); });
    expect(await f.service.settings(f.companyId)).toBeNull();
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.companyId))).toEqual([]);
  });
  it("enforces board, company, and management permissions before accepting mutation payloads", async () => {
    const f = await fixture(), other = await fixture();
    const app = express(); app.use(express.json());
    let actor: Record<string, unknown> = { type: "board", userId: "alice", source: "session", companyIds: [f.companyId], memberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }] };
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    app.use("/api", agentObservabilityRoutes(db)); app.use(errorHandler);
    const url = `/api/companies/${f.companyId}/observability`;
    const created = await request(app).put(url).send(braintrust()); expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain("canary");
    expect((await request(app).get(`/api/companies/${other.companyId}/observability`)).status).toBe(403);
    actor = { ...actor, memberships: [{ companyId: f.companyId, status: "active", membershipRole: "viewer" }] };
    expect((await request(app).get(url)).body).toEqual({ canManage: false, settings: null });
    expect((await request(app).post(`${url}/test`).send({})).status).toBe(403);
    actor = { type: "agent", agentId: randomUUID(), companyId: f.companyId, source: "agent_key" };
    expect((await request(app).get(url)).status).toBe(403);
    expect((await request(app).delete(url).send({ expectedRevision: created.body.settings.revision })).status).toBe(403);
  });
});
