import { inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, projects, executionWorkspaceRepositoryAccess, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { measureRunPhase } from "./execution-preparation-timing.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { loadRunCleanupStates } from "./execution-blocker.js";

type ReaderDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReaderEntry = Pick<typeof executionWorkspaceRepositoryAccess.$inferSelect, "scopeId" | "issueId" | "agentId" | "responsibleUserId">;
type ReaderAgent = Pick<typeof agents.$inferSelect, "id" | "companyId" | "permissions">;
type ReaderIssue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "projectId" | "executionPolicy">;
type ReaderProject = Pick<typeof projects.$inferSelect, "companyId" | "executionWorkspacePolicy">;

export const rootReaderRunColumns = {
  id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
  responsibleUserId: heartbeatRuns.responsibleUserId, nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
  status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->'issueId', 'taskId', ${heartbeatRuns.contextSnapshot}->'taskId', 'executionPolicy', ${heartbeatRuns.contextSnapshot}->'executionPolicy')`,
};

type ReaderRunIdentity = Pick<typeof heartbeatRuns.$inferSelect, "nativeIssueId" | "issueId" | "contextSnapshot">;

// A wake for another task can coalesce into a running run and replace its context
// task after admission. The run's bound task still identifies its retained reader.
export function runRetainsIssueIdentity(run: ReaderRunIdentity, issueId: string) {
  return issueId === (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.issueId)
    || issueId === (run.nativeIssueId ?? run.issueId);
}

// This snapshot belongs to one guarded operation. Never retain it across admissions
// or publications: identities and permissions must be read again next time.
export async function loadRepositoryRootReaders<T extends ReaderEntry>(db: ReaderDb, companyId: string, entries: T[], requiredRunId?: string) {
  const runIds = [...new Set(entries.map(entry => entry.scopeId))];
  const agentIds = [...new Set(entries.flatMap(entry => entry.agentId ? [entry.agentId] : []))];
  const issueIds = [...new Set(entries.flatMap(entry => entry.issueId ? [entry.issueId] : []))];
  const runs = new Map<string, Pick<typeof heartbeatRuns.$inferSelect, keyof typeof rootReaderRunColumns>>();
  const agentRows = new Map<string, ReaderAgent>();
  const issueRows = new Map<string, ReaderIssue>();
  await measureRunPhase("workspace.readers.identity", async () => {
    for (let offset = 0; offset < runIds.length; offset += 500) {
      for (const row of await db.select(rootReaderRunColumns).from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, runIds.slice(offset, offset + 500)))) runs.set(row.id, row);
    }
    for (let offset = 0; offset < agentIds.length; offset += 500) {
      for (const row of await db.select({ id: agents.id, companyId: agents.companyId, permissions: agents.permissions }).from(agents)
        .where(inArray(agents.id, agentIds.slice(offset, offset + 500)))) agentRows.set(row.id, row);
    }
    for (let offset = 0; offset < issueIds.length; offset += 500) {
      for (const row of await db.select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId,
        executionPolicy: issues.executionPolicy }).from(issues)
        .where(inArray(issues.id, issueIds.slice(offset, offset + 500)))) issueRows.set(row.id, row);
    }
  });
  const readers = [];
  const orphanRunIds = new Set<string>();
  for (const entry of entries) {
    const run = runs.get(entry.scopeId);
    const agent = entry.agentId ? agentRows.get(entry.agentId) : undefined;
    const issue = entry.issueId ? issueRows.get(entry.issueId) : undefined;
    const runIssueId = run?.nativeIssueId ?? run?.contextSnapshot?.issueId ?? run?.contextSnapshot?.taskId ?? run?.issueId;
    if (!entry.agentId || !entry.issueId
      || (agent && agent.companyId !== companyId) || (issue && issue.companyId !== companyId)
      || (run && (run.companyId !== companyId || run.agentId !== entry.agentId || run.responsibleUserId !== entry.responsibleUserId
        || (!runRetainsIssueIdentity(run, entry.issueId) && (issue || runIssueId != null))))) {
      throw forbidden("Repository root retains a reader whose identity is no longer available");
    }
    if (!run || !agent || !issue) {
      if (entry.scopeId === requiredRunId) throw forbidden("Repository root retains a reader whose identity is no longer available");
      if (run && (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status) || !run.finishedAt || run.controllerLeaseExpiresAt)) {
        throw forbidden("Repository root retains a reader whose execution has not settled");
      }
      if (run) orphanRunIds.add(run.id);
      continue;
    }
    const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId,
      agentId: agent.id, runId: run.id, onBehalfOfUserId: entry.responsibleUserId === "local-board" ? null : entry.responsibleUserId };
    readers.push({ entry, run, agent, issue, actor });
  }
  const cleanup = await loadRunCleanupStates(db, companyId, [...orphanRunIds]);
  if ([...orphanRunIds].some(id => {
    const state = cleanup.get(id);
    return !state || state.pending || state.retained;
  })) throw forbidden("Repository root retains a reader whose execution has not settled");
  return readers;
}

export function requiresAnonymousRepositoryAcquisition(input: {
  companyId: string;
  issue: ReaderIssue;
  agent: ReaderAgent | undefined;
  project: ReaderProject | undefined;
  workspaceSourceProject: ReaderProject | undefined;
  run: Pick<typeof heartbeatRuns.$inferSelect, keyof typeof rootReaderRunColumns> | undefined;
  agentId: string | null;
  runId: string | null;
  explicitRunId?: string | null;
}) {
  const { companyId, issue, agent, project, workspaceSourceProject, run, agentId, runId } = input;
  if (agentId && !agent) throw forbidden("Task repository agent is unavailable");
  if (runId && (!run || (input.explicitRunId && run.agentId !== agentId)
    || !runRetainsIssueIdentity(run, issue.id))) {
    throw forbidden("Task repository run identity is unavailable");
  }
  const trust = resolveCoreTrustPreset({ companyId, agent, project, workspaceSourceProject, issue,
    run: run ? { companyId: run.companyId, executionPolicy: run.contextSnapshot?.executionPolicy } : null });
  if (trust.kind === "denied") throw forbidden(trust.detail);
  return trust.kind === "low_trust_review";
}
