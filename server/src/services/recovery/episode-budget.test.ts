import { describe, expect, it } from "vitest";
import { decideSuccessfulRunHandoff } from "./successful-run-handoff.js";
import { decideRunLivenessContinuation } from "./run-liveness-continuations.js";

const run = {
  id: "run-1",
  companyId: "company-1",
  agentId: "agent-1",
  status: "succeeded",
  contextSnapshot: { issueId: "issue-1" },
  continuationAttempt: 0,
} as any;

const issue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Shared recovery budget",
  description: "Bound the automatic recovery lanes.",
  status: "in_progress",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  executionState: null,
} as any;

const agent = { id: "agent-1", companyId: "company-1", status: "idle" } as any;

describe("shared recovery episode budget", () => {
  it("blocks the corrective handoff wake when the episode budget is spent", () => {
    const decision = decideSuccessfulRunHandoff({
      run,
      issue,
      agent,
      livenessState: "advanced",
      detectedProgressSummary: "produced progress",
      finalReport: "done",
      nextAction: "record a disposition",
      taskKey: "issue-1",
      hasActiveExecutionPath: false,
      hasQueuedWake: false,
      hasPendingInteractionOrApproval: false,
      hasPersistedMonitor: false,
      hasExplicitBlockerPath: false,
      hasOpenRecoveryIssue: false,
      hasPauseHold: false,
      hasActiveRoutineContinuation: false,
      recoveryEpisodeExhausted: true,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "recovery episode wake budget exhausted",
    });
  });

  it("blocks the liveness continuation wake when the episode budget is spent", () => {
    const decision = decideRunLivenessContinuation({
      run,
      issue,
      agent,
      livenessState: "plan_only",
      livenessReason: "Run described future work",
      nextAction: null,
      budgetBlocked: false,
      recoveryEpisodeExhausted: true,
      idempotentWakeExists: false,
    });
    expect(decision).toEqual({
      kind: "skip",
      reason: "recovery episode wake budget exhausted",
    });
  });
});
