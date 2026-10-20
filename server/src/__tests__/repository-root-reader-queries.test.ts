import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, environmentLeases, executionWorkspaceRepositoryAccess,
  executionWorkspaces, heartbeatRuns, issues, projects, projectAccessMembers, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { loadRepositoryRootReaders } from "../services/execution-workspace-root-readers.js";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { deleteAgentDependencies } from "../services/agent-deletion.js";
import { issueService } from "../services/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { hasPendingRunCleanup } from "../services/execution-blocker.js";
import { mergeCoalescedContextSnapshot } from "../services/heartbeat/run-preparation.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let cwd: string;
const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), issueId = randomUUID(), projectId = randomUUID();
const runIds = Array.from({ length: 64 }, () => randomUUID());
let workspaceId: string;

beforeAll(async () => {
  vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
  database = await startEmbeddedPostgresTestDatabase("root-reader-query-");
  db = createDb(database.connectionString);
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "root-reader-query-")));
  await db.insert(companies).values({ id: companyId, name: "Retained readers", issuePrefix: "RRQ" });
  await db.insert(authUsers).values({ id: userId, name: "Sponsor", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process" });
  await db.insert(companyMemberships).values([
    { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
    { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
  ]);
  await db.insert(projects).values({ id: projectId, companyId, name: "Source" });
  const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId, cwd, name: "Task source", mode: "shared_workspace", strategyType: "operator_directory" }).returning();
  workspaceId = workspace.id;
  await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Task", assigneeAgentId: agentId, executionWorkspaceId: workspaceId });
  await db.insert(heartbeatRuns).values(runIds.map(id => ({ id, companyId, agentId, responsibleUserId: userId,
    status: "succeeded", contextSnapshot: { issueId }, resultJson: { unusedPayload: "x".repeat(65536) } })));
  const rootKey = createHash("sha256").update(cwd).digest("hex");
  await db.insert(executionWorkspaceRepositoryAccess).values(runIds.map(scopeId => ({ companyId, rootKey,
    canonicalCwd: cwd, kind: "reader", scopeId, issueId, agentId, responsibleUserId: userId })));
}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.$client.end({ timeout: 0 });
  await database?.cleanup();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const input = () => ({ companyId, issueId, workspaceId, cwd, agentId, runId: runIds[0] });

it("bounds repeated-principal queries without loading retained run payloads", async () => {
  const queries: string[] = [];
  const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: query => queries.push(query) } }) as unknown as typeof db;
  await executionWorkspaceRepositoryService(recorded).guardForPublication(input());
  expect(queries.length).toBeLessThan(100);
  const runs = queries.filter(query => query.includes('from "heartbeat_runs"'));
  expect(runs.length).toBeGreaterThan(0);
  expect(runs.length).toBeLessThan(10);
  expect(runs.every(query => !query.includes('"result_json"') && !query.includes('"runner_profile_json"'))).toBe(true);
});

it("rejects foreign-company and mismatched retained run identities", async () => {
  const invalidId = runIds[31];
  const otherCompanyId = randomUUID(), otherIssueId = randomUUID();
  await db.insert(companies).values({ id: otherCompanyId, name: "Foreign readers", issuePrefix: "FRQ" });
  await db.insert(issues).values({ id: otherIssueId, companyId, projectId, title: "Other task", assigneeAgentId: agentId });
  const service = executionWorkspaceRepositoryService(db);
  for (const change of [
    { companyId: otherCompanyId },
    { responsibleUserId: randomUUID() },
  ]) {
    try {
      await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, invalidId));
      await expect(service.guardForPublication(input())).rejects.toThrow("identity");
    } finally {
      await db.update(heartbeatRuns).set({ companyId, nativeIssueId: null, contextSnapshot: { issueId }, responsibleUserId: userId })
        .where(eq(heartbeatRuns.id, invalidId));
    }
  }
  for (const change of [{ agentId: randomUUID() }, { issueId: randomUUID() }, { agentId: null }, { issueId: null }, { issueId: otherIssueId }]) {
    try {
      await db.update(executionWorkspaceRepositoryAccess).set(change).where(eq(executionWorkspaceRepositoryAccess.scopeId, invalidId));
      await expect(service.guardForPublication(input())).rejects.toThrow("identity");
    } finally {
      await db.update(executionWorkspaceRepositoryAccess).set({ scopeId: invalidId, agentId, issueId })
        .where(eq(executionWorkspaceRepositoryAccess.scopeId, invalidId));
    }
  }
  await db.delete(issues).where(eq(issues.id, otherIssueId));
  await expect(service.guardForPublication(input())).resolves.toBeUndefined();
});

