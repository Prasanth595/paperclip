import { and, eq, inArray, sql } from "drizzle-orm";
import { caseEvents, caseHandoffs, cases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { persistActivity, type ActivityPublication } from "../activity-log.js";
import { conflict } from "../../errors.js";
import { getExecutionBlocker, hasPendingRunCleanup } from "../execution-blocker.js";
import { isNativeRunnerOwnershipHeld } from "../native-runtime/native-runner-ownership.js";
import { hasNativeLocalProcessStop } from "../native-local-process-stop.js";
import { remoteExecutionHasStopped } from "../remote-execution-termination.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { assertActorCanReadCase, assertCaseTrustedForExecution } from "../case-access.js";
import { assertCaseHandoffSourceAuthority, lockCaseHandoffAuthorityRun } from "../case-handoff-authority.js";
import type { AuthorizationActor } from "../authorization.js";

/** Kept independent of the handoff application service to avoid an issues/service cycle. */
export async function pendingCaseHandoffForRun(db: Db, runId: string, companyId?: string) {
  const scope = companyId ?? await db.select({ companyId: heartbeatRuns.companyId }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId)).limit(1).then(rows => rows[0]?.companyId);
  if (!scope) return null;
  return db.select().from(caseHandoffs).where(and(eq(caseHandoffs.companyId, scope), eq(caseHandoffs.sourceRunId, runId),
    eq(caseHandoffs.destinationKind, "agent"),
    inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch", "delivered"])))
    .orderBy(caseHandoffs.createdAt).limit(1).then(rows => rows[0] ?? null);
}

export async function assertNoCaseHandoffMutation(db: Db, runId: string, issueId: string) {
  const handoff = await pendingCaseHandoffForRun(db, runId);
  if (handoff?.issueId === issueId) throw conflict("This run handed off the task. End the turn; the task remains open.",
    { code: "case_handoff_run_yielded", handoffId: handoff.id });
}

/** Called under the task lock by superseding mutations. No issueService dependency. */
export async function cancelCaseHandoffsForIssue(db: Db, input: {
  companyId: string; issueId: string; reason: string; exceptId?: string; publications?: ActivityPublication[];
  /** Accepted completion settles its terminal intent instead of superseding it. */
  agentTransfersOnly?: boolean;
}) {
  const rows = await db.update(caseHandoffs).set({ state: "cancelled", cancelledAt: new Date(), updatedAt: new Date(),
    leaseExpiresAt: null, lastErrorCode: "superseded", lastError: input.reason }).where(and(
    eq(caseHandoffs.companyId, input.companyId), eq(caseHandoffs.issueId, input.issueId),
    inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch", "awaiting_completion"]),
    input.agentTransfersOnly ? eq(caseHandoffs.destinationKind, "agent") : undefined,
    input.exceptId ? sql`${caseHandoffs.id} <> ${input.exceptId}` : undefined,
  )).returning();
  for (const row of rows) {
    await db.insert(caseEvents).values({ companyId: row.companyId, caseId: row.caseId, kind: "handoff_cancelled", actorType: "system",
      runId: row.sourceRunId, payload: { handoffId: row.id, issueId: row.issueId, phase: row.phase, version: row.version, reason: input.reason } });
    const event = await persistActivity(db, { companyId: row.companyId, actorType: "system", actorId: "case-handoff",
      runId: row.sourceRunId, issueId: row.issueId, action: "case.handoff_cancelled", entityType: "case", entityId: row.caseId,
      details: { handoffId: row.id, issueId: row.issueId, phase: row.phase, version: row.version, reason: input.reason } });
    input.publications?.push(event.publication);
  }
  if (rows.length) await notifyDeliveryWork(db, DELIVERY_QUEUES.caseHandoffs, input.companyId);
}

/**
 * The caller holds the task lock in its transaction. This records the consequence
 * of an already accepted Done; it neither decides completion nor bypasses its
 * review/evidence gates. Task, case, intent and audit commit or roll back together.
 */
export async function completeTerminalCaseHandoffsForIssue(db: Db, input: {
  companyId: string; issueId: string; publications?: ActivityPublication[];
}): Promise<number> {
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue || issue.status !== "done") return 0;
  const [snapshot] = await db.select().from(caseHandoffs).where(and(
    eq(caseHandoffs.companyId, input.companyId), eq(caseHandoffs.issueId, issue.id),
    eq(caseHandoffs.destinationKind, "done"), eq(caseHandoffs.state, "awaiting_completion"),
  )).limit(1);
  if (!snapshot) return 0;
  // Keep the same task -> source run -> case -> handoff order as handoff
  // acceptance/dispatch. Status-version changes during review are legitimate;
  // assignment changes cancel this intent at the common task mutation boundary.
  await lockCaseHandoffAuthorityRun(db, snapshot, issue);
  const [caseRow] = await db.select().from(cases).where(and(eq(cases.id, snapshot.caseId), eq(cases.companyId, input.companyId))).for("update");
  const [row] = await db.select().from(caseHandoffs).where(and(eq(caseHandoffs.id, snapshot.id),
    eq(caseHandoffs.state, "awaiting_completion"), eq(caseHandoffs.destinationKind, "done"))).for("update");
  if (!row) return 0;
  let invalidReason: string | null = null;
  if (!caseRow || caseRow.workIssueId !== issue.id || caseRow.handoffVersion !== row.version ||
      issue.assigneeAgentId !== row.fromAgentId || issue.assigneeUserId || issue.responsibleUserId !== row.responsibleUserId ||
      caseRow.status === "cancelled") {
    invalidReason = "Terminal handoff was superseded by a newer task or case decision";
  } else {
    try {
      const authorizingUserId = await assertCaseHandoffSourceAuthority(db, row, issue);
      const actor: AuthorizationActor = row.actorType === "agent"
        ? { type: "agent", companyId: row.companyId, agentId: row.actorId, runId: row.sourceRunId ?? undefined,
            onBehalfOfUserId: row.responsibleUserId, authorizingUserId }
        : { type: "board", companyIds: [row.companyId], userId: row.actorId === "board" ? undefined : row.actorId,
            source: row.actorId === "board" ? "local_implicit" : undefined, ignoreInstanceAdmin: true };
      await assertActorCanReadCase(db, actor, caseRow);
      await assertCaseTrustedForExecution(db, caseRow);
    } catch (error) {
      // Revoked case authority must not prevent an otherwise legitimate task
      // completion. Cancel this extra effect while retaining its audit trail.
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;
      if (status !== 403 && status !== 404) throw error;
      invalidReason = "Terminal handoff authority is no longer available";
    }
  }
  if (invalidReason) {
    await cancelCaseHandoffsForIssue(db, { ...input, reason: invalidReason });
    return 0;
  }
  const at = new Date();
  await db.update(cases).set({ status: "done", completedAt: caseRow!.completedAt ?? at, phase: "done", updatedAt: at })
    .where(and(eq(cases.id, row.caseId), eq(cases.companyId, row.companyId)));
  await db.update(caseHandoffs).set({ state: "completed", completedAt: at, updatedAt: at,
    leaseExpiresAt: null, lastErrorCode: null, lastError: null }).where(eq(caseHandoffs.id, row.id));
  const details = { handoffId: row.id, issueId: issue.id, phase: "done", version: row.version,
    destinationKind: "done", state: "completed", issueStatusVersion: issue.statusVersion };
  await db.insert(caseEvents).values({ companyId: row.companyId, caseId: row.caseId, kind: "handoff_completed", actorType: "system",
    runId: row.sourceRunId, payload: details });
  const event = await persistActivity(db, { companyId: row.companyId, actorType: "system", actorId: "case-handoff",
    runId: row.sourceRunId, issueId: row.issueId, action: "case.handoff_completed", entityType: "case", entityId: row.caseId,
    responsibleUserIdOverride: row.responsibleUserId, details });
  input.publications?.push(event.publication);
  return 1;
}

/** A terminal run status alone is insufficient: the executor records this only after cleanup. */
export async function recordCaseHandoffExecutionReleased(db: Db, runId: string, issueId: string) {
  await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const handoff = await pendingCaseHandoffForRun(tx, runId);
    if (!handoff || handoff.issueId !== issueId) return;
    const at = new Date();
    const released = await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
      ${JSON.stringify({ caseHandoffExecutionReleased: { schema: "paperclip.case-handoff-release.v1", runId, issueId,
        settledAt: at.toISOString() } })}::jsonb` }).where(and(eq(heartbeatRuns.id, runId),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "interrupted", "timed_out"]))).returning({ id: heartbeatRuns.id });
    if (!released.length) return;
    await tx.update(caseHandoffs).set({ nextAttemptAt: at, updatedAt: at }).where(and(eq(caseHandoffs.id, handoff.id),
      eq(caseHandoffs.state, "awaiting_release")));
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, handoff.companyId);
  });
}

export async function isCaseHandoffSourceReleased(db: Db, input: { runId: string; issueId: string }): Promise<boolean> {
  const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).then(rows => rows[0]);
  if (!run || !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status) ||
      isNativeRunnerOwnershipHeld(run)) return false;
  const marker = run.resultJson?.caseHandoffExecutionReleased as Record<string, unknown> | undefined;
  if (await hasPendingRunCleanup(db, run.companyId, run.id)) return false;
  if (await getExecutionBlocker(db, run.companyId, input.issueId)) return false;
  if (marker?.schema === "paperclip.case-handoff-release.v1" && marker.runId === run.id && marker.issueId === input.issueId) return true;
  // A controller may die after cleanup but before writing its marker. Recover
  // only from host/provider-owned stop evidence, never a terminal status or an
  // expired controller lease. Workspace recovery remains an independent gate.
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  // setRunStatusFromLive records bootstrap evidence when cancelling an
  // unclaimed queue entry. Its persisted absence of a first start and runtime
  // selection proves no provider or workspace executor was ever admitted.
  const neverStarted = run.status === "cancelled" && run.runtimeMode === "legacy" && !run.startedAt &&
    !run.runtimeModeResolvedAt && !run.processPid && !run.processGroupId && !run.runnerInstanceId && !run.nativeSessionId &&
    recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false;
  const stopped = await remoteExecutionHasStopped(db, run.companyId, run.id) ||
    (run.runtimeMode === "native" && await hasNativeLocalProcessStop(db, run.companyId, run.id)) ||
    neverStarted ||
    (run.runtimeMode === "legacy" && recovery?.providerStopped === true && recovery?.sessionPreserved === true &&
      recovery?.actionOutcomes === "settled" && run.executionStage === "settled");
  if (!stopped) return false;
  await recordCaseHandoffExecutionReleased(db, run.id, input.issueId);
  return true;
}
