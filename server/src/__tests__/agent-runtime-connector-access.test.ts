import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, heartbeatRuns, issues, companies, companyMemberships, principalPermissionGrants, companySecrets, companySecretBindings, companySecretProviderConfigs, connectionGrants, connectionGrantMembers, connectionGrantDelegations, userSecretDefinitions, createDb, plugins, toolApplications, toolConnections, toolCatalogEntries, toolConnectionInstalls, toolProfiles, toolProfileBindings, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { updateAgentConfigurationInTransaction } from "../services/agent-configuration-transaction.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { emailConnectionService } from "../services/email-connections.js";
import { accessService } from "../services/access.js";
import { secretService } from "../services/secrets.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("connector access runtime synchronization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let agentId: string;
  let peerId: string;
  let pluginId: string;
  let applicationId: string;
  let connectionId: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-runtime-access-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); peerId = randomUUID(); pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Connector runtime fixture", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "runtime-fixture", version: "1.0.0", status: "ready", manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["events.subscribe", "agents.lifecycle.manage"] } as never });
    await db.insert(agents).values([agentId, peerId].map(id => ({ id, companyId, name: id, adapterType: "paperclip_runner", lifecycleRequiredPluginIds: [pluginId] })));
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Fixture MCP", type: "mcp_http" }).returning(); applicationId = application.id;
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId, name: "Fixture connection", uid: randomUUID(), transport: "mcp_remote", authKind: "none", enabled: true, status: "active" }).returning(); connectionId = connection.id;
  });
  const events = () => db.select().from(resourceLifecycleEvents).where(and(eq(resourceLifecycleEvents.companyId, companyId), eq(resourceLifecycleEvents.resourceType, "agent_runtime"))).orderBy(resourceLifecycleEvents.id);

  it("captures referenced vault configuration and disablement through the real provider service", async () => {
    const [vault] = await db.insert(companySecretProviderConfigs).values({ companyId, provider: "aws_secrets_manager", displayName: "Fixture vault", config: { region: "us-east-1" } }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, provider: "aws_secrets_manager", providerConfigId: vault.id, key: "vault", name: "Vault fixture" }).returning();
    await db.update(toolConnections).set({ credentialSecretRefs: [{ secretId: secret.id, configPath: "token" }] }).where(eq(toolConnections.id, connectionId));
    const before = (await events()).length;
    await db.update(companySecretProviderConfigs).set({ healthStatus: "ok", healthCheckedAt: new Date(), healthDetails: { fixture: true } }).where(eq(companySecretProviderConfigs.id, vault.id));
    expect(await events()).toHaveLength(before);
    await secretService(db).updateProviderConfig(vault.id, { config: { region: "us-west-2" } });
    expect(await events()).toHaveLength(before + 2);
    await secretService(db).disableProviderConfig(vault.id);
    expect(await events()).toHaveLength(before + 4);
    const [unrelated] = await db.insert(companySecretProviderConfigs).values({ companyId, provider: "local_encrypted", displayName: "Unreferenced vault" }).returning();
    await secretService(db).disableProviderConfig(unrelated.id);
    expect(await events()).toHaveLength(before + 4);
  });
  it("skips unchanged grant audiences and coalesces replacements to one company refresh per transaction", async () => {
    await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, status: "active" })));
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization" }).returning();
    const service = toolAccessService(db);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, ["alice"]);
    const before = (await events()).length;
    expect((await service.replaceConnectionGrantMembers(connectionId, grant.id, ["alice", "alice"])).members).toHaveLength(1);
    expect(await events()).toHaveLength(before);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, ["bob"]);
    expect(await events()).toHaveLength(before + 2);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, []);
    expect(await events()).toHaveLength(before + 4);
    await service.replaceConnectionGrantMembers(connectionId, grant.id, []);
    expect(await events()).toHaveLength(before + 4);
  });
  it.each(["uninstall", "permission save"] as const)("serializes %s with finalization or role changes before runtime locks", async change => {
    let first: (client: Db) => Promise<unknown>;
    let second: (client: Db) => Promise<unknown>;
    let memberId: string | undefined;
    if (change === "uninstall") {
      await toolAccessService(db).putConnectionInstalls(connectionId, { installs: [{ targetType: "agent", targetId: agentId }] });
      expect((await toolAccessService(db).getConnection(connectionId, companyId)).config.mcpAgentAccessConfigured).toBe(true);
      first = client => toolAccessService(client).putConnectionInstalls(connectionId, { installs: [] });
      second = client => toolAccessService(client).finishGalleryAppConnection(companyId, connectionId, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" });
    } else {
      const [member] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active", membershipRole: "member" }).returning();
      memberId = member.id;
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: "alice", permissionKey: "agents:create" });
      first = client => accessService(client).updateMemberAndPermissions(companyId, member.id, { membershipRole: "admin", grants: [{ permissionKey: "agents:create" }] }, null);
      second = client => accessService(client).setMemberPermissions(companyId, member.id, [{ permissionKey: "issues:create" }], null);
    }
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, [agentId, peerId].sort()[0])).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (client: Db) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(tx as unknown as Db);
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const initial = run(first);
    let concurrent: Promise<unknown> | undefined;
    try {
      await waitForLock(0);
      concurrent = run(second);
      await waitForLock(1);
    } finally { release(); await blocker; }
    const results = await Promise.allSettled([initial, concurrent]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    if (change === "uninstall") {
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId))).toHaveLength(0);
      const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId));
      expect(bindings.some(binding => binding.metadata?.source === "tool_connection_install")).toBe(false);
    } else {
      expect(await accessService(db).getMemberById(companyId, memberId!)).toMatchObject({ membershipRole: "admin" });
      expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId))).toEqual([expect.objectContaining({ permissionKey: "issues:create" })]);
    }
  }, 15000);
  it.each(["email allowAgent", "connection intent"] as const)("orders outer %s with direct install saves", async caller => {
    let outer: (client: Db) => Promise<unknown>;
    if (caller === "email allowAgent") {
      await db.update(toolConnections).set({ config: { provider: "agentmail", mcpAgentAccessConfigured: true } }).where(eq(toolConnections.id, connectionId));
      outer = client => emailConnectionService(client).allowAgent(companyId, connectionId, agentId, { localImplicit: true }, "fixture-setup");
    } else {
      const userId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Fixture user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Use Notion", status: "in_progress", assigneeAgentId: agentId });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId, contextSnapshot: { issueId } });
      const pending = await connectionIntentService(db).request({ sub: agentId, company_id: companyId, run_id: runId, responsible_user_id: userId, scope: "connection_intents", iat: 1, exp: 2, instance_id: "test" }, "notion");
      expect(pending.interactionId).toEqual(expect.any(String));
      await db.update(toolConnections).set({ healthStatus: "ok", config: { sourceTemplateKey: "notion", mcpAgentAccessConfigured: true } }).where(eq(toolConnections.id, connectionId));
      await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization", status: "active", isDefault: true });
      await db.insert(toolCatalogEntries).values({ companyId, applicationId, connectionId, name: "read", toolName: "read", versionHash: "fixture", riskLevel: "read", isReadOnly: true });
      outer = client => connectionIntentService(client).complete(pending.interactionId!, connectionId, userId, { canManageOrganizationGrant: true });
    }
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: `app:${connectionId}`, name: "Shared fixture profile", defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "company", targetId: companyId });
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(toolApplications).where(eq(toolApplications.id, applicationId)).for("update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const run = (work: (client: Db) => Promise<unknown>) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids.push(Number(row.pid));
      return work(tx as unknown as Db);
    });
    const waitForLock = (index: number) => vi.waitFor(async () => {
      expect(pids.length).toBeGreaterThan(index);
      const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pids[index]}`);
      expect(row.wait_event_type).toBe("Lock");
    }, { timeout: 5000 });
    const direct = run(client => toolAccessService(client).putConnectionInstalls(connectionId, { installs: [{ targetType: "agent", targetId: peerId }] }));
    let nested: Promise<unknown> | undefined;
    try {
      await waitForLock(0);
      nested = run(outer);
      await waitForLock(1);
    } finally { release(); await blocker; }
    const results = await Promise.allSettled([direct, nested]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await toolAccessService(db).listConnectionInstalls(connectionId, companyId)).map(install => install.targetId).sort()).toEqual([agentId, peerId].sort());
    if (caller === "connection intent") expect((results[1] as PromiseFulfilledResult<{ status: string }>).value.status).toBe("accepted");
  }, 15000);
  it("journals a personal grant delegation only for its target agent", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active" });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
    const before = await events();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    expect((await events()).slice(before.length).map(event => event.resourceId)).toEqual([agentId]);
  });
  it("limits delegation creation to its target without waiting on unrelated agents", async () => {
    await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, status: "active" })));
    const grants = await db.insert(connectionGrants).values(["alice", "bob"].map(subjectUserId => ({ companyId, connectionId, kind: "user", subjectUserId }))).returning();
    const baseline = await events();
    const [lower, higher] = [agentId, peerId].sort();
    let locked!: () => void; let release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, lower)).for("no key update");
      locked(); await resume;
    });
    await held;
    const pids: number[] = [];
    const saves = grants.map((grant, index) => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      pids[index] = Number(row.pid);
      return toolAccessService(tx as unknown as Db).createConnectionGrantDelegation(connectionId, grant.id, index === 0 ? higher : lower, grant.subjectUserId!);
    }));
    const completed = Promise.allSettled(saves);
    try {
      await expect(saves[0]).resolves.toMatchObject({ agentId: higher });
      expect((await events()).slice(baseline.length).map(event => event.resourceId)).toEqual([higher]);
      await vi.waitFor(async () => {
        expect(pids).toHaveLength(2);
        const rows = await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE pid = ${pids[1]} AND wait_event_type = 'Lock'`);
        expect(rows).toHaveLength(1);
      }, { timeout: 5000 });
    } finally { release(); await blocker; }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.companyId, companyId))).toHaveLength(2);
    const before = await events();
    expect(before.slice(baseline.length).map(event => event.resourceId).sort()).toEqual([lower, higher]);
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grants[0].id, higher, grants[0].subjectUserId!);
    expect(await events()).toEqual(before);
  }, 15000);
  it("orders grant revocation with a concurrent delegation creation", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", status: "active" });
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice" }).returning();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayCreate = new Promise<void>(resolve => { resume = resolve; });
    const revokerStarted = new Promise<number>(resolve => { started = resolve; });
    const creation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)).for("update");
      locked(); await mayCreate;
      return toolAccessService(tx as unknown as Db).createConnectionGrantDelegation(connectionId, grant.id, peerId, "alice");
    });
    await held;
    const revocation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return toolAccessService(tx as unknown as Db).revokeConnectionGrant(connectionId, grant.id);
    });
    const completed = Promise.allSettled([creation, revocation]);
    try {
      const pid = await revokerStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toEqual([]);
    await expect(toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, peerId, "alice")).rejects.toThrow("Only the active personal grant owner");
  }, 15000);
  it.each((["suspended", "archived"] as const).flatMap(status => (["revocation", "settings"] as const).map(writer => ({ status, writer }))))("orders membership $status cleanup with concurrent $writer", async ({ status, writer }) => {
    await db.update(toolConnections).set({ config: { url: "https://mcp.example.test/mcp" } }).where(eq(toolConnections.id, connectionId));
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    const [member] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", membershipRole: "member", status: "active" }).returning();
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: "cleanup", name: "Cleanup fixture" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "cleanup", name: "Cleanup fixture", scope: "user", ownerUserId: "alice", userSecretDefinitionId: definition.id }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice", credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }] }).returning();
    await toolAccessService(db).createConnectionGrantDelegation(connectionId, grant.id, agentId, "alice");
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayRevoke = new Promise<void>(resolve => { resume = resolve; });
    const cleanupStarted = new Promise<number>(resolve => { started = resolve; });
    const revocation = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      if (writer === "revocation") await tx.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)).for("update");
      else await tx.select().from(toolConnections).where(eq(toolConnections.id, connectionId)).for("update");
      locked(); await mayRevoke;
      const service = toolAccessService(tx as unknown as Db, { remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
      return writer === "revocation" ? service.revokeConnectionGrant(connectionId, grant.id) : service.updateConnection(connectionId, { name: "Concurrent settings" });
    });
    await held;
    const cleanup = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      const service = accessService(tx as unknown as Db);
      return status === "suspended" ? service.updateMember(companyId, member.id, { status }) : service.archiveMember(companyId, member.id);
    });
    const completed = Promise.allSettled([revocation, cleanup]);
    try {
      const pid = await cleanupStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)))[0].status).toBe(status);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0].status).toBe("revoked");
    expect(await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toEqual([]);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id))).toEqual([]);
    if (writer === "settings") expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0].name).toBe("Concurrent settings");
  }, 15000);
  it("orders audience replacement after membership cleanup without reversing grant locks", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    const members = await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, membershipRole: "member", status: "active" }))).returning();
    const member = members.find(row => row.principalId === "alice")!;
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: "audience", name: "Audience fixture" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "audience", name: "Audience fixture", scope: "user", userSecretDefinitionId: definition.id, ownerUserId: "alice" }).returning();
    await db.insert(connectionGrants).values({ companyId, connectionId, kind: "user", subjectUserId: "alice", credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }] });
    const [organization] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization", isDefault: true }).returning();
    await db.insert(connectionGrantMembers).values({ companyId, grantId: organization.id, subjectType: "user", subjectId: "alice" });
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const maySuspend = new Promise<void>(resolve => { resume = resolve; });
    const audienceStarted = new Promise<number>(resolve => { started = resolve; });
    const cleanup = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)).for("update");
      locked(); await maySuspend;
      return accessService(tx as unknown as Db).updateMember(companyId, member.id, { status: "suspended" });
    });
    await held;
    const replacement = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      return toolAccessService(tx as unknown as Db).replaceConnectionGrantMembers(connectionId, organization.id, ["bob"]);
    });
    const completed = Promise.allSettled([cleanup, replacement]);
    try {
      const pid = await audienceStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); }
    expect((await completed).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)))[0].status).toBe("suspended");
    expect((await db.select().from(connectionGrantMembers).where(eq(connectionGrantMembers.grantId, organization.id))).map(row => row.subjectId)).toEqual(["bob"]);
  }, 15000);
  it("invalidates only the owner of an agent secret binding", async () => {
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "binding", name: "Binding fixture" }).returning();
    const before = (await events()).length;
    const [binding] = await db.insert(companySecretBindings).values({ companyId, secretId: secret.id, targetType: "agent", targetId: agentId, configPath: "env.FIXTURE" }).returning();
    await db.update(companySecretBindings).set({ versionSelector: "2" }).where(eq(companySecretBindings.id, binding.id));
    await db.delete(companySecretBindings).where(eq(companySecretBindings.id, binding.id));
    expect((await events()).slice(before).map(event => event.resourceId)).toEqual([agentId, agentId, agentId]);
  });
  it("allows an agent configuration save to finish while a connector refresh waits on that agent", async () => {
    const higher = [agentId, peerId].sort().at(-1)!;
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "concurrent", name: "Concurrent fixture" }).returning();
    await db.insert(companySecretBindings).values({ companyId, secretId: secret.id, targetType: "agent", targetId: higher, configPath: "env.FIXTURE" });
    let locked!: () => void; let resume!: () => void; let started!: (pid: number) => void;
    const agentLocked = new Promise<void>(resolve => { locked = resolve; });
    const maySave = new Promise<void>(resolve => { resume = resolve; });
    const connectorStarted = new Promise<number>(resolve => { started = resolve; });
    const save = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      await tx.select().from(agents).where(eq(agents.id, higher)).for("update");
      locked(); await maySave;
      await updateAgentConfigurationInTransaction(tx as unknown as Db, higher, { adapterConfig: { env: {} } });
    });
    await agentLocked;
    const connector = db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      started(Number(row.pid));
      await tx.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connectionId));
    });
    try {
      const pid = await connectorStarted;
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
        expect(row.wait_event_type).toBe("Lock");
      }, { timeout: 5000 });
    } finally { resume(); await Promise.all([save, connector]); }
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, higher))).toEqual([]);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId)))[0].enabled).toBe(false);
  }, 15000);
  it("captures grant revocation and referenced credential rotation without storing credentials in events", async () => {
    const [secret] = await db.insert(companySecrets).values({ companyId, key: "fixture", name: "Fixture secret" }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId, kind: "organization", credentialSecretRefs: [{ secretId: secret.id, configPath: "token" }] }).returning();
    const before = (await events()).length;
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, secret.id));
    expect(await events()).toHaveLength(before + 2);
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, grant.id));
    expect(await events()).toHaveLength(before + 4);
    expect(Object.keys((await events()).at(-1)!).sort()).toEqual(["action", "companyId", "createdAt", "id", "resourceId", "resourceType"]);
    const unrelated = await db.insert(companySecrets).values({ companyId, key: "unrelated", name: "Unrelated" }).returning();
    const unchanged = (await events()).length;
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, unrelated[0].id));
    expect(await events()).toHaveLength(unchanged);
  });

});
