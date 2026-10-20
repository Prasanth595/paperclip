import { and, eq, isNull } from "drizzle-orm";
import { agents, dotAgentBindings, heartbeatRuns, mcpOauthGrants, museAgentBindings, type caseHandoffs, type issues, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { withExternalAdmissionGuard, type ExternalAdmissionTransaction } from "../modules/external-agents/index.js";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { authorizeExternalBotBinding } from "./external-bot-authority.js";
import { canActorReceiveCase } from "./case-access.js";
import type { AuthorizationActor } from "./authorization.js";

type Handoff = typeof caseHandoffs.$inferSelect;
type Issue = typeof issues.$inferSelect;

function sourceRunId(row: Handoff, issue: Issue) {
  // A new task's origin retains its creator run without yielding the separate
  // intake/chat task. Later phases always use the actual outgoing task run.
  return row.sourceRunId ?? (row.destinationKind === "agent" && row.version === 1 && row.actorType === "agent" && issue.createdByAgentId === row.actorId ? issue.originRunId : null);
}

/** Call after the task lock, before case/handoff locks (the release writer locks run then handoff). */
export async function lockCaseHandoffAuthorityRun(db: Db, row: Handoff, issue: Issue) {
  const id = sourceRunId(row, issue);
  if (id) await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, id), eq(heartbeatRuns.companyId, row.companyId))).for("share");
}

/** Recheck the persisted origin without requiring a live outgoing execution. */
export async function assertCaseHandoffSourceAuthority(db: Db, row: Handoff, issue: Issue): Promise<string | undefined> {
  let sourceAuthorizer: string | undefined;
  const id = sourceRunId(row, issue);
  const [run] = id ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, id), eq(heartbeatRuns.companyId, row.companyId))) : [];
  if (id && (!run || (row.actorType === "agent" && run.agentId !== row.actorId) || (row.sourceRunId && run.agentId !== row.fromAgentId))) throw forbidden("Handoff source authority is unavailable");
  const raw = run?.runnerProfileJson?.nativeExecutionInput as Record<string, unknown> | undefined;
  const provider = raw?.provider as Record<string, unknown> | undefined;
  if (run && (["openai_dot_mcp", "grok_bot_mcp", "muse_external"].includes(run.driverKind ?? "") || ["openai_dot", "grok_bot", "muse"].includes(String(provider?.kind)))) {
    let execution: ReturnType<typeof parseNativeExecutionInput>;
    try { execution = parseNativeExecutionInput(raw); } catch { throw forbidden("Pinned handoff source authority is unavailable"); }
    if (execution.binding.companyId !== row.companyId || execution.binding.agentId !== run.agentId || execution.binding.runId !== run.id ||
      execution.binding.issueId !== (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId)) throw forbidden("Pinned handoff source identity changed");
    await withExternalAdmissionGuard(db as unknown as ExternalAdmissionTransaction, row.companyId, run.agentId, async () => {
      if (execution.schema === "paperclip.native-execution-input.v8") {
        const { museRunnerBroker } = await import("./muse-runner-broker.js");
        sourceAuthorizer = await museRunnerBroker(db).authorizingUserIdForBinding(execution.provider.binding);
      } else if (execution.schema === "paperclip.native-execution-input.v6") {
        const ref = execution.provider.binding;
        const [binding] = await db.select().from(dotAgentBindings).where(and(eq(dotAgentBindings.id, ref.bindingId), eq(dotAgentBindings.companyId, row.companyId),
          eq(dotAgentBindings.agentId, run.agentId), eq(dotAgentBindings.generation, ref.bindingGeneration), isNull(dotAgentBindings.revokedAt)));
        const [grant] = binding?.grantId ? await db.select().from(mcpOauthGrants).where(and(eq(mcpOauthGrants.id, binding.grantId), isNull(mcpOauthGrants.revokedAt))) : [];
        if (!binding || !grant) throw forbidden("Handoff source connection was revoked");
        const current = await authorizeExternalBotBinding(db, { grant, actor: { type: "agent", agentId: binding.agentId, companyId: binding.companyId },
          company: { id: binding.companyId, name: "", issuePrefix: "", status: "active" } }, { provider: execution.provider.kind });
        if (current.id !== binding.id || current.generation !== ref.bindingGeneration) throw forbidden("Handoff source connection was replaced");
      } else throw forbidden("Pinned external handoff authority is unavailable");
    });
  }
  return sourceAuthorizer;
}

/** Recheck persistent connection authority after source execution has settled. */
export async function assertCaseHandoffDispatchAuthority(db: Db, row: Handoff, issue: Issue, caseRow: { id: string; companyId: string }) {
  if (row.destinationKind !== "agent" || !row.toAgentId) throw forbidden("Agent handoff requires a recipient");
  const sourceAuthorizer = await assertCaseHandoffSourceAuthority(db, row, issue);
  let recipientAuthorizer: string | undefined;
  const [recipient] = await db.select({ config: agents.adapterConfig }).from(agents).where(and(eq(agents.id, row.toAgentId), eq(agents.companyId, row.companyId)));
  if (recipient?.config.provider === "muse") {
    const bindingId = recipient.config.museBindingId;
    if (typeof bindingId !== "string") throw forbidden("Recipient external authorizer is unavailable");
    const [binding] = await db.select().from(museAgentBindings).where(and(eq(museAgentBindings.id, bindingId), eq(museAgentBindings.companyId, row.companyId),
      eq(museAgentBindings.agentId, row.toAgentId), isNull(museAgentBindings.revokedAt)));
    if (!binding) throw forbidden("Recipient external authorizer is unavailable");
    const { museRunnerBroker } = await import("./muse-runner-broker.js");
    recipientAuthorizer = await museRunnerBroker(db).authorizingUserIdForBinding({ companyId: row.companyId, agentId: row.toAgentId, bindingId, bindingGeneration: binding.generation }, { allowPaused: true });
  }
  const authorizers = [...new Set([sourceAuthorizer, recipientAuthorizer].filter((value): value is string => !!value))];
  for (const authorizer of authorizers.length ? authorizers : [undefined]) {
    const actor: AuthorizationActor = { type: "agent", agentId: row.toAgentId, companyId: row.companyId,
      onBehalfOfUserId: row.responsibleUserId, authorizingUserId: authorizer };
    if (!(await canActorReceiveCase(db, actor, caseRow, issue.id, row.toAgentId))) throw forbidden("Recipient or authorizer cannot access the case");
  }
}
