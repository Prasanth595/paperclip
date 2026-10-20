"""Flag-only bridge payload. No credentials, signals, writes, or hold changes.

Integration owner supplies its existing scoped client and an operator-reviewed
inventory of exact executable paths. This module is not a scheduler or CLI.
"""
import datetime as dt
import os
import re
import subprocess
import sys


def observe_process(pid):
    """Darwin comm contains executable identity; never request args/command."""
    if sys.platform != 'darwin' or type(pid) is not int or pid <= 0:
        return None
    try:
        result = subprocess.run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'lstart=', '-o', 'comm='],
            capture_output=True, text=True, timeout=2, check=True,
            env={**os.environ, 'LC_ALL': 'C'})
        if len(result.stdout) > 16384 or len(result.stdout.strip().splitlines()) != 1:
            return None
        parts = result.stdout.strip().split(None, 5)
        if len(parts) != 6 or not parts[5].startswith('/'):
            return None
        birth = dt.datetime.strptime(' '.join(parts[:5]), '%a %b %d %H:%M:%S %Y').astimezone()
        return {'pid': pid, 'startedAt': birth.isoformat(), 'executable': parts[5]}
    except Exception:
        # Neither subprocess error strings nor stdout/stderr may escape.
        return None


def instant(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo is not None else None
    except ValueError:
        return None


def diagnose(client, issue, wakes, expected_executables, observe=observe_process, local_process_runs=frozenset()):
    """Current blocker is source authority; wake.runId is NOT the source run.

    Historical refusals with no current blocker cannot identify a source safely.
    Bounded/truncated wake diagnostics do not certify an absence of refusals.
    """
    result = {'apiWrites': 0, 'coverage': 'bounded_refusals_current_blocker_darwin',
              'inspectionComplete': wakes.get('truncated') is False, 'findings': []}
    iid, company = issue.get('id'), issue.get('companyId')
    valid_id = lambda value: isinstance(value, str) and re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', value) is not None
    if not valid_id(iid) or not valid_id(company) or wakes.get('issue', {}).get('id') != iid:
        return {**result, 'inspectionComplete': False, 'findings': [{'action': 'inspect', 'reason': 'scope_unverified'}]}
    base = {'issueId': iid, 'companyId': company}
    def finding(reason, action='inspect', run_id=None):
        result['findings'].append({**base, 'sourceBinding': 'current_execution_blocker', **({'sourceRunId': run_id} if run_id else {}),
                                   'action': action, 'reason': reason})
        if action == 'inspect':
            result['inspectionComplete'] = False
        return result
    events = wakes.get('events')
    if not isinstance(events, list):
        return finding('wake_inventory_unavailable')
    if not any(e.get('kind') == 'wake_request' and e.get('reason') == 'execution_reconciliation_required' for e in events if isinstance(e, dict)):
        return result
    blocker = issue.get('executionBlocker') or {}
    source = blocker.get('runId')
    if not valid_id(source):
        return finding('historical_source_unavailable')
    try:
        run = client.get('/api/heartbeat-runs/' + source)
    except Exception:
        return finding('source_run_unavailable', run_id=source)
    bound_issue = run.get('nativeIssueId') or run.get('issueId') or (run.get('contextSnapshot') or {}).get('issueId')
    if run.get('id') != source or run.get('companyId') != company or bound_issue != iid:
        return finding('source_scope_mismatch')
    # Without target-kind proof, a sandbox PID must not be observed on the host.
    # Integration supplies this from existing environment/lease inventory.
    if (company, source) not in local_process_runs:
        return finding('process_target_unverified', run_id=source)
    pid, recorded = run.get('processPid'), instant(run.get('processStartedAt'))
    if type(pid) is not int or pid <= 0 or recorded is None:
        return finding('process_identity_missing', run_id=source)
    if not expected_executables or any(not isinstance(p, str) or not p.startswith('/') for p in expected_executables):
        return finding('executable_inventory_missing', run_id=source)
    try:
        first, second = observe(pid), observe(pid)
    except Exception:
        return finding('process_observation_unavailable', run_id=source)
    if not first or first != second or first.get('pid') != pid:
        return finding('process_observation_unstable', run_id=source)
    observed, executable = instant(first.get('startedAt')), first.get('executable')
    if observed is None or not isinstance(executable, str) or not executable.startswith('/'):
        return finding('process_observation_unavailable', run_id=source)
    # Exact executable membership, never substring/argv matching. A wrapper
    # outside the inventory is a flag for inspection, not proof of safe release.
    if executable not in expected_executables:
        return finding('unexpected_executable_new_birth' if observed > recorded else 'unexpected_executable', 'flag', source)
    if observed > recorded:
        return finding('expected_executable_new_birth', 'flag', source)
    return result
