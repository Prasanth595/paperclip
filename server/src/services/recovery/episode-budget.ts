import { and, eq, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const RECOVERY_EPISODE_MAX_WAKES = 8;
export const RECOVERY_EPISODE_WINDOW_HOURS = 6;

export const RECOVERY_LANE_WAKE_IDEMPOTENCY_PREFIXES = {
  successful_run_handoff: "finish_successful_run_handoff:",
  disposition_repair: "issue_disposition_repair:",
  run_liveness_continuation: "run_liveness_continuation:",
} as const;

export type RecoveryEpisodeWakeUsage = {
  used: number;
  max: number;
  exhausted: boolean;
};

export async function readRecoveryEpisodeWakeUsage(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<RecoveryEpisodeWakeUsage> {
  const rows = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        ne(agentWakeupRequests.status, "skipped"),
        sql`${agentWakeupRequests.createdAt} > now() - make_interval(hours => ${RECOVERY_EPISODE_WINDOW_HOURS})`,
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        or(
          sql`${agentWakeupRequests.idempotencyKey} like ${`${RECOVERY_LANE_WAKE_IDEMPOTENCY_PREFIXES.successful_run_handoff}%`}`,
          sql`${agentWakeupRequests.idempotencyKey} like ${`${RECOVERY_LANE_WAKE_IDEMPOTENCY_PREFIXES.disposition_repair}%`}`,
          sql`${agentWakeupRequests.idempotencyKey} like ${`${RECOVERY_LANE_WAKE_IDEMPOTENCY_PREFIXES.run_liveness_continuation}%`}`,
        ),
      ),
    );
  return {
    used: rows.length,
    max: RECOVERY_EPISODE_MAX_WAKES,
    exhausted: rows.length >= RECOVERY_EPISODE_MAX_WAKES,
  };
}
