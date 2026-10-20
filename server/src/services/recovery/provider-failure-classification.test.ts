import { classifyRunLiveness } from "../run-liveness.js";
import { isAiAuthenticationBlocked } from "../ai-auth-failure.js";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_MONITOR_MAX_ATTEMPTS,
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
  providerQuotaMonitorBackoffMs,
  quotaMonitorAttemptAccounting,
} from "./service.js";
import { legacyExecutionNeedsReconciliation } from "../legacy-execution-recovery.js";
import { isConfigurationIncompleteFailedRun } from "../../modules/wake-queue/domain/values.js";

describe("providerQuotaMonitorBackoffMs", () => {
  it("grows from 15 minutes and stops at 6 hours", () => {
    expect(PROVIDER_QUOTA_MONITOR_MAX_ATTEMPTS).toBe(5);
    expect(providerQuotaMonitorBackoffMs(0)).toBe(15 * 60 * 1000);
    expect(providerQuotaMonitorBackoffMs(1)).toBe(30 * 60 * 1000);
    expect(providerQuotaMonitorBackoffMs(2)).toBe(60 * 60 * 1000);
    expect(providerQuotaMonitorBackoffMs(3)).toBe(2 * 60 * 60 * 1000);
    expect(providerQuotaMonitorBackoffMs(4)).toBe(4 * 60 * 60 * 1000);
    expect(providerQuotaMonitorBackoffMs(5)).toBe(6 * 60 * 60 * 1000);
    expect(providerQuotaMonitorBackoffMs(79)).toBe(6 * 60 * 60 * 1000);
  });
});

describe("quotaMonitorAttemptAccounting", () => {
  it("starts a new quota episode after unrelated monitor checks", () => {
    expect(quotaMonitorAttemptAccounting({
      monitorAttemptCount: 5,
      serviceName: "deploy",
      monitorStatus: "triggered",
      maxAttempts: 3,
      savedBaseline: null,
    })).toEqual({ baseline: 5, quotaRetries: 0, dispatcherMaxAttempts: 10 });
  });

  it("counts only retries since the saved quota baseline", () => {
    expect(quotaMonitorAttemptAccounting({
      monitorAttemptCount: 7,
      serviceName: "AI provider quota",
      monitorStatus: "triggered",
      maxAttempts: 10,
      savedBaseline: null,
    })).toEqual({ baseline: 5, quotaRetries: 2, dispatcherMaxAttempts: 10 });
    expect(quotaMonitorAttemptAccounting({
      monitorAttemptCount: 101,
      serviceName: "AI provider quota",
      monitorStatus: "triggered",
      maxAttempts: null,
      savedBaseline: 96,
    })).toEqual({ baseline: 96, quotaRetries: 5, dispatcherMaxAttempts: null });
  });

  it("keeps a legacy unbounded quota loop on the raw attempt count", () => {
    expect(quotaMonitorAttemptAccounting({
      monitorAttemptCount: 79,
      serviceName: "AI provider quota",
      monitorStatus: "scheduled",
      maxAttempts: null,
      savedBaseline: null,
    })).toEqual({ baseline: 0, quotaRetries: 79, dispatcherMaxAttempts: 5 });
  });

  it("does not continue a quota episode after the monitor is cleared", () => {
    expect(quotaMonitorAttemptAccounting({
      monitorAttemptCount: 10,
      serviceName: "AI provider quota",
      monitorStatus: "cleared",
      maxAttempts: 10,
      savedBaseline: 5,
    })).toEqual({ baseline: 10, quotaRetries: 0, dispatcherMaxAttempts: 15 });
  });
});

describe("classifyAdapterFailureForRecovery", () => {
  it("waits for model configuration changes instead of retrying a typed native model rejection", () => {
    const run = { errorCode: "native_provider_model_rejected", error: "Fixed model configuration message", resultJson: null };
    expect(classifyAdapterFailureForRecovery(run)).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect(isConfigurationIncompleteFailedRun(run)).toBe(true);
    expect(isAiAuthenticationBlocked(run as never)).toBe(false);
    const unknown = { ...run, errorCode: "adapter_failed", error: "native_provider_model_rejected" };
    expect(classifyAdapterFailureForRecovery(unknown)).toBeNull();
    expect(classifyContinuationFailure(unknown as never).kind).toBe("transient_infra");
    expect(isConfigurationIncompleteFailedRun(unknown)).toBe(false);
  });
  it("retries a continuation whose host lost the controller lease before dispatch", () => {
    expect(classifyContinuationFailure({ errorCode: "controller_lease_lost", error: "Legacy controller lease lost", resultJson: null } as never))
      .toMatchObject({ kind: "transient_infra", maxAttempts: 3 });
    expect(classifyContinuationFailure({ errorCode: "setup_failed", error: "Legacy controller lease lost", resultJson: null } as never).kind)
      .toBe("non_retryable");
  });
  it.each(["acpx_auth_required", "claude_auth_required", "codex_auth_required", "adapter_auth_missing", "refresh_token_reused", "authentication_required"])("does not automatically retry provider authentication failure %s", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: true });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(true);
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });

  it.each(["kimi_auth_required", "acpx_auth_required", "gemini_auth_required"])("preserves recovery when %s did not produce an inline repair card", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: false });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(false);
    expect(classifyContinuationFailure(run as never).kind).toBe("default");
  });

  it("uses a typed ACP quota reset without needing the provider's original message", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: "2026-07-15T21:30:00.000Z",
        providerQuotaRetryNotBefore: "2026-07-15T21:30:00.000Z",
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the existing backoff for a typed ACP quota failure with no reset timestamp", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: { errorFamily: "provider_quota" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("classifies the qualifier-less limit wording and parses the 'resets' clock", () => {
    // Current Claude CLI phrasing, as recorded on the run by the adapter.
    const now = new Date("2026-08-28T22:30:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Claude run failed: subtype=success: You've hit your limit · resets 2:30am (UTC)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-29T02:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("routes unavailable engines to a configuration blocker instead of retrying", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_engine_unavailable",
      error: "Node v22.22.2 does not satisfy Codex ACP's Node >=24.11.0 prerequisite.",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure({ errorCode: "adapter_engine_unavailable" } as never))
      .toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status: "failed",
      errorCode: "adapter_engine_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    })).toBe(false);
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
  it("holds invalid provider definitions for repair even with stale transient metadata", () => {
    const run = { errorCode: "provider_tool_definition_invalid", error: "Tool name is too long.",
      resultJson: { errorFamily: "transient_upstream" } };
    expect(classifyAdapterFailureForRecovery(run)).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });
});
