import { randomUUID } from "node:crypto";

import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
} from "@paperclipai/db";

import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Regression test: PATCH /agents/:id with runtimeConfig.aiConnection set to
// null must clear a previously set pin. Before the fix the validator
// rejected null outright, and the route refilled the pin from the existing
// agent whenever the requested config had no truthy aiConnection.
describeEmbeddedPostgres("agent PATCH aiConnection pin", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" } as const;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-agent-patch-ai-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `owner-${companyId}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Agent patch ai connection test",
      issuePrefix: `AP${companyId.slice(0, 5)}`,
      defaultResponsibleUserId: userId,
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active",
    });
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: userId, permissionKey: "agents:create",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pinned agent",
      role: "ceo",
      adapterType: "claude_local",
      runtimeConfig: { aiConnection: binding },
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running", responsibleUserId: userId,
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent", agentId, companyId, runId: run!.id, source: "agent_jwt",
        onBehalfOfUserId: userId,
        onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return { app, companyId, agentId };
  }

  async function readRuntimeConfig(agentId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    return (agent?.runtimeConfig ?? {}) as Record<string, unknown>;
  }

  it("clears the pin when aiConnection is explicitly null", async () => {
    const f = await fixture();
    const res = await request(f.app)
      .patch(`/api/agents/${f.agentId}`)
      .send({ runtimeConfig: { aiConnection: null } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const runtimeConfig = await readRuntimeConfig(f.agentId);
    expect(runtimeConfig.aiConnection).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(runtimeConfig, "aiConnection")).toBe(false);
  });

  it("keeps the pin when the runtimeConfig patch omits aiConnection", async () => {
    const f = await fixture();
    const res = await request(f.app)
      .patch(`/api/agents/${f.agentId}`)
      .send({ runtimeConfig: {} });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const runtimeConfig = await readRuntimeConfig(f.agentId);
    expect(runtimeConfig.aiConnection).toEqual(binding);
  });
});
