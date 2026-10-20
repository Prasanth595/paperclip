import unittest
from stall_process_identity import diagnose

C='11111111-1111-1111-1111-111111111111'
I='22222222-2222-2222-2222-222222222222'
R='33333333-3333-3333-3333-333333333333'
class Client:
    def __init__(self, run): self.run=run; self.reads=[]
    def get(self, path): self.reads.append(path); return self.run

class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.issue={'id':I,'companyId':C,'executionBlocker':{'runId':R}}
        self.wakes={'issue':{'id':I},'truncated':False,'events':[{'kind':'wake_request','reason':'execution_reconciliation_required','runId':'not-the-source'}]}
        self.run={'id':R,'companyId':C,'contextSnapshot':{'issueId':I},'processPid':40250,'processStartedAt':'2026-10-15T18:59:00Z'}
        self.obs={'pid':40250,'startedAt':'2026-10-16T12:20:00Z','executable':'/System/Library/MigrationSubscriber.xpc'}
        self.client=Client(self.run)
        self.local={(C,R)}
    def check(self, observe=None):
        return diagnose(self.client,self.issue,self.wakes,{'/usr/local/bin/codex'},observe or (lambda pid: self.obs),self.local)
    def test_mismatch_is_categorical_and_read_only(self):
        self.obs['executable']='/private/secret-token/not-codex'
        result=self.check()
        self.assertEqual(result['findings'][0]['reason'],'unexpected_executable_new_birth')
        self.assertNotIn('secret-token',str(result));self.assertEqual(result['apiWrites'],0)
        self.assertEqual(self.client.reads,['/api/heartbeat-runs/'+R])
    def test_same_executable_different_birth(self):
        self.obs['executable']='/usr/local/bin/codex'
        self.assertEqual(self.check()['findings'][0]['reason'],'expected_executable_new_birth')
    def test_original_identity(self):
        self.obs.update(executable='/usr/local/bin/codex',startedAt=self.run['processStartedAt'])
        self.assertEqual(self.check()['findings'],[])
    def test_missing_source_does_not_use_wake_run(self):
        self.issue['executionBlocker']=None
        self.assertEqual(self.check()['findings'][0]['reason'],'historical_source_unavailable')
        self.assertEqual(self.client.reads,[])
    def test_remote_or_unknown_target_is_not_observed(self):
        for target in [None,'remote']:
            self.local=set()
            self.assertEqual(self.check(lambda _: self.fail('host probe'))['findings'][0]['reason'],'process_target_unverified')
    def test_scope_mismatch(self):
        self.run['companyId']=I
        self.assertEqual(self.check(lambda _: self.fail('host probe'))['findings'][0]['reason'],'source_scope_mismatch')
    def test_missing_birth(self):
        self.run['processStartedAt']=None
        self.assertFalse(self.check()['inspectionComplete'])
    def test_read_error_is_sanitized(self):
        def observe(_): raise OSError('token=secret')
        result=self.check(observe); self.assertNotIn('secret',str(result));self.assertFalse(result['inspectionComplete'])
    def test_observation_race(self):
        observations=iter([self.obs,{**self.obs,'startedAt':'2026-10-16T12:21:00Z'}])
        self.assertFalse(self.check(lambda _:next(observations))['inspectionComplete'])
    def test_truncated_absence_is_not_certified(self):
        self.wakes.update(events=[],truncated=True)
        self.assertFalse(self.check()['inspectionComplete']);self.assertEqual(self.client.reads,[])

if __name__=='__main__':unittest.main()
