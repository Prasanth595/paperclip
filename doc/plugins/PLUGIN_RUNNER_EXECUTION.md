# Plugin-provided Runner execution

## Contract sources

- [Operations, results, and validation](../../packages/plugins/sdk/src/environment-tasks.ts)
- [Lease and worker types](../../packages/plugins/sdk/src/protocol.ts)
- [Shared execution driver](../../packages/paperclip-runner/src/control-plane/runner-execution-driver.ts)

```ts
import type {
  PluginEnvironmentTaskOperation as Operation,
  PluginEnvironmentTaskResult as Result,
  PluginEnvironmentTaskParams as Params,
} from "@paperclipai/plugin-sdk";

type Request<K extends Operation["kind"]> = Extract<Operation, { kind: K }>;
type Response<K extends Result["kind"]> = Extract<Result, { kind: K }>;
type TaskHook = (params: Params) => Promise<Result>;
```

| Owner | Responsibility |
| --- | --- |
| Core | Company and project authorization; execution identity; tool authority; PRP journal |
| Plugin | Task identity; installed runtime and account; process lifecycle; authenticated WSS endpoint |
| Runner | Provider execution; local resource paths; PRP session state |
| Separate storage workflow | Resource installation; file upload and download; backup |

The task API has no shell, file-copy, path-discovery, or resource-sync operation.
The plugin can use an HTTP Launcher API, a process API, or another implementation.
Core uses the same task contract in each case.

## Enable the driver

1. Add these declarations to the plugin manifest.

```json
{
  "capabilities": ["environment.drivers.register"],
  "environmentDrivers": [{ "driverKey": "runner", "supportsTasks": true }]
}
```

2. Implement these worker hooks.

```ts
onEnvironmentAcquireLease
onEnvironmentTask // TaskHook
onEnvironmentReleaseLease
onEnvironmentDestroyLease

// Task execution does not require these hooks:
onEnvironmentExecute
onEnvironmentRealizeWorkspace
```

3. Select the saved environment for an agent with `adapterType: "paperclip_runner"`.

```ts
const support = {
  lifecycle: "per_turn",
  providers: ["codex", "opencode", "acpx"],
  setupVerification: "Runner hello probe",
  warmProcessRetention: false,
  workspaceFreeDot: false,
};
```

OpenCode and ACPX require qualified launch profiles on the Runner host.
Use a Runner build that supports the following PRP inputs.

```ts
const requiredRunnerInputs = {
  "provider.runtimeOwnership": "agent_home",
  "provider.opencodePermissionMode": "allow | ask | deny",
  "runner.suspend.includeStateReceipt": true,
  "run.attach.paperclipNextAuthority.connection.mode": "retain",
};
```

## Prepare the environment

1. Install the Runner and the selected provider runtime.
2. Prepare the agent home, project workspace, and selected account before task submission.
3. Keep file transfer outside `onEnvironmentTask`.
4. Keep credential refresh and backup outside the per-run execution workflow.

```ts
// Runner-local configuration. Core does not supply these paths.
const environment = {
  AGENT_HOME: "<installed agent home>",
  PAPERCLIP_WORKSPACE_CWD: "<installed project workspace>",
};

// Alternative: a Launcher-owned context file on the Runner host.
const launcherEnvironment = {
  PAPERCLIP_LAUNCHER_CONTEXT_PATH: "<local context file>",
};
```

```json
{
  "schema": "paperclip.launcher.context.v2",
  "resourcesRoot": "<installed agent home>",
  "workspace": "<installed project workspace>"
}
```

The Runner resolves instruction entries and assigned skill paths inside the installed agent home. It resolves `codex` through its local `PATH`. The installed launch profiles supply other provider executables.

```ts
const executionAuthority = {
  permissions: "Core -> PRP -> provider",
  assignedMcpTools: "provider -> PRP -> Core gateway",
  installedInstructions: "Runner reads on each new run",
  installedSkills: "Runner resolves -> provider",
  installedCodexAccount: "CODEX_HOME/auth.json or HOME/.codex/auth.json",
};
```

ACPX uses its existing private credential isolation for an installed Codex account. It reads the local account file when no explicit API key is configured. It does not send the account file to Core. Credential refresh remains part of the separate account workflow.

