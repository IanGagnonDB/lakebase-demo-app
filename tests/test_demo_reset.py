"""Reset checkpoints, request exclusion and data scope without a workspace."""
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException


class DemoResetTests(unittest.TestCase):
    def setUp(self):
        self.db = types.ModuleType('db')
        for name in ('dbsql', 'pg', 'prod', 'w'):
            setattr(self.db, name, MagicMock())
        self.db.uc = lambda table: f'test.demo.{table}'
        self.ops = MagicMock()
        self.provision = MagicMock()
        self.provision.OPP_COLS = 'opportunity_id, name'
        self.provision.ACT_COLS = 'activity_id, notes'
        self.sync = MagicMock()
        self.sync.TAG = 'synced-tab-demo'
        self.sync._revision = 0
        spec = importlib.util.spec_from_file_location('demo_reset_test', Path(__file__).parents[1] / 'app/demo_reset.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, db=self.db, ops=self.ops, provision=self.provision, sync_demo=self.sync):
            spec.loader.exec_module(self.module)
        self.module._ready = True
        self.checkpoints = []
        self.db.pg.side_effect = self.persist

    def persist(self, sql, params=None):
        if params and 'state' in params:
            self.checkpoints.append(json.loads(params['state']))
        return []

    def fresh(self):
        return {'id': 'reset-1', 'status': 'running', 'steps': [
            {'label': label, 'status': 'pending'} for label in self.module.STEP_LABELS]}

    def test_request_access_releases_on_error_and_blocks_unfinished_resets(self):
        with self.assertRaises(ValueError), self.module.request_access():
            self.assertEqual(self.module._active, 1)
            raise ValueError('request failed')
        self.assertEqual(self.module._active, 0)
        for status in ('running', 'failed'):
            self.module._state = {'status': status}
            with self.assertRaises(HTTPException) as caught:
                with self.module.request_access():
                    pass
            self.assertEqual(caught.exception.status_code, 409)

    def test_provisioning_blocks_normal_requests_and_reset(self):
        self.module._ready = False
        for action in (self.module.start, self.module.status):
            with self.assertRaises(HTTPException) as caught:
                action()
            self.assertEqual(caught.exception.status_code, 503)
        with self.assertRaises(HTTPException):
            with self.module.request_access():
                pass

    def test_active_request_prevents_reset_and_duplicate_start_is_idempotent(self):
        with self.module.request_access(), self.assertRaises(HTTPException) as caught:
            self.module.start()
        self.assertEqual(caught.exception.status_code, 409)
        self.db.pg.assert_not_called()
        self.module._state = self.fresh()
        with patch.object(self.module.threading, 'Thread') as thread:
            self.assertEqual(self.module.start()['id'], 'reset-1')
            thread.assert_not_called()

    def test_worker_persists_progress_and_retries_only_failed_and_remaining_steps(self):
        actions = [MagicMock() for _ in self.module.ACTIONS]
        actions[2].side_effect = RuntimeError('Delta unavailable')
        self.module._state = self.fresh()
        with patch.object(self.module, 'ACTIONS', actions):
            self.module._run()
            self.assertEqual(self.module._state['status'], 'failed')
            self.assertEqual([s['status'] for s in self.module._state['steps']],
                             ['done', 'done', 'failed', 'pending', 'pending', 'pending'])
            actions[3].assert_not_called()
            self.assertTrue(any(s['steps'][0]['status'] == 'done' for s in self.checkpoints))
            actions[2].side_effect = None
            self.module._state = {**self.module._state, 'status': 'running', 'error': None}
            self.module._run()
        self.assertEqual(self.module._state['status'], 'succeeded')
        self.assertEqual([a.call_count for a in actions], [1, 1, 2, 1, 1, 1])
        self.assertTrue(all(s['status'] == 'done' for s in self.checkpoints[-1]['steps']))

    def test_failure_returns_generic_message_without_exception_text(self):
        actions = [MagicMock() for _ in self.module.ACTIONS]
        actions[1].side_effect = RuntimeError('TABLE_OR_VIEW_NOT_FOUND lakebase_demo.demo.activities')
        self.module._state = self.fresh()
        with patch.object(self.module, 'ACTIONS', actions), self.assertLogs(self.module.log, 'ERROR') as logs:
            self.module._run()
        state = self.module._state
        self.assertEqual(state['status'], 'failed')
        self.assertEqual(state['error'], f'Reset failed on step "{self.module.STEP_LABELS[1]}". Check the app logs and retry.')
        for text in (json.dumps(state), json.dumps(self.checkpoints)):
            self.assertNotIn('lakebase_demo', text)
            self.assertNotIn('TABLE_OR_VIEW_NOT_FOUND', text)
        self.assertIn('lakebase_demo', '\n'.join(logs.output))

    def test_restart_preserves_completed_steps_and_marks_running_step_failed(self):
        state = self.fresh()
        state['steps'][0]['status'] = 'done'
        state['steps'][1]['status'] = 'running'
        self.db.pg.side_effect = [[{'state': state}], []]
        self.module.initialize()
        self.assertEqual(self.module._state['status'], 'failed')
        self.assertEqual(self.module._state['steps'][0]['status'], 'done')
        self.assertEqual(self.module._state['steps'][1]['status'], 'failed')

    def test_empty_baseline_never_mutates_postgres(self):
        self.db.dbsql.return_value = []
        with self.assertRaises(ValueError):
            self.module._restore_app()
        self.db.prod.connection.assert_not_called()
        self.db.pg.assert_not_called()

    def test_app_restore_is_transactional_and_scopes_cleanup_to_demo_tags(self):
        self.db.dbsql.return_value = [{'opportunity_id': 1, 'name': 'baseline'}]
        self.module._restore_app()
        conn = self.db.prod.connection.return_value.__enter__.return_value
        conn.transaction.assert_called_once()
        cur = conn.cursor.return_value.__enter__.return_value
        statements = [c.args[0] for c in cur.execute.call_args_list]
        self.assertTrue(any('ON CONFLICT (opportunity_id) DO UPDATE' in s for s in statements))
        cleanup = next(s for s in statements if s.startswith('DELETE FROM app.activities'))
        self.assertIn('WHERE notes IN', cleanup)
        self.assertNotIn('TRUNCATE', ' '.join(statements))
        self.assertEqual(statements[-1], 'DELETE FROM workshop_control.pitr_recovery')

    def test_delta_restore_only_changes_tagged_sync_demo_rows(self):
        self.module._restore_delta()
        statement, params = self.db.dbsql.call_args.args
        self.assertIn('MERGE INTO test.demo.sync_demo', statement)
        self.assertIn('WHEN NOT MATCHED BY SOURCE AND target.tag=:tag THEN DELETE', statement)
        self.assertEqual(params, {'tag': 'synced-tab-demo'})
        self.assertEqual(self.sync._revision, 1)

    def test_restore_branch_deletion_never_targets_production(self):
        self.ops.list_branches.return_value = ['production', 'demo', 'restore']
        self.ops.branch_path.side_effect = lambda branch: f'project/branches/{branch}'
        self.module._remove_restore()
        self.db.w.postgres.delete_branch.assert_called_once_with(name='project/branches/restore', purge=True)
        self.ops.drop_pool.assert_called_once_with('restore')

    def test_failed_branch_recreation_keeps_recovery_metadata(self):
        self.ops.recreate_branch.side_effect = RuntimeError('creation failed')
        with self.assertRaises(RuntimeError):
            self.module._recreate_demo()
        self.db.pg.assert_not_called()

    def test_sync_clears_cursor_only_after_verified_completion(self):
        self.sync._pending.return_value = {'sync_complete': True, 'delta_version': 7}
        self.module._sync_baseline()
        self.db.pg.assert_called_once_with('UPDATE sync_experiment.batch SET base_version=%(v)s WHERE id=1', {'v': 7})
        self.assertIsNone(self.sync._poll_cache)
