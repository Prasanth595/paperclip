import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, authUsers, caseEvents, caseHandoffs, cases, companies, companyMemberships,
  createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { isCaseHandoffSourceReleased } from "../services/heartbeat/case-handoff-lifecycle.js";

describe("durable case handoff queue admission", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const heldRuns = new Set<string>();
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("case-handoff-queue-"); db = createDb(temporary.connectionString); });
  afterAll(async () => { for (const id of heldRuns) runningProcesses.delete(id); await temporary?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), caseId = randomUUID(), handoffId = randomUUID(),
      userId = randomUUID(), wakeupRequestId = randomUUID(), occupyingRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Factory", issuePrefix: `Q${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", role: "ceo", status: "running", adapterType: "process",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } } });
    // Hold the recipient's ordinary concurrency slot so admission remains
    // observable without a provider mock or racing background execution.
    await db.insert(heartbeatRuns).values({ id: occupyingRunId, companyId, agentId, status: "running", responsibleUserId: userId,
      contextSnapshot: { issueId: randomUUID() }, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    runningProcesses.set(occupyingRunId, { child: {} as never, graceSec: 0, processGroupId: null }); heldRuns.add(occupyingRunId);
    await db.insert(issues).values({ id: issueId, companyId, title: "Build", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId });
    await db.insert(cases).values({ id: caseId, companyId, caseNumber: 1, identifier: `CASE-${caseId}`, caseType: "work", title: "Build",
      workIssueId: issueId, handoffVersion: 1, phase: "implementation" });
    await db.insert(caseHandoffs).values({ id: handoffId, companyId, caseId, issueId, version: 1, toAgentId: agentId, phase: "implementation",
      instructions: "Build the requested change", actorType: "user", actorId: userId, responsibleUserId: userId,
      expectedIssueStatusVersion: 0, appliedIssueStatusVersion: 0, wakeupRequestId, idempotencyKey: "start", inputFingerprint: "fixture", state: "pending_dispatch" });
    const options = { source: "assignment" as const, triggerDetail: "system" as const, reason: "case_handoff", requestedByActorType: "user" as const,
      requestedByActorId: userId, payload: { issueId, handoffId }, contextSnapshot: { issueId, taskKey: issueId, responsibleUserId: userId },
      durableCaseHandoffRequest: { handoffId, wakeupRequestId, issueId, expectedIssueStatusVersion: 0 } };
    return { companyId, agentId, issueId, caseId, handoffId, userId, wakeupRequestId, occupyingRunId, options };
  }
  it("blocks generic wakes and admits one exact receipt across separate scheduler instances", async () => {
    const f = await fixture();
    expect(await heartbeatService(db).wakeup(f.agentId, { source: "assignment", reason: "issue_assigned", payload: { issueId: f.issueId } })).toBeNull();
    const first = await heartbeatService(db).wakeup(f.agentId, f.options);
    expect(first).toMatchObject({ status: "queued", wakeupRequestId: f.wakeupRequestId });
    const second = await heartbeatService(db).wakeup(f.agentId, f.options);
    expect(second?.id).toBe(first?.id);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.wakeupRequestId, f.wakeupRequestId)))).toHaveLength(1);
  });
  it("does not spend the durable receipt on a paused recipient and retries the same identity", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    expect(await heartbeatService(db).wakeup(f.agentId, f.options)).toBeNull();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(0);
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.agentId));
    expect(await heartbeatService(db).wakeup(f.agentId, f.options)).toMatchObject({ wakeupRequestId: f.wakeupRequestId });
  });
  it("rejects an invented handoff version before creating a wake", async () => {
    const f = await fixture();
    await expect(heartbeatService(db).wakeup(f.agentId, { ...f.options,
      durableCaseHandoffRequest: { ...f.options.durableCaseHandoffRequest, expectedIssueStatusVersion: 42 } })).rejects.toThrow("assignment");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId))).toHaveLength(0);
  });
  it("admits an authenticated new phase after two case-only runs without treating its agent comment as an idle re-wake", async () => {
    const f = await fixture();
    for (const age of [20_000, 10_000]) await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", startedAt: new Date(Date.now() - age - 5_000), finishedAt: new Date(Date.now() - age),
      responsibleUserId: f.userId, contextSnapshot: { issueId: f.issueId } });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorAgentId: f.agentId, body: "Proceed to the next explicitly requested case phase" }).returning();
    await db.update(caseHandoffs).set({ actorType: "agent", actorId: f.agentId, fromAgentId: f.agentId, commentId: comment.id })
      .where(eq(caseHandoffs.id, f.handoffId));
    const run = await heartbeatService(db).wakeup(f.agentId, { ...f.options, requestedByActorType: "agent", requestedByActorId: f.agentId,
      payload: { ...f.options.payload, commentId: comment.id }, contextSnapshot: { ...f.options.contextSnapshot, wakeCommentId: comment.id } });
    expect(run).toMatchObject({ status: "queued", wakeupRequestId: f.wakeupRequestId });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeupRequestId)))[0])
      .toMatchObject({ reason: "case_handoff", status: "queued" });
  });
  it("holds an accepted queued receipt while Cases is disabled, then cancels it if the ledger was cancelled", async () => {
    const f = await fixture(), heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(f.agentId, f.options);
    expect(queued?.status).toBe("queued");
    runningProcesses.delete(f.occupyingRunId); heldRuns.delete(f.occupyingRunId);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.occupyingRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await instanceSettingsService(db).updateExperimental({ enableCases: false });
    await heartbeat.resumeQueuedRuns();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)))[0]).toMatchObject({ status: "queued", startedAt: null });
    await db.update(caseHandoffs).set({ state: "cancelled", cancelledAt: new Date() }).where(eq(caseHandoffs.id, f.handoffId));
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    await heartbeatService(db).resumeQueuedRuns();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)))[0]).toMatchObject({ status: "cancelled", startedAt: null,
      errorCode: "case_handoff_superseded" });
  });
  it("an explicit Stop after source termination cancels the pending successor and records history", async () => {
    const f = await fixture(), sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId } });
    await db.update(caseHandoffs).set({ sourceRunId, state: "awaiting_release" }).where(eq(caseHandoffs.id, f.handoffId));
    await heartbeatService(db).cancelRun(sourceRunId, "Cancelled by a board operator", { resultJson: { cancelledByActorType: "user", cancelledByUserId: f.userId } });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0]?.state).toBe("cancelled");
    expect(await db.select().from(caseEvents).where(and(eq(caseEvents.caseId, f.caseId), eq(caseEvents.kind, "handoff_cancelled")))).toHaveLength(1);
  });
  it("releases a paused source that was queued but never acquired execution", async () => {
    const f = await fixture(), sourceRunId = randomUUID();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.agentId,
      status: "queued", contextSnapshot: { issueId: f.issueId }, responsibleUserId: f.userId });
    await db.update(issues).set({ executionRunId: sourceRunId }).where(eq(issues.id, f.issueId));
    await db.update(caseHandoffs).set({ sourceRunId, state: "awaiting_release", createdAt: new Date(Date.now() - 31_000),
      nextAttemptAt: new Date(Date.now() + 60_000) }).where(eq(caseHandoffs.id, f.handoffId));
    await heartbeatService(db).requestCaseHandoffYield({ runId: sourceRunId, issueId: f.issueId, handoffId: f.handoffId });
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId));
    expect(source).toMatchObject({ status: "cancelled", startedAt: null, runtimeModeResolvedAt: null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        caseHandoffExecutionReleased: { runId: sourceRunId, issueId: f.issueId } } });
    expect(await isCaseHandoffSourceReleased(db, { runId: sourceRunId, issueId: f.issueId })).toBe(true);
    const [handoff] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId));
    expect(handoff.state).toBe("awaiting_release");
    expect(handoff.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
  it("does not launch an old same-agent receipt after a later phase without an assignment version change", async () => {
    const f = await fixture(), heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(f.agentId, f.options);
    await db.update(caseHandoffs).set({ state: "delivered" }).where(eq(caseHandoffs.id, f.handoffId));
    await db.update(cases).set({ handoffVersion: 2, phase: "verification" }).where(eq(cases.id, f.caseId));
    await db.insert(caseHandoffs).values({ companyId: f.companyId, caseId: f.caseId, issueId: f.issueId,
      version: 2, toAgentId: f.agentId, phase: "verification", instructions: "Verify the change", actorType: "user", actorId: f.userId,
      wakeupRequestId: randomUUID(), idempotencyKey: "second-phase", inputFingerprint: "second", state: "delivered",
      expectedIssueStatusVersion: 0, appliedIssueStatusVersion: 0 });
    runningProcesses.delete(f.occupyingRunId); heldRuns.delete(f.occupyingRunId);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.occupyingRunId));
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    await heartbeat.resumeQueuedRuns();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)))[0])
      .toMatchObject({ status: "cancelled", startedAt: null, errorCode: "case_handoff_superseded" });
  });
});
