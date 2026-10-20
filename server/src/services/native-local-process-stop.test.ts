import type { Db, heartbeatRuns } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectHeartbeatRunProcessIdentity, recordNativeLocalProcessStop } from "./native-local-process-stop.js";
import * as identity from "./local-process-identity.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
vi.mock("./heartbeat-run-events.js", () => ({ appendHeartbeatRunEvent: vi.fn(async () => undefined) }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(appendHeartbeatRunEvent).mockReset(); });
const run = { id: "run", companyId: "company", agentId: "agent", runtimeMode: "native",
  processPid: 123, processGroupId: 123, processStartedAt: new Date() } as typeof heartbeatRuns.$inferSelect;
function database(providers: string[]) {
  return { select: () => ({ from: () => ({ where: async () => providers.map(provider => ({ provider })) }) }) } as unknown as Db;
}
describe("native local stop evidence", () => {
  it.each([{ providers: [] }, { providers: [undefined] }, { providers: ["local", undefined] }])("does not probe absent or incomplete inventory: $providers", async ({ providers }) => {
    const inspect = vi.spyOn(identity, "inspectLocalProcessIdentity");
    const db = database(providers as string[]);
    expect((await inspectHeartbeatRunProcessIdentity(db, run)).mayBeOwned).toBe(true);
    expect(await recordNativeLocalProcessStop(db, run)).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
    expect(appendHeartbeatRunEvent).not.toHaveBeenCalled();
  });

  it("never probes remote IDs in the host namespace or writes a local receipt", async () => {
    const inspect = vi.spyOn(identity, "inspectLocalProcessIdentity");
    expect((await inspectHeartbeatRunProcessIdentity(database(["daytona"]), run)).mayBeOwned).toBe(true);
    expect(await recordNativeLocalProcessStop(database(["daytona"]), run)).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
    expect(appendHeartbeatRunEvent).not.toHaveBeenCalled();
  });
  it("retains a mixed local/remote scope", async () => {
    const inspect = vi.spyOn(identity, "inspectLocalProcessIdentity");
    expect((await inspectHeartbeatRunProcessIdentity(database(["local", "daytona"]), run)).mayBeOwned).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  });
  it("does not record stop for descendants or unreadable ownership", async () => {
    vi.spyOn(identity, "inspectLocalProcessIdentity").mockResolvedValue({ pidMayBeOwned: false, groupMayBeOwned: true, reused: false, mayBeOwned: true });
    expect(await recordNativeLocalProcessStop(database(["local"]), run)).toBe(false);
    expect(appendHeartbeatRunEvent).not.toHaveBeenCalled();
  });
  it("records the old generation's stop and propagates receipt failure for transaction rollback", async () => {
    vi.spyOn(identity, "inspectLocalProcessIdentity").mockResolvedValue({ pidMayBeOwned: false, groupMayBeOwned: false, reused: true, mayBeOwned: false });
    expect(await recordNativeLocalProcessStop(database(["local"]), run)).toBe(true);
    expect(appendHeartbeatRunEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ companyId: run.companyId, runId: run.id, eventType: "native.local_process_stopped" }));
    vi.mocked(appendHeartbeatRunEvent).mockRejectedValueOnce(new Error("receipt storage failed"));
    await expect(recordNativeLocalProcessStop(database(["local"]), run)).rejects.toThrow("receipt storage failed");
  });
});
