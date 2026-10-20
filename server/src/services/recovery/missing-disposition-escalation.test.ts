import { createDb, companies, issueThreadInteractions, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { askUserQuestionsPayloadSchema } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  MISSING_DISPOSITION_DECISION_OPTION_IDS,
  buildMissingDispositionDecisionInteractionKey,
  buildMissingDispositionDecisionPayload,
  ensureMissingDispositionDecisionCard,
} from "./missing-disposition-escalation.js";

describe("missing disposition decision card", () => {
  it("builds a machine-checkable single-select payload", () => {
    const payload = askUserQuestionsPayloadSchema.parse(
      buildMissingDispositionDecisionPayload({
        issueIdentifier: "PAP-42",
        missingDisposition: "clear_next_step",
        handoffAttemptsUsed: 1,
      }),
    );
    expect(payload.questions).toHaveLength(1);
    const [question] = payload.questions;
    expect(question.selectionMode).toBe("single");
    expect(question.required).toBe(true);
    expect(question.options.map((option) => option.id)).toEqual([
      ...MISSING_DISPOSITION_DECISION_OPTION_IDS,
    ]);
  });

  it("uses a stable idempotency key per issue and recovery action", () => {
    const key = buildMissingDispositionDecisionInteractionKey({
      issueId: "issue-1",
      recoveryActionId: "action-1",
    });
    expect(key).toBe("recovery:missing_disposition:issue-1:action-1");
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping missing disposition decision card database tests: ${support.reason}`);
describe.skipIf(!support.supported)("missing disposition decision card persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-missing-disposition-card");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Decision Cards", issuePrefix: "DC" })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({ companyId: company.id, identifier: "DC-1", title: "Missing disposition", status: "blocked" })
      .returning();
    return { company, issue };
  }

  it("creates one pending human-only card for an exhausted recovery action", async () => {
    const { company, issue } = await fixture();
    const first = await ensureMissingDispositionDecisionCard(db, {
      issue,
      recoveryActionId: "action-1",
      missingDisposition: "clear_next_step",
      handoffAttemptsUsed: 1,
    });
    expect(first?.created).toBe(true);

    const second = await ensureMissingDispositionDecisionCard(db, {
      issue,
      recoveryActionId: "action-1",
      missingDisposition: "clear_next_step",
      handoffAttemptsUsed: 1,
    });
    expect(second).toEqual({ id: first?.id, created: false });

    const rows = await db
      .select()
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, company.id),
          eq(issueThreadInteractions.issueId, issue.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      effectiveResolverPolicy: "human_only",
    });
    expect(askUserQuestionsPayloadSchema.parse(rows[0].payload).questions).toHaveLength(1);
  });

  it("leaves an existing durable waiting path in place", async () => {
    const { company, issue } = await fixture();
    await db.insert(issueThreadInteractions).values({
      companyId: company.id,
      issueId: issue.id,
      kind: "ask_user_questions",
      status: "pending",
      payload: buildMissingDispositionDecisionPayload({ issueIdentifier: issue.identifier }),
    });

    const result = await ensureMissingDispositionDecisionCard(db, {
      issue,
      recoveryActionId: "action-2",
    });
    expect(result).toBeNull();

    const rows = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issue.id));
    expect(rows).toHaveLength(1);
  });
});