Keep Runner state and credential stores outside the writable agent home. Keep the selected model, permission policy, and assigned resource identities unchanged when you resume a provider session. Installed instruction text can change between runs.

A persistent computer keeps its agent home between runs. Core does not create a per-run copy or collect it after execution. Existing built-in ephemeral sandbox drivers keep their materialization and synchronization behavior.

## Acquire the task lease

1. Create an opaque task ID before submission.
2. Return that ID as `providerLeaseId`.
3. Keep the same ID after an ambiguous submission result.

```ts
const lease = {
  providerLeaseId: "attempt-opaque-id",
  metadata: {}, // No credentials.
};
```

```ts
// Core supplies this scope from saved records.
const params: Pick<Params,
  "companyId" | "environmentId" | "runId" | "agentId" | "projectIds" | "taskId"
> = {
  companyId: "<authorized company>",
  environmentId: "<saved environment>",
  runId: "<active run>",
  agentId: "<agent>",
  projectIds: ["<authorized project UUID>"],
  taskId: lease.providerLeaseId,
};
```

During setup, Core uses a private, expiring probe identity. During cleanup, `environmentId`, `runId`, and `agentId` can be `null` after record deletion. The saved lease retains the plugin identity.

## Operations

| Request `kind` | Response `kind` | Effect |
| --- | --- | --- |
| `describe` | `description` | Return the installed Runner artifact identity |
| `submit` | `accepted` | Start the saved task once |
| `connection` | `connection` | Return the current authenticated WSS endpoint |
| `status` | `status` | Read process and session-retention state |
| `credentials` | `credentials` | Read refreshed credentials after process termination |
| `stop` | `accepted` | Stop the task and its descendants |
| `complete` | `accepted` | Release task grants after confirmed termination |

### Artifact identity

```json
{ "kind": "describe" }
```

```json
{
  "kind": "description",
  "taskId": "attempt-opaque-id",
  "runner": {
    "version": "<installed Runner version>",
    "digest": "sha256:<64 lowercase hexadecimal characters>"
  }
}
```

Core binds the bootstrap ticket to this identity before launch. PRP authenticates the running artifact against that binding.

### Submission

```ts
const request: Request<"submit"> = {
  kind: "submit",
  projectIds: ["<project UUID>"],
  runner: {
    protocolMin: 1, protocolMax: 3,
    harness: "codex",
    runnerId: "runner-id", leaseId: "logical-lease-id", runId: "run-id",
    sessionId: "session-id", turnId: "turn-id", itemId: "item-id",
  },
  bootstrapTicket: "<transient secret>",
  credentialIdentity: "<Core-selected credential revision>", // Optional.
  accountIdentity: "<Core-selected account>", // Optional.
  credential: { type: "codex-auth-json", authJson: "<transient selected credential>" }, // Optional.
  resumeFrom: "<authorized prior task ID>", // Optional.
  launch: {
    runnerVersion: "<described version>",
    runnerDigest: "sha256:<described digest>",
    maxOutboxBytes: 262144, p0ReserveBytes: 65536,
    maxRuntimeMs: 0, reconnectGraceMs: 120000,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
  },
};
```

1. Install the selected credential through a dedicated provider API, when present.
2. Bind the task to `accountIdentity`. Use `credentialIdentity` for its current revision.
3. Reject the submission if the account does not match.
4. Pass the bootstrap ticket and Runner identity to the Runner unchanged.
5. Enforce the launch limits.
6. Return the same task ID.

```json
{ "kind": "accepted", "taskId": "attempt-opaque-id" }
```

`accepted` confirms submission. It does not confirm PRP readiness or provider authentication. Core verifies both through the Runner.

### Selected credentials

Core can send a Codex login file or one approved Claude authentication variable.
Credential values are transient RPC data.
Do not save them in the task journal, lease metadata, logs, or errors.
Use the account identity to prevent a change to a different account during retained execution.
A credential refresh can keep the same account identity.

After the task and its descendants stop, Core can send this request:

```json
{ "kind": "credentials", "accountIdentity": "<selected account>" }
```

