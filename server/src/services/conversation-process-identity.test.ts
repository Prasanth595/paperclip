import * as childProcess from "node:child_process";
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";
import * as hotRestart from "./hot-restart.js";

// Query scope has separate database coverage. Here the OS observations are
// deterministic and no process (including the incident PID) receives a signal.
function candidate(processGroupId: number | null) {
  const run = { id: "source-run", agentId: "agent", status: "cancelled",
    processPid: 40250, processGroupId, processStartedAt: new Date("2026-10-15T18:59:00Z"),
    resultJson: null };
  const rows = [{ run, activeLease: false }];
  const query = { from: () => query, where: () => query, orderBy: async () => rows };
  return { db: { select: () => query } as unknown as Db, run };
}

afterEach(() => vi.restoreAllMocks());
describe("persisted conversation process identity", () => {
  it.each([false, true])("rejects reused PID identity with persisted group=%s", async withGroup => {
    const { db } = candidate(withGroup ? 40250 : null);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal !== 0 || Math.abs(Number(pid)) !== 40250) throw new Error("Unexpected observation");
      return true;
    });
    vi.spyOn(hotRestart, "readProcessStartedAt").mockResolvedValue("2026-10-16T12:20:00Z");
    const command = vi.spyOn(childProcess, "execFile").mockImplementation((...args: any[]) => {
      args.at(-1)(null, "40250 40250 /System/Library/MigrationSubscriber.xpc\n", "");
      return {} as childProcess.ChildProcess;
    });

    expect(await getConversationOwnershipBlocker(db, "company", "issue")).toBeNull();
  });

  it.each(["matching", "unreadable"])("retains %s provider identity", async identity => {
    const { db, run } = candidate(null);
    vi.spyOn(process, "kill").mockReturnValue(true);
    const birth = vi.spyOn(hotRestart, "readProcessStartedAt");
    if (identity === "matching") birth.mockResolvedValue(run.processStartedAt.toISOString());
    else birth.mockRejectedValue(Object.assign(new Error("denied"), { code: "EPERM" }));
    expect(await getConversationOwnershipBlocker(db, "company", "issue"))
      .toMatchObject({ runId: "source-run", cause: "execution_owner_active" });
  });
});
