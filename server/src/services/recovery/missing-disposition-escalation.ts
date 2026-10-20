import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issueThreadInteractions, issues } from "@paperclipai/db";
import {
  askUserQuestionsPayloadSchema,
  type AskUserQuestionsPayload,
} from "@paperclipai/shared";

export const RECOVERY_EPISODE_LANE_MAX_ATTEMPTS = {
  successful_run_handoff: 1,
  disposition_repair: 5,
  run_liveness_continuation: 2,
} as const;

export const RECOVERY_EPISODE_MAX_ATTEMPTS = Object.values(
  RECOVERY_EPISODE_LANE_MAX_ATTEMPTS,
).reduce((total, attempts) => total + attempts, 0);

export const MISSING_DISPOSITION_DECISION_OPTION_IDS = [
  "mark_done",
  "mark_cancelled",
  "send_for_review",
  "mark_blocked",
  "delegate_followup",
  "retry_owner",
] as const;

export type MissingDispositionDecisionOptionId =
  (typeof MISSING_DISPOSITION_DECISION_OPTION_IDS)[number];

export function isRecoveryEpisodeBudgetExhausted(
  attemptCount: number,
  maxAttempts: number = RECOVERY_EPISODE_MAX_ATTEMPTS,
) {
  return attemptCount >= maxAttempts;
}

export function buildMissingDispositionDecisionInteractionKey(input: {
  issueId: string;
  recoveryActionId: string;
}) {
  return `recovery:missing_disposition:${input.issueId}:${input.recoveryActionId}`;
}

export function buildMissingDispositionDecisionPayload(input: {
  issueIdentifier?: string | null;
  missingDisposition?: string | null;
  handoffAttemptsUsed?: number | null;
}): AskUserQuestionsPayload {
  const issueLabel = input.issueIdentifier?.trim() || "this issue";
  const missingDisposition = input.missingDisposition?.trim() || "clear_next_step";
  const attemptsUsed = input.handoffAttemptsUsed ?? RECOVERY_EPISODE_LANE_MAX_ATTEMPTS.successful_run_handoff;
  return askUserQuestionsPayloadSchema.parse({
    version: 1,
    title: "Missing disposition recovery exhausted",
    submitLabel: "Record disposition",
    supersedeOnUserComment: true,
    questions: [
      {
        id: "missing_disposition_resolution",
        prompt: `How should Paperclip resolve ${issueLabel}?`,
        helpText:
          `Automatic recovery used ${attemptsUsed} corrective wake and stopped without a durable disposition ` +
          `(missing: ${missingDisposition}). The issue is blocked. Pick one outcome. Paperclip records your ` +
          "choice as the issue disposition and wakes the assignee.",
        selectionMode: "single",
        required: true,
        allowOther: false,
        options: [
          {
            id: "mark_done",
            label: "Mark the issue done",
            description: "The recorded run evidence shows that the requested scope is complete.",
          },
          {
            id: "mark_cancelled",
            label: "Mark the issue cancelled",
            description: "The work was intentionally stopped and must not continue.",
          },
          {
            id: "send_for_review",
            label: "Send for review",
            description: "A named reviewer must inspect the evidence before the issue can close.",
          },
          {
            id: "mark_blocked",
            label: "Record a blocker",
            description: "A first-class blocker or a named unblock owner must act before the issue can continue.",
          },
          {
            id: "delegate_followup",
            label: "Delegate a follow-up issue",
            description: "Create or link follow-up work and block this issue on it.",
          },
          {
            id: "retry_owner",
            label: "Retry the original assignee",
            description: "Wake the original assignee with one explicit instruction to record a disposition.",
          },
        ],
      },
    ],
  }) as AskUserQuestionsPayload;
}

type MissingDispositionIssue = {
  id: string;
  companyId: string;
  identifier?: string | null;
  assigneeUserId?: string | null;
  monitorNextCheckAt?: Date | null;
};

type DatabaseReader = Pick<Db, "select" | "insert">;

async function hasDurableWaitingPath(db: DatabaseReader, issue: MissingDispositionIssue) {
  if (issue.assigneeUserId) return true;
  if (issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > Date.now()) return true;
  const [pendingInteraction, pendingApproval] = await Promise.all([
    db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          eq(issueThreadInteractions.status, "pending"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(
        approvals,
        and(
          eq(issueApprovals.approvalId, approvals.id),
          eq(issueApprovals.companyId, approvals.companyId),
        ),
      )
      .where(
        and(
          eq(issueApprovals.companyId, issue.companyId),
          eq(issueApprovals.issueId, issue.id),
          eq(approvals.companyId, issue.companyId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  return Boolean(pendingInteraction || pendingApproval);
}

export async function ensureMissingDispositionDecisionCard(
  db: Db,
  input: {
    issue: MissingDispositionIssue;
    recoveryActionId: string;
    sourceRunId?: string | null;
    missingDisposition?: string | null;
    handoffAttemptsUsed?: number | null;
  },
) {
  const idempotencyKey = buildMissingDispositionDecisionInteractionKey({
    issueId: input.issue.id,
    recoveryActionId: input.recoveryActionId,
  });
  const findExisting = (reader: DatabaseReader) =>
    reader
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, input.issue.companyId),
          eq(issueThreadInteractions.issueId, input.issue.id),
          eq(issueThreadInteractions.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

  const existing = await findExisting(db);
  if (existing) return { id: existing.id, created: false };

  const payload = buildMissingDispositionDecisionPayload({
    issueIdentifier: input.issue.identifier,
    missingDisposition: input.missingDisposition,
    handoffAttemptsUsed: input.handoffAttemptsUsed,
  });

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(
        and(
          eq(issues.id, input.issue.id),
          eq(issues.companyId, input.issue.companyId),
        ),
      )
      .for("update");
    if (!locked || locked.status === "done" || locked.status === "cancelled") return null;

    const concurrent = await findExisting(tx);
    if (concurrent) return { id: concurrent.id, created: false };
    if (await hasDurableWaitingPath(tx, input.issue)) return null;

    const [created] = await tx
      .insert(issueThreadInteractions)
      .values({
        companyId: input.issue.companyId,
        issueId: input.issue.id,
        kind: "ask_user_questions",
        status: "pending",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        resolverPolicyProvenance: "explicit",
        effectiveResolverPolicySource: "requested",
        idempotencyKey,
        title: "Missing disposition recovery exhausted",
        summary:
          "Automatic recovery stopped without a durable issue disposition. The board must choose one outcome.",
        sourceRunId: input.sourceRunId ?? null,
        payload,
      })
      .onConflictDoNothing()
      .returning({ id: issueThreadInteractions.id });
    if (created) return { id: created.id, created: true };
    const raced = await findExisting(tx);
    return raced ? { id: raced.id, created: false } : null;
  });
}
