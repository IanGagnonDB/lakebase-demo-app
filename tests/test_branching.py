"""Branch experiments cannot select production and commit guards with mutations."""
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError


class BranchingTests(unittest.TestCase):
    def setUp(self):
        self.ops = MagicMock()
        self.ops.list_branches.return_value = ["demo", "production"]
        db = types.ModuleType('db')
        for name in ('S', 'bronze', 'dbsql', 'pg', 'uc', 'w'):
            setattr(db, name, MagicMock())
        db.S = {'LAKEBASE_PRODUCTION_BRANCH': 'production', 'LAKEBASE_DEMO_BRANCH': 'demo'}
        spec = importlib.util.spec_from_file_location('features_test', Path(__file__).parents[1] / 'app/features.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, db=db, ops=self.ops, provision=MagicMock(), sync_demo=MagicMock()):
            spec.loader.exec_module(self.module)
        self.recovery_patch = patch.object(self.module, '_recovery', return_value=None)
        self.recovery = self.recovery_patch.start()
        self.addCleanup(self.recovery_patch.stop)
        self.conn = self.ops.branch_pool.return_value.connection.return_value.__enter__.return_value

    def test_branch_state_filters_project_branches_using_configured_ids(self):
        self.module.S.update(LAKEBASE_PRODUCTION_BRANCH='main', LAKEBASE_DEMO_BRANCH='workshop')
        self.ops.list_branches.return_value = ['restore', 'main', 'demo', 'workshop', 'production', 'other']
        state = self.module.branching_state()
        self.assertEqual(state['branches'], ['main', 'workshop'])
        self.ops.recreate_branch.assert_not_called()

    def test_recovery_filters_saved_branches_without_changing_snapshot(self):
        snapshot = {'state': {'branches': ['production', 'demo', 'restore', 'other'], 'demo': ['amount']}}
        self.recovery.return_value = snapshot
        self.assertEqual(self.module.branching_state()['branches'], ['production', 'demo'])
        self.assertEqual(snapshot['state']['branches'], ['production', 'demo', 'restore', 'other'])

    def test_sync_trigger_preserves_legacy_fields_and_starts_both_pipelines(self):
        self.module.w.pipelines.start_update.side_effect = [MagicMock(update_id='targets-update'),
                                                          self.module.ResourceConflict('already running')]
        result = self.module.sync_trigger()
        self.assertEqual(result['update_id'], 'targets-update')
        self.assertTrue(result['updates']['sync_demo']['already_running'])
        self.assertEqual(self.module.w.pipelines.start_update.call_count, 2)

    def test_production_and_arbitrary_sql_are_rejected(self):
        with self.assertRaises(ValueError):
            self.module._demo_pool('production')
        self.ops.branch_pool.assert_not_called()
        for body in ({'step': 'drop_service_line', 'branch': 'production'},
                     {'step': 'drop_service_line', 'branch': 'demo', 'sql': 'DELETE FROM app.opportunities'}):
            with self.assertRaises(ValidationError):
                self.module.BranchTestChangeIn(**body)

    def test_duplicate_and_out_of_order_steps_do_not_mutate(self):
        for applied in ([], ['add_win_probability', 'halve_sample_amounts']):
            with patch.object(self.module, '_steps', return_value=applied), self.assertRaises(HTTPException):
                self.module._apply_step('halve_sample_amounts')
        self.assertTrue(all('UPDATE' not in str(c) for c in self.conn.execute.call_args_list))

    def test_mutation_and_guard_share_demo_transaction(self):
        self.conn.execute.return_value.fetchall.side_effect = [
            [{'opportunity_id': 1, 'amount': 100}], [{'opportunity_id': 1, 'amount': 50}]]
        with patch.object(self.module, '_steps', return_value=['add_win_probability']):
            affected, samples = self.module._apply_step('halve_sample_amounts')
        self.assertEqual(affected, 1)
        self.assertEqual(samples[0]['before_amount'], 100)
        self.ops.branch_pool.assert_called_once_with('demo')
        self.conn.transaction.assert_called_once()
        self.assertIn('INSERT INTO branch_experiment.applied_steps', self.conn.execute.call_args.args[0])


    def test_failed_reset_preserves_recoverable_snapshot(self):
        snapshot = {'state': {'demo': ['service_line']}, 'applied_steps': ['add_win_probability']}
        self.ops.recreate_branch.side_effect = RuntimeError('creation failed')
        with patch.object(self.module, '_read_experiment', return_value=snapshot):
            result = self.module.branching_reset()
        self.assertTrue(result['recoverable'])
        self.assertIn('creation failed', result['message'])
        self.assertFalse(any('DELETE FROM branch_control' in str(c) for c in self.module.pg.call_args_list))
        self.recovery.return_value = snapshot
        self.assertTrue(self.module.branching_state()['recoverable'])
        self.assertEqual(self.module.branching_experiment()['applied_steps'], ['add_win_probability'])
        self.ops.recreate_branch.side_effect = None
        with patch.object(self.module, '_branching_state', return_value={'demo': []}):
            self.module.branching_reset()
        self.assertIn('DELETE FROM branch_control', self.module.pg.call_args.args[0])

    def test_busy_reset_returns_conflict(self):
        with self.module._branching_operation(), self.assertRaises(HTTPException) as caught:
            self.module.branching_reset()
        self.assertEqual(caught.exception.status_code, 409)
        self.ops.recreate_branch.assert_not_called()

    def test_demo_trigger_failures_preserve_legacy_target_result(self):
        for failure in (self.module.DatabricksError('missing'), None):
            self.module.w.reset_mock()
            self.module.w.pipelines.start_update.side_effect = None
            target = MagicMock()
            demo = MagicMock()
            demo.status.pipeline_id = None
            self.module.w.postgres.get_synced_table.side_effect = [target, failure if failure is not None else demo]
            self.module.w.pipelines.start_update.return_value.update_id = 'legacy'
            result = self.module.sync_trigger()
            self.assertEqual(result['update_id'], 'legacy')
            self.assertIn('error', result['updates']['sync_demo'])

    def test_unreadable_demo_without_backup_still_recreates(self):
        self.module.pg.side_effect = lambda sql, *args: ([{'column_name': 'amount'}] if sql == self.module.COLUMNS
                                                       else [{'opportunity_id': 1, 'amount': 100}] if sql == self.module.SAMPLES else [])
        with patch.object(self.module, '_read_experiment', side_effect=ConnectionError('demo missing')), \
             patch.object(self.module, '_branching_state', return_value={'demo': ['amount']}):
            result = self.module.branching_reset()
        self.ops.recreate_branch.assert_called_once_with('demo')
        self.assertEqual(result['demo'], ['amount'])
        import json
        snapshot = json.loads(next(c.args[1]['snapshot'] for c in self.module.pg.call_args_list
                                   if c.args[0].startswith('INSERT INTO branch_control')))
        self.assertEqual(snapshot['applied_steps'], [])
        self.assertEqual(snapshot['production_samples'][0]['amount'], 100)

    def test_experiment_read_ignores_process_mutation_lock(self):
        with self.module._branching_operation(), patch.object(self.module, '_read_experiment', return_value={'applied_steps': []}):
            self.assertEqual(self.module.branching_experiment(), {'applied_steps': []})

    def test_cleanup_failure_returns_success_and_next_read_retries(self):
        snapshot = {'state': {'demo': []}, 'applied_steps': []}
        failed = []
        def pg(sql, *args):
            if sql.startswith('DELETE') and not failed:
                failed.append(True)
                raise ConnectionError('transient cleanup failure')
            if sql.startswith('SELECT snapshot'):
                return [{'snapshot': {**snapshot, '_reset_complete': True}}]
            return []
        self.module.pg.side_effect = pg
        with patch.object(self.module, '_read_experiment', return_value=snapshot), \
             patch.object(self.module, '_branching_state', return_value={'demo': ['amount']}):
            result = self.module.branching_reset()
        self.assertEqual(result['demo'], ['amount'])
        self.recovery_patch.stop()
        self.assertIsNone(self.module._recovery())
        self.assertFalse(self.module._reset_cleanup_pending)
        self.assertEqual(sum(c.args[0].startswith('DELETE') for c in self.module.pg.call_args_list), 2)

    def test_recovery_read_does_not_issue_ddl(self):
        self.recovery_patch.stop()
        self.module.pg.return_value = []
        self.assertIsNone(self.module._recovery())
        self.module.pg.assert_called_once_with('SELECT snapshot FROM branch_control.reset_recovery WHERE id=1')

    def test_absent_demo_skips_stale_pool_and_recreates(self):
        self.ops.list_branches.return_value = ['production']
        self.module.pg.return_value = []
        with patch.object(self.module, '_read_experiment') as read, \
             patch.object(self.module, '_branching_state', return_value={'demo': []}):
            self.module.branching_reset()
        read.assert_not_called()
        self.ops.recreate_branch.assert_called_once_with('demo')