it("keeps a nested retained reader valid after another task's wake coalesces into its run", async () => {
  const runId = randomUUID(), otherRunId = randomUUID(), otherIssueId = randomUUID();
  const nested = path.join(cwd, ".paperclip", "worktrees", "earlier-task");
  await fs.mkdir(nested, { recursive: true });
  const admitted = { issueId, taskId: issueId, taskKey: issueId, wakeReason: "issue_assigned" };
  const coalesced = mergeCoalescedContextSnapshot(admitted, { issueId: otherIssueId, taskId: otherIssueId,
    taskKey: otherIssueId, wakeReason: "issue_monitor_due", source: "issue.monitor" });
  expect(coalesced.issueId).toBe(otherIssueId);
  await db.insert(issues).values({ id: otherIssueId, companyId, projectId, title: "Monitored task", assigneeAgentId: agentId });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: userId, issueId,
    status: "succeeded", contextSnapshot: admitted });
  await db.insert(executionWorkspaceRepositoryAccess).values({ companyId, rootKey: createHash("sha256").update(nested).digest("hex"),
    canonicalCwd: nested, kind: "reader", scopeId: runId, issueId, agentId, responsibleUserId: userId });
  const service = executionWorkspaceRepositoryService(db);
  try {
    await expect(service.guardForPublication(input())).resolves.toBeUndefined();
    await db.update(heartbeatRuns).set({ contextSnapshot: coalesced }).where(eq(heartbeatRuns.id, runId));
    await expect(service.guardForPublication(input())).resolves.toBeUndefined();
    // A reader whose task matches neither the run's binding nor its context stays unavailable.
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId, agentId, responsibleUserId: userId,
      status: "succeeded", contextSnapshot: { issueId: otherIssueId } });
    await db.update(executionWorkspaceRepositoryAccess).set({ scopeId: otherRunId }).where(eq(executionWorkspaceRepositoryAccess.scopeId, runId));
    await expect(service.guardForPublication(input())).rejects.toThrow("identity");
  } finally {
    await db.delete(executionWorkspaceRepositoryAccess).where(inArray(executionWorkspaceRepositoryAccess.scopeId, [runId, otherRunId]));
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, [runId, otherRunId]));
    await db.delete(issues).where(eq(issues.id, otherIssueId));
    await rm(path.join(cwd, ".paperclip"), { recursive: true, force: true });
  }
  await expect(service.guardForPublication(input())).resolves.toBeUndefined();
});


async function seedRetainedReader() {
  const retainedAgentId = randomUUID(), retainedIssueId = randomUUID(), retainedRunId = randomUUID();
  await db.insert(agents).values({ id: retainedAgentId, companyId, name: "Past reader", adapterType: "process" });
  await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: retainedAgentId,
    membershipRole: "member", status: "active" });
  await db.insert(issues).values({ id: retainedIssueId, companyId, projectId, title: "Past task" });
  await db.insert(heartbeatRuns).values({ id: retainedRunId, companyId, agentId: retainedAgentId,
    responsibleUserId: userId, issueId: retainedIssueId, status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: retainedIssueId } });
  await db.insert(executionWorkspaceRepositoryAccess).values({ companyId,
    rootKey: createHash("sha256").update(cwd).digest("hex"), canonicalCwd: cwd, kind: "reader",
    scopeId: retainedRunId, issueId: retainedIssueId, agentId: retainedAgentId, responsibleUserId: userId });
  return { retainedAgentId, retainedIssueId, retainedRunId };
}

