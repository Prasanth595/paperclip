import * as childProcess from "node:child_process";
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectLocalProcessIdentity, type LocalProcessIdentityDependencies } from "./local-process-identity.js";

afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(childProcess.execFile).mockImplementation(actual.execFile);
});

const run = { processPid: 40250, processGroupId: 40250, processStartedAt: new Date("2026-10-15T18:59:00Z") };
function fixture() {
  return {
    platform: "darwin" as const,
    probe: vi.fn<LocalProcessIdentityDependencies["probe"]>(() => "present"),
    birth: vi.fn(async () => "2026-10-16T12:20:00Z"),
    observe: vi.fn(async () => ({ pid: 40250, groupId: 40250, executable: "/System/Library/MigrationSubscriber.xpc" })),
  };
}
describe("local process generation evidence", () => {
  it.each(["/System/Library/MigrationSubscriber.xpc", "/usr/local/bin/codex"])("rejects a verified newer group generation: %s", async executable => {
    const deps = fixture(); deps.observe.mockResolvedValue({ pid: 40250, groupId: 40250, executable });
    expect(await inspectLocalProcessIdentity(run, deps)).toMatchObject({ mayBeOwned: false, reused: true });
  });
  it("retains the original provider and group", async () => {
    const deps = fixture(); deps.birth.mockResolvedValue(run.processStartedAt.toISOString());
    expect(await inspectLocalProcessIdentity(run, deps)).toMatchObject({ mayBeOwned: true, reused: false });
  });
  it("preserves descendants when the original leader exited", async () => {
    const deps = fixture(); deps.probe.mockImplementation(id => id > 0 ? "absent" : "present");
    expect(await inspectLocalProcessIdentity(run, deps)).toMatchObject({ pidMayBeOwned: false, groupMayBeOwned: true });
    expect(deps.birth).not.toHaveBeenCalled();
  });
  it("does not infer group generation from a non-leader PID", async () => {
    expect(await inspectLocalProcessIdentity({ ...run, processGroupId: 40000 }, fixture()))
      .toMatchObject({ pidMayBeOwned: false, groupMayBeOwned: true });
  });
  it.each(["pid", "group"])("preserves EPERM/unknown %s observation", async target => {
    const deps = fixture(); deps.probe.mockImplementation(id => (target === "pid" ? id > 0 : id < 0) ? "unknown" : "present");
    expect((await inspectLocalProcessIdentity(run, deps)).mayBeOwned).toBe(true);
  });
  it.each([null, new Date(NaN)])("preserves missing or invalid persisted birth %s", async processStartedAt => {
    expect((await inspectLocalProcessIdentity({ ...run, processStartedAt }, fixture())).mayBeOwned).toBe(true);
  });
  it.each(["birth_error", "command_error", "birth_race", "command_race", "old_birth", "invalid_birth", "missing_command"])("fails closed for %s", async scenario => {
    const deps = fixture();
    if (scenario === "birth_error") deps.birth.mockRejectedValue(new Error("EPERM"));
    if (scenario === "command_error") deps.observe.mockRejectedValue(new Error("EPERM"));
    if (scenario === "birth_race") deps.birth.mockResolvedValueOnce("2026-10-16T12:20:00Z").mockResolvedValueOnce("2026-10-16T12:21:00Z");
    if (scenario === "command_race") deps.observe.mockResolvedValueOnce({ pid: 40250, groupId: 40250, executable: "/bin/a" });
    if (scenario === "old_birth") deps.birth.mockResolvedValue("2026-10-14T12:20:00Z");
    if (scenario === "invalid_birth") deps.birth.mockResolvedValue("invalid");
    if (scenario === "missing_command") deps.observe.mockResolvedValue({ pid: 40250, groupId: 40250, executable: "" });
    expect((await inspectLocalProcessIdentity(run, deps)).mayBeOwned).toBe(true);
  });
  it("does not apply POSIX group evidence on unsupported platforms", async () => {
    expect((await inspectLocalProcessIdentity(run, { ...fixture(), platform: "win32" })).mayBeOwned).toBe(true);
  });
  it("accepts absence only from the observation contract", async () => {
    const deps = fixture(); deps.probe.mockReturnValue("absent");
    expect((await inspectLocalProcessIdentity(run, deps)).mayBeOwned).toBe(false);
    expect(deps.observe).not.toHaveBeenCalled();
  });
});

describe("host observation boundary", () => {
  it("resolves null when spawn throws synchronously", async () => {
    const { readLocalProcessCommand } = await import("./local-process-identity.js");
    vi.spyOn(childProcess, "execFile").mockImplementation(() => {
      throw Object.assign(new Error("spawn denied"), { code: "EPERM" });
    });
    await expect(readLocalProcessCommand(process.pid)).resolves.toBeNull();
  });

  it.each([false, true])("honors the callback observation contract (denied: %s)", async denied => {
    const { readLocalProcessCommand } = await import("./local-process-identity.js");
    vi.spyOn(childProcess, "execFile").mockImplementation((...args: any[]) => {
      args.at(-1)(denied ? new Error("denied") : null, "123 123 /bin/provider\n", "");
      return {} as childProcess.ChildProcess;
    });
    await expect(readLocalProcessCommand(123)).resolves.toEqual(denied ? null : {
      pid: 123, groupId: 123, executable: "/bin/provider",
    });
  });

  it.skipIf(!["darwin", "linux", "freebsd", "openbsd"].includes(process.platform))(
    "reads only the test process executable and group without signalling it", async context => {
      const { readLocalProcessCommand } = await import("./local-process-identity.js");
      const observed = await readLocalProcessCommand(process.pid);
      if (observed === null) context.skip("Host ps observation unavailable; deterministic observer tests still apply");
      expect(observed?.pid).toBe(process.pid);
      expect(observed?.groupId).toBeGreaterThan(0);
      expect(observed?.executable.length).toBeGreaterThan(0);
    });
});
