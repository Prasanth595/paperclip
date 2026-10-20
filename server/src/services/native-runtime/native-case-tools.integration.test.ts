import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, caseAccessSources, caseDocuments, caseEvents, caseHandoffs, cases, heartbeatRuns, issues, pipelineCases, pipelines, pipelineStages } from "@paperclipai/db";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { instanceSettingsService } from "../instance-settings.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";

describe("native case tools through authenticated production routes", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const priorSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
    await instanceSettingsService(server.db).updateExperimental({ enableCases: true });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (priorSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = priorSecret;
  });
  async function fixture(mode: "standard" | "planning" | "ask" = "standard") {
    const f = await server.fixture({ apiToolsEnabled: false, disableWakeOnDemand: true, mode });
    await server.db.update(heartbeatRuns).set({ issueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
    const [record] = await server.db.insert(cases).values({ companyId: f.companyId, caseNumber: 1,
      identifier: `C-${randomUUID()}`, caseType: "receipt", title: "Receipt case", summary: "Two items at $3",
      fields: { total: 6, obsolete: true }, workIssueId: f.issueId }).returning();
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: true, workMode: mode });
    const call = (tool: string, input: Record<string, unknown> = {}, callId = randomUUID()) => authority.execute({ tool, callId, arguments: input });
    return { ...f, record: record!, authority, call };
  }
  it("exposes case facts and creation without a second document tool surface", async () => {
    const f = await fixture();
    const names = f.authority.definitions().map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(["create_case", "read_case", "update_case", "handoff_case", "read_document", "write_document"]));
    expect(names).not.toContain("read_case_document"); expect(names).not.toContain("write_case_document");
    expect(names).not.toContain("call_api");
    expect(await f.call("read_case")).toMatchObject({ ok: true, status: 200, data: { id: f.record.id, fields: { total: 6 } } });
    const update = { idempotencyKey: "receipt-facts", summary: "Verified", fields: { total: 6, currency: "USD" } };
    const updated = await f.call("update_case", update);
    expect(updated).toMatchObject({ status: 200, data: { summary: "Verified", fields: { total: 6, currency: "USD" } } });
    expect(await f.call("update_case", update)).toEqual(updated);
    const saved = (await server.db.select().from(cases).where(eq(cases.id, f.record.id)))[0]!;
    expect(saved.fields).toEqual({ total: 6, currency: "USD" }); expect(saved.workIssueId).toBe(f.issueId);
    await expect(f.call("update_case", { ...update, summary: "different" })).rejects.toThrow("reused with different");
    const sources = await server.db.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, f.record.id));
    expect(sources).toEqual(expect.arrayContaining([expect.objectContaining({ sourceKind: "issue", sourceId: f.issueId })]));
    const events = await server.db.select().from(caseEvents).where(eq(caseEvents.caseId, f.record.id));
    expect(events.filter(event => event.kind === "fields_changed")).toHaveLength(1);
  });
  it("requires kickoff before any case, task, comment, document or wake side effect", async () => {
    const f = await fixture();
    const snapshot = async () => ({ ...await f.snapshot(),
      cases: await server.db.select().from(cases).where(eq(cases.companyId, f.companyId)),
      handoffs: await server.db.select().from(caseHandoffs).where(eq(caseHandoffs.companyId, f.companyId)),
      wakes: await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)),
      runs: await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)),
    });
    const before = await snapshot();
    const input = { idempotencyKey: "missing-kickoff", caseType: "receipt", title: "Receipt facts", fields: { note: "private-data" },
      workflow_document_text: "Triage the receipt, implement corrections, verify, then hand off to done." };
    await expect(f.call("create_case", input)).rejects.toThrow("kickoff");
    for (const extra of [{ initialDocuments: [] }, { initialDocuments: [{ key: "brief", title: "Brief", body: "No kickoff" }] },
      { kickoff: null }, { kickoff: { phase: "triage" } }]) {
      await expect(f.call("create_case", { ...input, ...extra })).rejects.toThrow();
    }
    const kickoff = { toAgentId: f.agentId, phase: "triage", instructions: "Read the brief" };
    for (const extra of [{ status: "done" }, { key: "upsert" }, { responsibleUserId: randomUUID() }, { runId: f.runId }]) {
      await expect(f.call("create_case", { ...input, kickoff, ...extra })).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });
  it("requires explicit nonblank workflow text before native creation has any side effects", async () => {
    const f = await fixture();
    const snapshot = async () => ({ ...await f.snapshot(),
      cases: await server.db.select().from(cases).where(eq(cases.companyId, f.companyId)),
      handoffs: await server.db.select().from(caseHandoffs).where(eq(caseHandoffs.companyId, f.companyId)),
      wakes: await server.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)),
      runs: await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)),
    });
    const before = await snapshot();
    const input = { idempotencyKey: "missing-workflow", caseType: "receipt", title: "Check receipt",
      kickoff: { toAgentId: f.agentId, phase: "triage", instructions: "Read the workflow" } };
    await expect(f.call("create_case", input)).rejects.toThrow("workflow_document_text");
    for (const workflow_document_text of [null, "", " \n\t", "x".repeat(200_001)]) {
      await expect(f.call("create_case", { ...input, workflow_document_text })).rejects.toThrow();
    }
    await expect(f.call("create_case", { ...input, workflow_document_text: "Triage then verify.",
      initialDocuments: [{ key: " WORKFLOW ", title: "Override", body: "Unexpected routing" }] })).rejects.toThrow();
    await expect(f.call("create_case", { ...input, workflow_document_text: "x".repeat(200_000),
      initialDocuments: [{ key: "brief", title: "Brief", body: "Over the shared budget" }] })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it("kicks off through the durable handoff service with initial ordinary task documents", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const input = { idempotencyKey: "kickoff-case", caseType: "receipt", title: "Check receipt", summary: "Validate the brief",
      workflow_document_text: "  # Receipt workflow\n\nTriage → implementation → verification → done.\n\n```mermaid\nstateDiagram-v2\n  [*] --> triage\n  triage --> implementation\n```\n",
      kickoff: { toAgentId: f.agentId, phase: "triage", instructions: "Read the brief" },
      initialDocuments: [{ key: " BRIEF ", title: " Brief ", body: "Objective\\nDetails" }] };
    const receipt = await f.call("create_case", input) as { caseId: string; taskId: string; handoffId: string };
    expect(receipt).toMatchObject({ caseId: expect.any(String), taskId: expect.any(String), handoffId: expect.any(String), callerMustYield: false });
    expect(receipt.taskId).not.toBe(f.issueId);
    expect(await f.call("create_case", input)).toMatchObject({ ...receipt, replayed: true });
    const saved = await f.snapshot();
    expect(saved.issues).toHaveLength(before.issues.length + 1);
    expect(saved.documents).toHaveLength(before.documents.length + 2);
    expect(saved.documentRevisions).toHaveLength(before.documentRevisions.length + 2);
    expect(saved.comments).toHaveLength(before.comments.length + 1);
    expect(saved.documentRevisions.filter(revision => revision.createdByRunId === f.runId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ revisionNumber: 1, createdByAgentId: f.agentId })]));
    const { documentService } = await import("../documents.js");
    expect(await documentService(server.db).getIssueDocumentByKey(receipt.taskId, "brief")).toMatchObject({ title: "Brief", body: "Objective\nDetails" });
    expect(await documentService(server.db).getIssueDocumentByKey(receipt.taskId, "workflow"))
      .toMatchObject({ issueId: receipt.taskId, key: "workflow", title: "Workflow", format: "markdown", body: input.workflow_document_text, latestRevisionNumber: 1 });
    expect(await server.db.select().from(caseDocuments).where(eq(caseDocuments.caseId, receipt.caseId))).toHaveLength(0);
    expect(await server.db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, receipt.caseId))).toHaveLength(1);
    expect(await server.db.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, receipt.caseId)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ sourceKind: "issue", sourceId: receipt.taskId })]));
    const laterRunId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: laterRunId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId } });
    await server.db.update(issues).set({ executionRunId: laterRunId }).where(eq(issues.id, f.issueId));
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    const later = new PaperclipRunnerToolAuthority(server.db, { ...f, runId: laterRunId, casesEnabled: true, workMode: "standard" });
    expect(await later.execute({ tool: "create_case", callId: randomUUID(), arguments: input })).toMatchObject({ ...receipt, replayed: true });
    await expect(later.execute({ tool: "create_case", callId: randomUUID(), arguments: { ...input, workflow_document_text: "Changed routing" } }))
      .rejects.toThrow("Idempotency key was used for a different handoff");
    await expect(f.call("create_case", { ...input, initialDocuments: [{ key: "brief", title: "Changed", body: "Other" }] })).rejects.toThrow("Idempotency key was used for a different handoff");
    const afterReplay = await f.snapshot();
    expect(afterReplay.issues).toHaveLength(saved.issues.length);
    expect(afterReplay.documents).toHaveLength(saved.documents.length);
    expect(afterReplay.documentRevisions).toHaveLength(saved.documentRevisions.length);
    expect(afterReplay.comments).toHaveLength(saved.comments.length);
    await server.db.insert(caseAccessSources).values({ companyId: f.companyId, caseId: receipt.caseId, sourceKind: "issue", sourceId: f.blockerId });
    await server.db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    await expect(later.execute({ tool: "create_case", callId: randomUUID(), arguments: input })).rejects.toThrow("Case not found");
  });
  it("rejects unsupported fields and reads only explicit standalone cases in the authorized company", async () => {
    const f = await fixture();
    for (const extra of [{ status: "done" }, { phase: "done" }, { workIssueId: f.blockerId }, { responsibleUserId: randomUUID() }]) {
      await expect(f.call("update_case", { idempotencyKey: randomUUID(), title: "No", ...extra })).rejects.toThrow("Invalid case tool arguments");
    }
    await expect(f.call("update_case", { idempotencyKey: "empty" })).rejects.toThrow("Invalid case tool arguments");
    await expect(f.call("write_case_document", { key: "receipt", body: "No" })).rejects.toThrow();
    const [foreign] = await server.db.insert(cases).values({ companyId: f.foreignCompanyId, caseNumber: 1,
      identifier: `C-${randomUUID()}`, caseType: "private", title: "foreign-data-must-not-leak" }).returning();
    await expect(f.call("read_case", { caseId: foreign!.id })).rejects.toThrow("Case not found");
    await expect(f.call("read_case", { caseId: randomUUID() })).rejects.toThrow("Case not found");
    const [pipeline] = await server.db.insert(pipelines).values({ companyId: f.companyId, key: "separate", name: "Separate experimental model" }).returning();
    const [stage] = await server.db.insert(pipelineStages).values({ pipelineId: pipeline!.id, key: "triage", name: "Triage", kind: "working", position: 0 }).returning();
    const [pipelineCase] = await server.db.insert(pipelineCases).values({ companyId: f.companyId, pipelineId: pipeline!.id,
      stageId: stage!.id, caseKey: "pipeline-only", title: "pipeline-data-must-not-leak" }).returning();
    await expect(f.call("read_case", { caseId: pipelineCase!.id })).rejects.toThrow("Case not found");
    const other = await fixture();
    await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.blockerId));
    await server.db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    const [hidden] = await server.db.insert(cases).values({ companyId: f.companyId, caseNumber: 2,
      identifier: `C-${randomUUID()}`, caseType: "private", title: "hidden-case-canary" }).returning();
    await server.db.insert(caseAccessSources).values({ companyId: f.companyId, caseId: hidden!.id, sourceKind: "issue", sourceId: f.blockerId });
    await expect(f.call("read_case", { caseId: hidden!.id })).rejects.toThrow("Case not found");
    expect(await other.call("read_case")).toMatchObject({ status: 200, data: { id: other.record.id } });
  });
  it("retains case privacy on spilled response assets after source access is revoked", async () => {
    const f = await fixture();
    await server.db.insert(caseAccessSources).values({ companyId: f.companyId, caseId: f.record.id, sourceKind: "issue", sourceId: f.blockerId });
    const saved = await f.call("update_case", { idempotencyKey: "large-fields", fields: { canary: "private-case-canary ".repeat(2_000) } }) as { artifact: { artifactId: string; url: string } };
    expect(saved).toMatchObject({ ok: true, status: 200, artifact: { artifactId: expect.any(String) } });
    const asset = (await f.snapshot()).assets.find(asset => asset.id === saved.artifact.artifactId)!;
    expect(asset.objectKey).toContain(`/cases/${f.record.id}/runner-api/`);
    const headers = { Authorization: `Bearer ${createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId)}` };
    const readable = await fetch(`${server.apiUrl}${saved.artifact.url}`, { headers });
    expect(readable.status).toBe(200); await readable.body?.cancel();
    const readerId = randomUUID(), readerRunId = randomUUID();
    await server.db.insert(agents).values({ id: readerId, companyId: f.companyId, name: "Another case reader", status: "active",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: { heartbeat: { enabled: false } } });
    const [readerTask] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Another task",
      status: "in_progress", assigneeAgentId: readerId }).returning();
    await server.db.insert(heartbeatRuns).values({ id: readerRunId, companyId: f.companyId, agentId: readerId,
      nativeIssueId: readerTask!.id, status: "running", runtimeMode: "native", contextSnapshot: { issueId: readerTask!.id } });
    await server.db.update(issues).set({ executionRunId: readerRunId }).where(eq(issues.id, readerTask!.id));
    const readerHeaders = { Authorization: `Bearer ${createLocalAgentJwt(readerId, f.companyId, "paperclip_runner", readerRunId)}` };
    const sameCase = await fetch(`${server.apiUrl}/api/cases/${f.record.id}`, { headers: readerHeaders });
    expect(sameCase.status).toBe(200); await sameCase.body?.cancel();
    const otherRunCapture = await fetch(`${server.apiUrl}${saved.artifact.url}`, { headers: readerHeaders });
    expect(otherRunCapture.status).toBe(404); await otherRunCapture.body?.cancel();
    const generic = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: true, apiToolsEnabled: true });
    const genericRead = await generic.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "GET /api/cases/{id}", pathParams: { id: f.record.id },
    } }) as { artifact: { artifactId: string; url: string } };
    const genericAsset = (await f.snapshot()).assets.find(asset => asset.id === genericRead.artifact.artifactId)!;
    expect(genericAsset.objectKey).toContain(`/cases/${f.record.id}/runner-api/`);
    await server.db.update(issues).set({ visibility: "private", assigneeAgentId: null }).where(eq(issues.id, f.blockerId));
    await expect(f.call("read_case")).rejects.toThrow("Case not found");
    const denied = await fetch(`${server.apiUrl}${saved.artifact.url}`, { headers });
    expect(denied.status).toBe(404); await denied.body?.cancel();
    const genericDenied = await fetch(`${server.apiUrl}${genericRead.artifact.url}`, { headers });
    expect(genericDenied.status).toBe(404); await genericDenied.body?.cancel();
  });
  it("keeps feature and work-mode gates authoritative", async () => {
    const f = await fixture();
    for (const mode of ["planning", "ask"] as const) {
      const other = await fixture(mode);
      expect(other.authority.definitions().map(tool => tool.name)).not.toContain("read_case");
      await expect(other.call("read_case")).rejects.toThrow("mode_denied");
    }
    const disabled = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: false });
    expect(disabled.definitions().map(tool => tool.name)).not.toContain("read_case");
    await expect(disabled.execute({ tool: "read_case", callId: randomUUID(), arguments: {} })).rejects.toThrow("Cases are disabled");
    const review = new PaperclipRunnerToolAuthority(server.db, { ...f, casesEnabled: true,
      nativeReview: { nativeReviewInteractionId: randomUUID(), nativeReviewDecisionId: randomUUID() } });
    expect(review.definitions().map(tool => tool.name)).not.toContain("read_case");
    await expect(review.execute({ tool: "update_case", callId: randomUUID(), arguments: { idempotencyKey: "review", title: "No" } })).rejects.toThrow("may only inspect");
    await server.db.update(issues).set({ workMode: "skill_test" }).where(eq(issues.id, f.issueId));
    await expect(f.call("read_case")).rejects.toThrow("mode_denied");
    await server.db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, f.issueId));
    await instanceSettingsService(server.db).updateExperimental({ enableCases: false });
    try { await expect(f.call("read_case")).rejects.toThrow("Cases are disabled"); }
    finally { await instanceSettingsService(server.db).updateExperimental({ enableCases: true }); }
  });
  it("fences committed outgoing handoffs before a case write reaches the route", async () => {
    const f = await fixture();
    await server.db.insert(caseHandoffs).values({ companyId: f.companyId, caseId: f.record.id, issueId: f.issueId,
      version: 1, fromAgentId: f.agentId, toAgentId: f.agentId, phase: "verification", instructions: "Verify",
      actorType: "agent", actorId: f.agentId, sourceRunId: f.runId, wakeupRequestId: randomUUID(),
      idempotencyKey: "outgoing", inputFingerprint: "fixture", state: "awaiting_release" });
    await expect(f.call("update_case", { idempotencyKey: "too-late", title: "No" })).rejects.toThrow("handed off");
    await expect(f.call("create_case", { idempotencyKey: "too-late-create", caseType: "test", title: "No",
      workflow_document_text: "Triage then done.",
      kickoff: { toAgentId: f.agentId, phase: "triage", instructions: "No" } })).rejects.toThrow("handed off");
    expect((await server.db.select().from(cases).where(eq(cases.id, f.record.id)))[0]?.title).toBe("Receipt case");
    expect(await server.db.select().from(caseDocuments).where(eq(caseDocuments.caseId, f.record.id))).toHaveLength(0);
  });
  it("keeps cancelled runs from writing", async () => {
    const f = await fixture();
    await server.db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await f.call("update_case", { idempotencyKey: "stopped", title: "No" })).toMatchObject({ ok: false, status: 403 });
    await expect(f.call("create_case", { idempotencyKey: "stopped-create", caseType: "test", title: "No",
      workflow_document_text: "Triage then done.",
      kickoff: { toAgentId: f.agentId, phase: "triage", instructions: "No" } })).rejects.toThrow("cancelled");
    expect((await server.db.select().from(cases).where(and(eq(cases.id, f.record.id), eq(cases.companyId, f.companyId))))[0]?.title).toBe("Receipt case");
  });
  it("rechecks the handoff fence inside the route after HTTP dispatch was prepared", async () => {
    const f = await fixture();
    const [target] = await server.db.insert(cases).values({ companyId: f.companyId, caseNumber: 2,
      identifier: `C-${randomUUID()}`, caseType: "passive", title: "Untouched passive case" }).returning();
    const realFetch = globalThis.fetch;
    let arrived!: () => void, release!: () => void;
    const preparing = new Promise<void>(resolve => { arrived = resolve; });
    const continueRequest = new Promise<void>(resolve => { release = resolve; });
    const intercepted = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (...args) => {
      arrived(); await continueRequest; return realFetch(...args);
    });
    try {
      const pending = f.call("update_case", { caseId: target!.id, idempotencyKey: "race", title: "No" });
      await preparing;
      await server.db.insert(caseHandoffs).values({ companyId: f.companyId, caseId: f.record.id, issueId: f.issueId,
        version: 1, fromAgentId: f.agentId, toAgentId: f.agentId, phase: "verification", instructions: "Verify",
        actorType: "agent", actorId: f.agentId, sourceRunId: f.runId, wakeupRequestId: randomUUID(),
        idempotencyKey: "outgoing-race", inputFingerprint: "fixture", state: "awaiting_release" });
      release();
      expect(await pending).toMatchObject({ ok: false, status: 403 });
      expect((await server.db.select().from(cases).where(eq(cases.id, target!.id)))[0]?.title).toBe("Untouched passive case");
      expect(await server.db.select().from(caseAccessSources).where(eq(caseAccessSources.caseId, target!.id))).toHaveLength(0);
    } finally { release(); intercepted.mockRestore(); }
  });
});
