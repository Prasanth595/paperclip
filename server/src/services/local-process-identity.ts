import { execFile } from "node:child_process";
import { readProcessStartedAt } from "./hot-restart.js";

type RecordedProcess = {
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
};
export type ProcessObservation = { pid: number; groupId: number; executable: string };
type Probe = "present" | "absent" | "unknown";
export type LocalProcessIdentityDependencies = {
  platform: NodeJS.Platform;
  probe: (id: number) => Probe;
  birth: (pid: number) => Promise<string | null>;
  observe: (pid: number) => Promise<ProcessObservation | null>;
};

function probe(id: number): Probe {
  if (!Number.isSafeInteger(id) || id === 0) return "unknown";
  try { process.kill(id, 0); return "present"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown"; }
}

/** Read executable identity only, never argv (which can contain credentials). */
export function readLocalProcessCommand(pid: number): Promise<ProcessObservation | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      execFile("ps", ["-ww", "-p", String(pid), "-o", "pid=,pgid=,comm="],
        { encoding: "utf8", timeout: 1500, maxBuffer: 16 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(null);
          const match = /^\s*(\d+)\s+(\d+)\s+([^\r\n]+)\s*$/.exec(stdout);
          if (!match || Number(match[1]) !== pid || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0)
            return resolve(null);
          const executable = match[3].trim();
          resolve(executable ? { pid, groupId: Number(match[2]), executable } : null);
        });
    } catch {
      // Spawn can throw before registering its callback (for example EPERM).
      resolve(null);
    }
  });
}

/**
 * Read-only negative ownership evidence, never permission to signal a process.
 * Missing identity and all errors except ESRCH retain ownership. Birth times
 * must be strictly newer: older/invalid clocks cannot establish PID reuse.
 *
 * POSIX fork forbids allocating a PID matching any active process-group ID:
 * https://pubs.opengroup.org/onlinepubs/9799919799/functions/fork.html
 * Thus verified reuse of the original group leader proves the OLD group ended,
 * even if a new group now uses that number. This does not apply to a non-leader
 * PID or to a group with surviving descendants and no replacement leader.
 */
export async function inspectLocalProcessIdentity(
  run: RecordedProcess,
  deps: LocalProcessIdentityDependencies = {
    platform: process.platform, probe, birth: readProcessStartedAt, observe: readLocalProcessCommand,
  },
) {
  if ([run.processPid, run.processGroupId].some(id => id !== null && (!Number.isSafeInteger(id) || id <= 0)))
    return { pidMayBeOwned: true, groupMayBeOwned: true, reused: false, mayBeOwned: true };
  const pidState = run.processPid === null ? "absent" : deps.probe(run.processPid);
  const groupState = run.processGroupId === null ? "absent" : deps.probe(-run.processGroupId);
  let pidMayBeOwned = pidState !== "absent";
  let groupMayBeOwned = groupState !== "absent";
  let reused = false;
  const recordedBirth = run.processStartedAt?.getTime();
  if (pidState === "present" && run.processPid && Number.isFinite(recordedBirth)
      && ["darwin", "linux", "freebsd", "openbsd"].includes(deps.platform)) {
    try {
      const before = Date.parse(await deps.birth(run.processPid) ?? "");
      // Same birth (including sub-second ambiguity) never proves replacement.
      if (Number.isFinite(before) && before > recordedBirth!) {
        const first = await deps.observe(run.processPid);
        const second = await deps.observe(run.processPid);
        const after = Date.parse(await deps.birth(run.processPid) ?? "");
        if (first && second && first.pid === run.processPid && second.pid === first.pid
            && first.groupId > 0 && second.groupId === first.groupId
            && first.executable.trim() && second.executable === first.executable
            && after === before && deps.probe(run.processPid) === "present") {
          reused = true;
          pidMayBeOwned = false;
          // EPERM/unknown group observations remain held even with a new leader.
          if (groupState === "present" && run.processGroupId === run.processPid)
            groupMayBeOwned = false;
        }
      }
    } catch { /* Unknown identity is not stop evidence. */ }
  }
  return { pidMayBeOwned, groupMayBeOwned, reused,
    mayBeOwned: pidMayBeOwned || groupMayBeOwned };
}