Return the current credential only if the stopped task and credential slot have that account identity.
Core saves the selected grant, secret reference, and session generation on the lease.
It does not save credential values or temporary paths there.
After a restart, cleanup uses these references to complete the transfer.
Core compares account identities and refresh times before it saves a newer secret value.
An explicit account replacement or a revoked grant prevents an old refresh from overwriting that account.
Core acknowledges task completion only after this transfer succeeds.
Return `credential: null` only if cancellation prevented the task from starting.
An unavailable export must fail the operation.
A failed transfer keeps task grants available for recovery.
The Core native path supports direct Codex and Claude accounts.
Other managed provider routes require a dedicated credential projection before use.

### Connection

```json
{ "kind": "connection" }
```

```json
{
  "kind": "connection",
  "taskId": "attempt-opaque-id",
  "endpoint": {
    "kind": "authenticated_websocket",
    "websocketUrl": "wss://runner.example.test/task/connect",
    "generation": "opaque-endpoint-generation",
    "secretHeaders": [{ "name": "Authorization", "value": "Bearer <transient secret>" }]
  }
}
```

1. Return a `wss:` URL without credentials, query parameters, or a fragment.
2. Put transient access credentials in `secretHeaders`.
3. Return a new endpoint generation when the endpoint changes.
4. Keep credentials out of lease metadata, logs, and error messages.

Core can request `connection` again after a disconnect or credential expiry. The endpoint's acquisition mechanism, internal address, port, and proxy layout belong to the plugin.

### Status and termination

```json
{
  "kind": "status",
  "taskId": "attempt-opaque-id",
  "phase": "completed",
  "exitCode": 0,
  "executionStopped": true,
  "sessionStateAvailable": true
}
```

```ts
type Phase = "preparing" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

const settled = status.executionStopped === true;
const resumable = settled && status.sessionStateAvailable === true;
```

1. Set `executionStopped` to `true` only after the task and all descendants stop.
2. Keep `stop` and `complete` idempotent.
3. Record cancellation when `stop` arrives before `submit`.
4. Reject a late submission for that cancelled task ID.
5. Keep task grants until termination is confirmed.
6. Preserve retained session state when `complete` releases task grants.

A terminal phase or an accepted stop request is insufficient proof of termination. Core retains failed cleanup leases for retry.

## Session continuity

```text
Core journal                         Provider storage
------------                         ----------------
PRP identity and command results     Runner state and provider session files
        |                                      |
        +---- authenticated runner.suspend ----+
        +---- status.executionStopped ---------+
        +---- status.sessionStateAvailable ----+
        |
        +---- next submit.resumeFrom = prior task ID
        +---- PRP session identity verification
        +---- run.attach to the new run authority
```

1. Resume only the task named by `resumeFrom`.
2. Verify the retained account, session, and workspace before launch.
3. Fail closed if retained state is missing or incompatible.
4. Keep the retained files on the provider.

Core checks the prior run, agent, workspace, environment, pinned driver, and termination evidence before it authorizes reuse.
For recovery on the same run, Core first stops and releases the old tasks.
It checks each old lease's termination receipt before it allocates a replacement.
The new task uses `resumeFrom` to retain the saved PRP identity.
A failed stop prevents replacement. The Runner keeps the provider connection during the authenticated run-authority change. A pending, unproved transition blocks ordinary execution.

## Setup verification

```text
expiring probe lease
  -> describe
  -> submit with a bounded lifetime
  -> authenticated WSS + PRP
  -> provider hello + selected model
  -> suspension + confirmed process stop
  -> complete
```

The Runner checks local project authentication overrides before provider startup. Core does not run a shell probe or inspect guest configuration files.

## Verification

- [Lease, RPC, and cleanup integration](../../server/src/__tests__/plugin-runner-task.integration.test.ts)
- [Real Runner setup and retained-home tests](../../server/src/services/native-runtime/plugin-runner-probe.test.ts)
- [Durable credential transfer](../../server/src/__tests__/plugin-task-credential-writeback.test.ts)
- [Task ownership and cancellation](../../server/src/services/native-runtime/plugin-runner-task.test.ts)
- [Persistent runtime resource resolution](../../packages/paperclip-runner/runner/crates/runner-core/src/persistent_agent_runtime.rs)

The real Runner fixture uses a synthetic provider and local sockets. It does not certify a deployed plugin, live provider credentials, or a production WSS proxy.
