import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  costEvents,
  agents,
  companies,
  createDb,
  type Db,
  environmentLeases,
  environments,
  heartbeatRuns,
  heartbeatRunEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { logger } from "../middleware/logger.ts";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.ts";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { nativeWorkspaceExportPendingForLease } from "../services/native-runtime/native-workspace-finalization-state.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres orphaned active lease sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("heartbeat sweepOrphanedActiveLeases", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphaned-active-lease-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentAndEnvironment() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(environments).values({
      id: environmentId,
      companyId,
      name: `Fake Sandbox ${environmentId}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "fake", image: "ubuntu:24.04" },
    });
    return { companyId, agentId, environmentId };
  }

  async function insertHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    status: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      status: input.status,
      nextEventSeq: 1,
    });
    return id;
  }

  async function insertActiveLease(input: {
    companyId: string;
    environmentId: string | null;
    heartbeatRunId: string | null;
    updatedAt: Date;
    provider?: string;
    providerLeaseId?: string;
    status?: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(environmentLeases).values({
      id,
      companyId: input.companyId,
      environmentId: input.environmentId,
      heartbeatRunId: input.heartbeatRunId,
      status: input.status ?? "active",
      leasePolicy: "reuse_by_environment",
      provider: input.provider ?? "fake",
      providerLeaseId: input.providerLeaseId ?? `sandbox://fake/${id}`,
      acquiredAt: input.updatedAt,
      lastUsedAt: input.updatedAt,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    });
    return id;
  }

  async function leaseRow(leaseId: string) {
    return db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
  }

  const oldEnough = () => new Date(Date.now() - 60 * 60 * 1000);

  async function seedUnexportedWorkspace(status = "active") {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({ companyId, environmentId, heartbeatRunId: runId, status, updatedAt: oldEnough() });
    await db.update(environmentLeases).set({ leasePolicy: "ephemeral" }).where(eq(environmentLeases.id, leaseId));
    const lease = (await leaseRow(leaseId))!;
    const reference = {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared",
      descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
      workspaceId: randomUUID(), leaseId, providerLeaseId: lease.providerLeaseId,
      remoteCwd: "/workspace", resourceDisposition: "destroy",
    };
    await db.update(heartbeatRuns).set({ runtimeMode: "native", runnerProfileJson: { nativeWorkspaceSync: reference } })
      .where(eq(heartbeatRuns.id, runId));
    return { companyId, agentId, environmentId, runId, leaseId, lease, reference };
  }

  it.each(["active", "pending_cleanup"])("preserves an unexported native workspace in %s across cleanup restart", async status => {
    const { runId, leaseId, reference } = await seedUnexportedWorkspace(status);
    const sandbox = await mkdtemp(join(tmpdir(), "native-export-cleanup-"));
    const output = join(sandbox, "unexported.txt");
    const nonce = randomUUID();
    await writeFile(output, nonce);
    const retryPendingSandboxTeardown = vi.fn(async () => {
      await rm(sandbox, { recursive: true, force: true });
    });
    const runtime = { retryPendingSandboxTeardown } as unknown as HeartbeatEnvironmentRuntime;
    try {
      const restarted = heartbeatService(db, { environmentRuntime: runtime });
      await restarted.sweepOrphanedActiveLeases({ backoffMs: 0 });
      await restarted.sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(retryPendingSandboxTeardown).not.toHaveBeenCalled();
      expect(await readFile(output, "utf8")).toBe(nonce);
      expect((await leaseRow(leaseId))?.status).toBe(status);

      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
        ...reference, state: "finalized", finalHostSha256: "c".repeat(64),
      } } }).where(eq(heartbeatRuns.id, runId));
      const afterExport = heartbeatService(db, { environmentRuntime: runtime });
      await afterExport.sweepOrphanedActiveLeases({ backoffMs: 0 });
      await afterExport.sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(retryPendingSandboxTeardown).toHaveBeenCalledOnce();
      expect((await leaseRow(leaseId))?.status).toBe("expired");
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("guards direct destructive release and teardown before provider dispatch", async () => {
    const { environmentId, runId, lease } = await seedUnexportedWorkspace();
    const runtime = environmentRuntimeService(db);
    const environment = (await db.select().from(environments).where(eq(environments.id, environmentId)))[0];
    const input = { environment, lease } as Parameters<typeof runtime.destroyRunLease>[0];
    expect(await runtime.releaseRunLeases(runId, "failed")).toEqual([]);
    expect(await runtime.releaseRunLeases(runId, "failed", undefined, "destroy")).toEqual([]);
    expect(await runtime.destroyRunLease(input)).toBeNull();
    await expect(runtime.retryPendingSandboxTeardown(input)).rejects.toThrow("Native workspace export is pending");
    expect(await leaseRow(lease.id)).toMatchObject({ status: "active", releasedAt: null });
  });

  it.each(["company", "run", "lease", "provider", "finalized", "no_workspace"])("does not pin an unrelated or exported source: %s", async mode => {
    const { companyId, agentId, runId, lease, reference } = await seedUnexportedWorkspace();
    const source = { ...lease };
    if (mode === "company") source.companyId = randomUUID();
    if (mode === "run") source.heartbeatRunId = randomUUID();
    if (mode === "lease") source.id = randomUUID();
    if (mode === "provider") source.providerLeaseId = randomUUID();
    if (mode === "finalized" || mode === "no_workspace") {
      await db.update(heartbeatRuns).set({
        ...(mode === "no_workspace" ? { driverKind: "openai_dot_mcp" } : {}),
        runnerProfileJson: {
          nativeWorkspaceSync: mode === "finalized" ? { ...reference, state: "finalized", finalHostSha256: "c".repeat(64) } : reference,
          ...(mode === "no_workspace" ? { nativeExecutionInput: {
            schema: "paperclip.native-execution-input.v6", binding: { runId, companyId, agentId, issueId: null },
            provider: { kind: "openai_dot" }, workspace: { access: "none", cwd: null },
          } } : {}),
        },
      }).where(eq(heartbeatRuns.id, runId));
    }
    expect(await nativeWorkspaceExportPendingForLease(db, source)).toBe(false);
  });

  it.each(["interrupted", "failed", "cancelled", "timed_out", "succeeded"].flatMap(status => [false, true].map(deletedEnvironment => ({ status, deletedEnvironment }))))("reconciles $status local ownership (deleted environment: $deletedEnvironment)", async ({ status, deletedEnvironment }) => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    await db.delete(environments).where(eq(environments.driver, "local"));
    await db.update(environments).set({ driver: "local", config: {} }).where(eq(environments.id, environmentId));
    const runId = await insertHeartbeatRun({ companyId, agentId, status });
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({
      id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      status: "active", leasePolicy: "ephemeral", provider: "local",
      providerLeaseId: null, metadata: { driver: "local" }, updatedAt: oldEnough(),
    });
    if (deletedEnvironment) await db.delete(environments).where(eq(environments.id, environmentId));

    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });

    expect(await leaseRow(leaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect((await leaseRow(leaseId))?.releasedAt).toBeInstanceOf(Date);
  });

  it.each(["failed", "cancelled", "interrupted", "timed_out", "succeeded"])(
    "preserves a reusable sandbox when recovering %s ownership", async (status) => {
      const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
      const runId = await insertHeartbeatRun({ companyId, agentId, status });
      const leaseId = await insertActiveLease({ companyId, environmentId, heartbeatRunId: runId,
        updatedAt: oldEnough(), provider: "fake" });
      const heartbeat = heartbeatService(db);
      expect(await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 })).toEqual({ recovered: 1 });
      const lease = await leaseRow(leaseId);
      expect(lease).toMatchObject({ status: "pending_cleanup", metadata: {
        sandboxStopAndRetain: { companyId, runId, leaseId, builtinProvider: "fake" },
      } });
      expect(await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 })).toEqual({ recovered: 0 });
      expect(await leaseRow(leaseId)).toEqual(lease);
    },
  );

  it("rolls cleanup intent back with the caller transaction", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({ companyId, environmentId, heartbeatRunId: runId,
      updatedAt: oldEnough(), provider: "fake" });
    const before = await leaseRow(leaseId);
    await expect(db.transaction(async tx => {
      await heartbeatService(tx as unknown as Db).sweepOrphanedActiveLeases({ backoffMs: 0 });
      throw new Error("injected rollback");
    })).rejects.toThrow("injected rollback");
    expect(await leaseRow(leaseId)).toEqual(before);
  });

  it("claims reusable orphan cleanup once across concurrent reconcilers", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({ companyId, environmentId, heartbeatRunId: runId,
      updatedAt: oldEnough(), provider: "fake" });
    const results = await Promise.all([heartbeatService(db), heartbeatService(db)].map(
      service => service.sweepOrphanedActiveLeases({ backoffMs: 0 }),
    ));
    expect(results.reduce((sum, result) => sum + result.recovered, 0)).toBe(1);
    expect(await leaseRow(leaseId)).toMatchObject({ status: "pending_cleanup",
      metadata: { sandboxStopAndRetain: { leaseId, runId } } });
  });

  it.each([false, true])("retains stop-only intent after provider failure (deleted environment: %s)", async deleted => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "interrupted" });
    const leaseId = await insertActiveLease({ companyId, environmentId, heartbeatRunId: runId,
      updatedAt: oldEnough(), provider: "fake" });
    if (deleted) await db.delete(environments).where(eq(environments.id, environmentId));
    const retryPendingSandboxTeardown = vi.fn(async () => { throw new Error("provider unavailable"); });
    const destroyRunLease = vi.fn();
    const heartbeat = heartbeatService(db, { environmentRuntime: {
      retryPendingSandboxTeardown, destroyRunLease,
    } as unknown as HeartbeatEnvironmentRuntime });
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    expect(retryPendingSandboxTeardown).toHaveBeenCalledOnce();
    expect(destroyRunLease).not.toHaveBeenCalled();
    expect(await leaseRow(leaseId)).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed",
      metadata: { sandboxStopAndRetain: { leaseId, runId } } });
  });

  it.each([false, true])("settles a stop-only provider receipt without destroying its reusable allocation (deleted environment: %s)", async deleted => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "interrupted" });
    const leaseId = await insertActiveLease({ companyId, environmentId, heartbeatRunId: runId,
      updatedAt: oldEnough(), provider: "fake" });
    if (deleted) await db.delete(environments).where(eq(environments.id, environmentId));
    const retryPendingSandboxTeardown = vi.fn(async ({ lease }: { lease: { providerLeaseId: string } }) => ({
      state: "stopped", providerLeaseId: lease.providerLeaseId,
    }));
    const destroyRunLease = vi.fn();
    const heartbeat = heartbeatService(db, { environmentRuntime: {
      retryPendingSandboxTeardown, destroyRunLease,
    } as unknown as HeartbeatEnvironmentRuntime });
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    expect(retryPendingSandboxTeardown).toHaveBeenCalledOnce();
    expect(destroyRunLease).not.toHaveBeenCalled();
    expect(await leaseRow(leaseId)).toMatchObject({ status: "released", cleanupStatus: "success",
      providerLeaseId: `sandbox://fake/${leaseId}`, metadata: {
        remoteExecutionTermination: { state: "stopped", companyId, runId, leaseId },
        sandboxStopAndRetainReceipt: { companyId, runId, leaseId },
      } });
    const settled = await leaseRow(leaseId);
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    expect(await leaseRow(leaseId)).toEqual(settled);
    expect(retryPendingSandboxTeardown).toHaveBeenCalledOnce();
  });

  it.each(["queued", "scheduled_retry"])("reconciles pre-start cancellation from %s without touching another run", async status => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status });
    const leaseId = await insertActiveLease({ companyId, environmentId, heartbeatRunId: runId,
      updatedAt: oldEnough(), provider: "local" });
    await db.update(environmentLeases).set({ providerLeaseId: null, leasePolicy: "ephemeral", metadata: { driver: "local" } })
      .where(eq(environmentLeases.id, leaseId));
    const otherOwner = await seedCompanyAgentAndEnvironment();
    const otherRunId = await insertHeartbeatRun({ companyId: otherOwner.companyId, agentId: otherOwner.agentId, status: "queued" });
    const otherLeaseId = await insertActiveLease({ companyId: otherOwner.companyId, environmentId: otherOwner.environmentId, heartbeatRunId: otherRunId,
      updatedAt: oldEnough(), provider: "fake" });
    const other = await leaseRow(otherLeaseId);
    const heartbeat = heartbeatService(db);
    await heartbeat.cancelRun(runId, "pre-start cancellation regression");
    expect((await heartbeat.getRun(runId))?.status).toBe("cancelled");
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    expect(await leaseRow(leaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(await leaseRow(otherLeaseId)).toEqual(other);
  });

  it("rechecks a run resumed after candidate discovery", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({ companyId, environmentId, heartbeatRunId: runId,
      updatedAt: oldEnough(), provider: "fake" });
    const transact = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
      return transact(callback, config);
    });
    try {
      expect(await heartbeatService(db).sweepOrphanedActiveLeases({ backoffMs: 0 })).toEqual({ recovered: 0 });
      expect(await leaseRow(leaseId)).toMatchObject({ status: "active", metadata: null });
    } finally { spy.mockRestore(); }
  });

  it("does not use a foreign company's terminal run as cleanup authority", async () => {
    const owner = await seedCompanyAgentAndEnvironment();
    const foreign = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId: foreign.companyId, agentId: foreign.agentId, status: "failed" });
    const leaseId = await insertActiveLease({ companyId: owner.companyId, environmentId: owner.environmentId,
      heartbeatRunId: runId, updatedAt: oldEnough(), provider: "fake" });
    const before = await leaseRow(leaseId);
    expect(await heartbeatService(db).sweepOrphanedActiveLeases({ backoffMs: 0 })).toEqual({ recovered: 0 });
    expect(await leaseRow(leaseId)).toEqual(before);
  });

  it("does not discard an unexpected provider resource from a local lease", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    await db.delete(environments).where(eq(environments.driver, "local"));
    await db.update(environments).set({ driver: "local", config: {} }).where(eq(environments.id, environmentId));
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "interrupted" });
    const leaseId = await insertActiveLease({ companyId, environmentId, heartbeatRunId: runId,
      updatedAt: oldEnough(), provider: "local", providerLeaseId: "unexpected-resource" });
    await db.update(environmentLeases).set({ leasePolicy: "ephemeral", metadata: { driver: "local" } })
      .where(eq(environmentLeases.id, leaseId));

    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });

    expect(await leaseRow(leaseId)).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
  });

  it("test_flips_an_active_lease_when_its_run_is_failed", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 1 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("pending_cleanup");
  });

  it.each(["queued", "running", "scheduled_retry"])("preserves %s ownership", async (status) => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 0 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("active");
  });

  it("test_flips_an_active_lease_when_its_heartbeat_run_id_is_null", async () => {
    const { companyId, environmentId } = await seedCompanyAgentAndEnvironment();
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: oldEnough(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 1 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("pending_cleanup");
  });

  it("test_keeps_an_active_lease_when_its_updated_at_is_inside_the_backoff_window", async () => {
    const { companyId, environmentId } = await seedCompanyAgentAndEnvironment();
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 0 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("active");
  });

  it("test_keeps_a_retained_lease_unchanged", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
      status: "retained",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 0 });
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("retained");
  });

  it("test_skips_a_lease_when_another_live_lease_holds_the_same_provider_lease_id", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const sharedProviderLeaseId = "sandbox://fake/shared-resource";
    const orphanedLeaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
      providerLeaseId: sharedProviderLeaseId,
    });
    // A second lease still owns the same physical sandbox resource.
    await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: new Date(),
      providerLeaseId: sharedProviderLeaseId,
      status: "retained",
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    expect(result).toEqual({ recovered: 0 });
    const row = await leaseRow(orphanedLeaseId);
    expect(row?.status).toBe("active");
  });

  it("test_defers_a_guarded_lease_instead_of_leaving_it_at_the_front_of_the_page", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const sharedProviderLeaseId = "sandbox://fake/shared-resource";
    const orphanedLeaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
      providerLeaseId: sharedProviderLeaseId,
    });
    await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: new Date(),
      providerLeaseId: sharedProviderLeaseId,
      status: "retained",
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    const row = await leaseRow(orphanedLeaseId);
    expect(row?.status).toBe("active");
    // The guard moved the row's `updatedAt` forward, so a fresh backoff
    // cutoff no longer selects it. The exact value is not the point; only
    // that it moved out of the stale range the sweep reads by.
    expect(row!.updatedAt.getTime()).toBeGreaterThan(oldEnough().getTime());
  });

  it("test_a_full_page_of_guarded_leases_does_not_starve_a_later_eligible_orphan", async () => {
    const { companyId, environmentId } = await seedCompanyAgentAndEnvironment();
    const veryOld = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const staleButNewer = new Date(Date.now() - 60 * 60 * 1000);

    // Fill one full sweep page (ORPHANED_ACTIVE_LEASE_SWEEP_PAGE_SIZE = 20)
    // with orphan candidates that are each guarded by a live second owner of
    // the same provider resource. Every guarded row is older than the
    // eligible orphan below, so an unbounded query would return them first
    // on every tick.
    for (let i = 0; i < 20; i += 1) {
      const providerLeaseId = `sandbox://fake/guarded-${i}`;
      await insertActiveLease({
        companyId,
        environmentId,
        heartbeatRunId: null,
        updatedAt: veryOld,
        providerLeaseId,
      });
      await insertActiveLease({
        companyId,
        environmentId,
        heartbeatRunId: null,
        updatedAt: new Date(),
        providerLeaseId,
        status: "retained",
      });
    }

    // This orphan has no other owner, so it is eligible for cleanup. It
    // sorts behind the 20 guarded rows because it is newer than them, so
    // the first sweep page does not reach it.
    const eligibleLeaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: staleButNewer,
    });

    const heartbeat = heartbeatService(db);

    const firstTick = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });
    expect(firstTick).toEqual({ recovered: 0 });
    const eligibleAfterFirstTick = await leaseRow(eligibleLeaseId);
    expect(eligibleAfterFirstTick?.status).toBe("active");

    // The guarded rows moved out of the stale page on the first tick, so
    // the second tick reaches the eligible orphan behind them.
    const secondTick = await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });
    expect(secondTick).toEqual({ recovered: 1 });
    const eligibleAfterSecondTick = await leaseRow(eligibleLeaseId);
    expect(eligibleAfterSecondTick?.status).toBe("pending_cleanup");
  });

  it("test_writes_a_failure_reason_on_each_flipped_lease", async () => {
    const { companyId, environmentId } = await seedCompanyAgentAndEnvironment();
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: null,
      updatedAt: oldEnough(),
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 5 * 60 * 1000 });

    const row = await leaseRow(leaseId);
    expect(row?.failureReason).toBeTruthy();
  });

  it("test_stops_the_recovered_sandbox_on_the_same_reaper_tick", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
    });

    await db.update(environmentLeases).set({ leasePolicy: "ephemeral" }).where(eq(environmentLeases.id, leaseId));

    const retryPendingSandboxTeardown = vi.fn(async () => undefined);
    const heartbeat = heartbeatService(db, {
      environmentRuntime: {
        retryPendingSandboxTeardown,
      } as unknown as HeartbeatEnvironmentRuntime,
    });

    // The periodic timer call uses a five-minute staleness threshold. The
    // lease is older than that window, so the recovery flip and the
    // pending_cleanup teardown both run in this one call.
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });

    expect(retryPendingSandboxTeardown).toHaveBeenCalledTimes(1);
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("expired");
  });

  it("test_stops_the_recovered_sandbox_on_the_startup_call", async () => {
    const { companyId, agentId, environmentId } = await seedCompanyAgentAndEnvironment();
    const runId = await insertHeartbeatRun({ companyId, agentId, status: "failed" });
    const leaseId = await insertActiveLease({
      companyId,
      environmentId,
      heartbeatRunId: runId,
      updatedAt: oldEnough(),
    });

    await db.update(environmentLeases).set({ leasePolicy: "ephemeral" }).where(eq(environmentLeases.id, leaseId));

    const retryPendingSandboxTeardown = vi.fn(async () => undefined);
    const heartbeat = heartbeatService(db, {
      environmentRuntime: {
        retryPendingSandboxTeardown,
      } as unknown as HeartbeatEnvironmentRuntime,
    });

    // The startup call uses a zero staleness threshold, so the new sweep and
    // the existing pending_cleanup sweep both act without a backoff delay,
    // and the recovered lease reaches the provider teardown in this one call.
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });

    expect(retryPendingSandboxTeardown).toHaveBeenCalledTimes(1);
    const row = await leaseRow(leaseId);
    expect(row?.status).toBe("expired");
  });

  it("test_logs_a_distinct_error_kind_and_no_exception_field_when_the_sweep_fails", async () => {
    const sentinel = "Bearer sk-SENTINEL-a1b2c3";
    const realSelect = db.select.bind(db);
    const selectSpy = vi
      .spyOn(db, "select")
      .mockImplementation((...args: Parameters<typeof db.select>) => {
        const builder = realSelect(...args);
        const realFrom = builder.from.bind(builder);
        (builder as { from: unknown }).from = (table: unknown) => {
          if (table === environmentLeases) {
            const failure = new Error(`sweep query failed: ${sentinel}`);
            failure.name = `SweepQueryError ${sentinel}`;
            (failure as { code?: string }).code = `ESWEEP ${sentinel}`;
            throw failure;
          }
          return realFrom(table as Parameters<typeof realFrom>[0]);
        };
        return builder;
      });

    try {
      const heartbeat = heartbeatService(db, {
        environmentRuntime: {
          destroyRunLease: vi.fn(async () => null),
        } as unknown as HeartbeatEnvironmentRuntime,
      });

      // The reaper isolates the sweep, so the reaper itself still resolves.
      await expect(heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })).resolves.toBeDefined();

      const sweepCall = vi
        .mocked(logger.error)
        .mock.calls.find((call) => call[1] === "orphaned active environment lease sweep failed");
      expect(sweepCall).toBeDefined();
      const record = sweepCall?.[0] as Record<string, unknown>;

      expect(JSON.stringify(record)).not.toContain(sentinel);
      expect(record).not.toHaveProperty("err");
      expect(record).not.toHaveProperty("errorName");
      expect(record).not.toHaveProperty("errorCode");
      expect(record).not.toHaveProperty("message");
      expect(record).not.toHaveProperty("stack");
      expect(record).toMatchObject({ errorKind: "orphaned_active_lease_sweep_failed" });
    } finally {
      selectSpy.mockRestore();
    }
  });
});