it("keeps a deleted task's running reader fenced out of later private publication", async () => {
  const { retainedAgentId, retainedIssueId, retainedRunId } = await seedRetainedReader();
  const service = executionWorkspaceRepositoryService(db);
  await expect(service.guardForPublication(input())).resolves.toBeUndefined();
  const reader = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    process.on("message", file => process.send(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null));
    process.on("disconnect", () => process.exit(0));
    process.send("ready");
  `], { cwd, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const file = path.join(cwd, "private.txt");
  let grants: typeof projectAccessMembers.$inferSelect[] = [];
  try {
    expect((await once(reader, "message"))[0]).toBe("ready");
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, retainedAgentId));
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, processPid: reader.pid,
      processLossRetryCount: 1, executionStage: "dispatching", controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(heartbeatRuns.id, retainedRunId));
    expect(await issueService(db).remove(retainedIssueId)).not.toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retainedRunId));
    expect(run.status).toBe("running");
    expect(run.issueId).toBeNull();
    expect(run.contextSnapshot?.issueId).toBe(retainedIssueId);
    expect(() => process.kill(reader.pid!, 0)).not.toThrow();
    const heartbeat = heartbeatService(db);
    expect((await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })).reaped).toBe(0);
    await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, projectId));
    grants = await db.insert(projectAccessMembers).values([
      { companyId, projectId, subjectType: "agent", subjectId: agentId },
      { companyId, projectId, subjectType: "user", subjectId: userId },
    ]).returning();
    const publication = await (async () => {
      await service.guardForPublication(input());
      await fs.writeFile(file, "Private project source\n");
    })().then(() => null, error => error);
    const observed = once(reader, "message");
    reader.send(file);
    const [privateContent] = await observed;
    expect({ denied: publication?.status, privateContent }).toEqual({ denied: 403, privateContent: null });
    const exited = once(reader, "exit");
    reader.kill();
    await exited;
    expect((await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 })).runIds).toContain(retainedRunId);
    const [recovered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retainedRunId));
    expect(recovered.status).toBe("failed");
    expect(recovered.controllerLeaseExpiresAt).toBeNull();
    await expect(service.guardForPublication(input())).resolves.toBeUndefined();
  } finally {
    if (reader.exitCode === null && reader.signalCode === null) {
      const exited = once(reader, "exit");
      reader.kill();
      await exited;
    }
    await fs.rm(file, { force: true });
    await db.delete(projectAccessMembers).where(inArray(projectAccessMembers.id, grants.map(grant => grant.id)));
    await db.update(projects).set({ visibility: "open" }).where(eq(projects.id, projectId));
    await db.delete(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.scopeId, retainedRunId));
    await deleteAgentDependencies(db, companyId, retainedAgentId);
    await db.delete(issues).where(eq(issues.id, retainedIssueId));
    await db.delete(agents).where(eq(agents.id, retainedAgentId));
  }
});

it.each(["running", "queued", "unknown", "unfinished", "controller", "expired controller", "active", "pending_cleanup", "retained"])(
  "keeps a deleted task reader fenced while execution is %s", async state => {
    const { retainedAgentId, retainedIssueId, retainedRunId } = await seedRetainedReader();
    try {
      if (["running", "queued", "unknown"].includes(state)) {
        await db.update(heartbeatRuns).set({ status: state }).where(eq(heartbeatRuns.id, retainedRunId));
      } else if (state === "unfinished") {
        await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, retainedRunId));
      } else if (state.includes("controller")) {
        await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + (state === "controller" ? 60_000 : -60_000)) })
          .where(eq(heartbeatRuns.id, retainedRunId));
      } else {
        await db.insert(environmentLeases).values({ companyId, heartbeatRunId: retainedRunId, status: state,
          leasePolicy: "reuse_by_environment", cleanupStatus: state === "retained" ? "success" : null });
      }
      await db.delete(issues).where(eq(issues.id, retainedIssueId));
      await expect(executionWorkspaceRepositoryService(db).guardForPublication(input())).rejects.toThrow("execution has not settled");
    } finally {
      await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, retainedRunId));
      await db.delete(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.scopeId, retainedRunId));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, retainedRunId));
      await db.delete(issues).where(eq(issues.id, retainedIssueId));
      await db.delete(agents).where(eq(agents.id, retainedAgentId));
    }
  },
);

it("bounds cleanup queries after more than one batch of retained tasks is deleted", async () => {
  const ids = Array.from({ length: 501 }, () => ({ runId: randomUUID(), taskId: randomUUID() }));
  await db.insert(issues).values(ids.map(({ taskId }) => ({ id: taskId, companyId, projectId, title: "Deleted reader task" })));
  await db.insert(heartbeatRuns).values(ids.map(({ runId, taskId }) => ({ id: runId, companyId, agentId,
    issueId: taskId, status: "succeeded", finishedAt: new Date(), responsibleUserId: userId, contextSnapshot: { issueId: taskId } })));
  await db.insert(executionWorkspaceRepositoryAccess).values(ids.map(({ runId, taskId }) => ({ companyId,
    rootKey: createHash("sha256").update(cwd).digest("hex"), canonicalCwd: cwd, kind: "reader",
    scopeId: runId, issueId: taskId, agentId, responsibleUserId: userId })));
  try {
    await db.delete(issues).where(inArray(issues.id, ids.map(id => id.taskId)));
    const queries: string[] = [];
    const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: query => queries.push(query) } }) as unknown as typeof db;
    await expect(executionWorkspaceRepositoryService(recorded).guardForPublication(input())).resolves.toBeUndefined();
    expect(queries.length).toBeLessThan(100);
    expect(await hasPendingRunCleanup(db, companyId, ids[0].runId.toUpperCase())).toBe(false);
    expect(await hasPendingRunCleanup(db, companyId, randomUUID())).toBe(true);
  } finally {
    await db.delete(executionWorkspaceRepositoryAccess).where(inArray(executionWorkspaceRepositoryAccess.scopeId, ids.map(id => id.runId)));
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, ids.map(id => id.runId)));
    await db.delete(issues).where(inArray(issues.id, ids.map(id => id.taskId)));
  }
});

it.each(["run", "agent", "issue snapshot", "issue FK"])("admits a new reader after deleting a retained %s", async deletion => {
  const { retainedAgentId, retainedIssueId, retainedRunId } = await seedRetainedReader();
  try {
    if (deletion === "agent") {
      await db.transaction(async tx => {
        await deleteAgentDependencies(tx as typeof db, companyId, retainedAgentId);
        await tx.delete(agents).where(eq(agents.id, retainedAgentId));
      });
    } else if (deletion === "run") {
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, retainedRunId));
    } else {
      if (deletion === "issue FK") {
        await db.update(heartbeatRuns).set({ contextSnapshot: null }).where(eq(heartbeatRuns.id, retainedRunId));
      }
      await db.delete(issues).where(eq(issues.id, retainedIssueId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retainedRunId));
      expect(run.issueId).toBeNull();
      expect(run.contextSnapshot?.issueId).toBe(deletion === "issue snapshot" ? retainedIssueId : undefined);
    }
    const entries = await db.select().from(executionWorkspaceRepositoryAccess)
      .where(eq(executionWorkspaceRepositoryAccess.scopeId, retainedRunId));
    expect(entries).toHaveLength(1);
    await expect(executionWorkspaceRepositoryService(db).guardForPublication(input())).resolves.toBeUndefined();
    await expect(loadRepositoryRootReaders(db, companyId, entries, retainedRunId)).rejects.toThrow("identity");
  } finally {
    await db.delete(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.scopeId, retainedRunId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, retainedRunId));
    await db.delete(issues).where(eq(issues.id, retainedIssueId));
    await db.delete(agents).where(eq(agents.id, retainedAgentId));
  }
});

it("rejects foreign-company identities even when another retained identity was deleted", async () => {
  const { retainedAgentId, retainedIssueId, retainedRunId } = await seedRetainedReader();
  const otherCompanyId = randomUUID();
  await db.insert(companies).values({ id: otherCompanyId, name: "Foreign orphan", issuePrefix: "FOR" });
  try {
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, retainedRunId));
    for (const table of [agents, issues]) {
      const idColumn = table.id;
      const id = table === agents ? retainedAgentId : retainedIssueId;
      await db.update(table).set({ companyId: otherCompanyId }).where(eq(idColumn, id));
      try {
        await expect(executionWorkspaceRepositoryService(db).guardForPublication(input())).rejects.toThrow("identity");
      } finally {
        await db.update(table).set({ companyId }).where(eq(idColumn, id));
      }
    }
    await db.delete(issues).where(eq(issues.id, retainedIssueId));
    await db.insert(heartbeatRuns).values({ id: retainedRunId, companyId: otherCompanyId, agentId: retainedAgentId,
      responsibleUserId: userId, status: "succeeded", contextSnapshot: { issueId: retainedIssueId } });
    await expect(executionWorkspaceRepositoryService(db).guardForPublication(input())).rejects.toThrow("identity");
    await db.update(heartbeatRuns).set({ companyId, contextSnapshot: { issueId } }).where(eq(heartbeatRuns.id, retainedRunId));
    await expect(executionWorkspaceRepositoryService(db).guardForPublication(input())).rejects.toThrow("identity");
  } finally {
    await db.delete(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.scopeId, retainedRunId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, retainedRunId));
    await db.delete(issues).where(eq(issues.id, retainedIssueId));
    await db.delete(agents).where(eq(agents.id, retainedAgentId));
  }
});

it("keeps each retained run identity and policy distinct for the same principals", async () => {
  const service = executionWorkspaceRepositoryService(db);
  const invalidId = runIds[31];
  try {
    await db.update(executionWorkspaceRepositoryAccess).set({ responsibleUserId: randomUUID() }).where(eq(executionWorkspaceRepositoryAccess.scopeId, invalidId));
    await expect(service.guardForPublication(input())).rejects.toThrow("identity");
    await db.update(executionWorkspaceRepositoryAccess).set({ responsibleUserId: userId }).where(eq(executionWorkspaceRepositoryAccess.scopeId, invalidId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, executionPolicy: { trustPreset: "unsupported" } } }).where(eq(heartbeatRuns.id, invalidId));
    await expect(service.guardForPublication(input())).rejects.toThrow();
  } finally {
    await db.update(executionWorkspaceRepositoryAccess).set({ responsibleUserId: userId }).where(eq(executionWorkspaceRepositoryAccess.scopeId, invalidId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId } }).where(eq(heartbeatRuns.id, invalidId));
  }
  await expect(service.guardForPublication(input())).resolves.toBeUndefined();
});

it("checks identities after the first query batch and reloads them on the next operation", async () => {
  const ids = Array.from({ length: 501 }, () => randomUUID());
  await db.insert(heartbeatRuns).values(ids.map(id => ({ id, companyId, agentId, responsibleUserId: userId,
    status: "succeeded", contextSnapshot: { taskId: issueId } })));
  const entries = ids.map(scopeId => ({ scopeId, issueId, agentId, responsibleUserId: userId }));
  try {
    const queries: string[] = [];
    const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: query => queries.push(query) } }) as unknown as typeof db;
    const readers = await loadRepositoryRootReaders(recorded, companyId, entries);
    expect(readers.map(reader => reader.actor.runId)).toEqual(ids);
    expect(readers.every(reader => reader.issue.id === issueId && reader.actor.onBehalfOfUserId === userId)).toBe(true);
    const agentQueries = queries.filter(query => query.includes('from "agents"'));
    expect(agentQueries).toHaveLength(1);
    expect(agentQueries.every(query =>
      !query.includes('"adapter_config"') && !query.includes('"runtime_config"') && !query.includes('"metadata"'))).toBe(true);
    await db.update(heartbeatRuns).set({ responsibleUserId: randomUUID() }).where(eq(heartbeatRuns.id, ids.at(-1)!));
    await expect(loadRepositoryRootReaders(db, companyId, entries)).rejects.toThrow("identity");
  } finally {
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, ids));
  }
});

it("preserves each actor's saved policy in batched read decisions", async () => {
  const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId, agentId,
    runId: runIds[0], onBehalfOfUserId: userId };
  const policyRunId = runIds[31];
  const actors = [actor, { ...actor, runId: policyRunId }, { ...actor, runId: runIds[0].toUpperCase() },
    { ...actor, runId: randomUUID() }];
  const resources = [{ type: "project" as const, companyId, projectId }, { type: "company" as const, companyId }];
  const service = authorizationService(db);
  try {
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, executionPolicy: { trustPreset: "unsupported" } } })
      .where(eq(heartbeatRuns.id, policyRunId));
    const decisions = await service.decideReadsForActors(actors, resources);
    for (const [index, candidate] of actors.entries()) {
      for (const [resourceIndex, resource] of resources.entries()) {
        expect(decisions[index][resourceIndex]).toEqual(await service.decide({ actor: { ...candidate }, resource,
          action: resource.type === "project" ? "project:read" : "company_scope:read" }));
      }
    }
    expect(decisions[0][0].allowed).toBe(true);
    expect(decisions[1][0].allowed).toBe(false);
  } finally {
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId } }).where(eq(heartbeatRuns.id, policyRunId));
  }
  expect((await service.decideReadsForActors(actors, resources))[1][0].allowed).toBe(true);
});

it("reloads project grants on every publication attempt", async () => {
  const service = executionWorkspaceRepositoryService(db);
  await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, projectId));
  const grants = await db.insert(projectAccessMembers).values([
    { companyId, projectId, subjectType: "agent", subjectId: agentId },
    { companyId, projectId, subjectType: "user", subjectId: userId },
  ]).returning();
  try {
    await expect(service.guardForPublication(input())).resolves.toBeUndefined();
    await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, projectId), eq(projectAccessMembers.subjectType, "user")));
    await expect(service.guardForPublication(input())).rejects.toThrow();
  } finally {
    await db.delete(projectAccessMembers).where(inArray(projectAccessMembers.id, grants.map(grant => grant.id)));
    await db.update(projects).set({ visibility: "open" }).where(eq(projects.id, projectId));
  }
});

it("keeps supplied membership snapshots separate from fresh database snapshots", async () => {
  const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId, agentId,
    runId: runIds[0], onBehalfOfUserId: userId };
  const supplied = { ...actor, onBehalfOfMemberships: [{ companyId, membershipRole: "operator", status: "active" }] };
  const service = authorizationService(db);
  const resource = { type: "company" as const, companyId };
  await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
  try {
    for (const candidates of [[supplied, actor], [actor, supplied]]) {
      const decisions = await service.decideReadsForActors(candidates, [resource]);
      for (let index = 0; index < candidates.length; index++) {
        expect(decisions[index][0]).toEqual(await service.decide({ actor: { ...candidates[index] }, action: "company_scope:read", resource }));
        expect(decisions[index][0].code).toBe(candidates[index] === supplied
          ? "RESPONSIBLE_USER_UNAUTHORIZED" : "RESPONSIBLE_USER_UNAVAILABLE");
      }
    }
  } finally {
    await db.update(companyMemberships).set({ status: "active" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
  }
});

it("batches source retention and duplicate path reads without losing owners", async () => {
  const sourceIds = Array.from({ length: 501 }, () => randomUUID());
  await db.insert(executionWorkspaces).values(sourceIds.map(id => ({ id, companyId, projectId, cwd,
    sourceIssueId: issueId, name: "Shared source", mode: "shared_workspace", strategyType: "operator_directory" })));
  const queries: string[] = [];
  const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: query => queries.push(query) } }) as unknown as typeof db;
  const paths = vi.spyOn(fs, "realpath");
  try {
    await executionWorkspaceRepositoryService(recorded).guardForPublication(input());
    expect(queries.filter(query => query.startsWith('insert into "execution_workspace_repository_access"')).length).toBeLessThanOrEqual(2);
    expect(paths.mock.calls.length).toBeLessThanOrEqual(8);
  } finally {
    paths.mockRestore();
  }
  const retained = await db.select({ scopeId: executionWorkspaceRepositoryAccess.scopeId }).from(executionWorkspaceRepositoryAccess)
    .where(and(eq(executionWorkspaceRepositoryAccess.companyId, companyId),
      eq(executionWorkspaceRepositoryAccess.rootKey, createHash("sha256").update(cwd).digest("hex")),
      eq(executionWorkspaceRepositoryAccess.kind, "source")));
  expect(new Set(retained.map(row => row.scopeId))).toEqual(new Set([workspaceId, ...sourceIds]));
});
