# Flag-only process identity diagnostic payload

`stall_process_identity.py` is an integration payload for the existing bridge
watchdog, not an installed job. Its owner supplies the existing scoped client,
issue, wake diagnostics, exact allowed executable paths, and a set of
`(companyId, runId)` pairs independently verified to use the local host. No default
local assumption is permitted. Missing inventory produces an inspection finding.

Supported reads are `GET /api/issues/{id}`, its `/diagnostics/wakes`, and
`GET /api/heartbeat-runs/{sourceRunId}`. The source is the **current** issue
`executionBlocker.runId`, checked against company and native/context issue binding.
A wake's `runId` is not inferred to be the refused source. Historical refusals
without a current blocker are explicitly uncovered; bounded wake history cannot
prove absence. The report identifies this current-blocker binding and never claims
that an old refusal has been causally linked to it.

The Darwin observer reads only `lstart` and `comm`, twice, with bounded subprocess
timeouts. The report contains IDs and categories, never executable paths, argv,
stdout, stderr, or exception messages. Exact executable membership flags unexpected
paths, including unregistered wrappers, for inspection only. It grants no authority
to kill, clear metadata, release a lease, bypass a hold, or launch a provider.

Integration remains with the owner of `stall_host.py`. Extend its read allowlist
only after verifying the API used to certify local target scope. Do not synthesize
that scope from absent leases or current agent settings. Until that inventory and
the executable inventory are wired, this payload remains unactivated.

```sh
python3 -m unittest discover -s scripts/watchdog -p 'test_stall_process_identity.py'
```

Fixture tests do not qualify host integration, scheduling, or 24-hour acceptance.
