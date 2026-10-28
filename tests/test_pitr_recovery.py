"""PITR recovery metadata must survive tab switches, reloads and partial copy-back."""
import importlib.util
import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException


class PitrRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.db = types.ModuleType('db')
        self.db.S = {}
        for name in ('bronze', 'dbsql', 'pg', 'uc', 'w'):
            setattr(self.db, name, MagicMock())
        self.ops = MagicMock()
        provision = MagicMock()
        provision.OPP_COLS = 'opportunity_id, name'
        spec = importlib.util.spec_from_file_location('features_pitr_test', Path(__file__).parents[1] / 'app/features.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, db=self.db, ops=self.ops, provision=provision):
            spec.loader.exec_module(self.module)

    def test_delete_and_marker_are_one_statement_and_timestamp_is_returned(self):
        before = datetime(2026, 10, 25, tzinfo=timezone.utc)
        self.db.pg.return_value = [{'opportunity_id': 1, 'before_ts': before}, {'opportunity_id': 2, 'before_ts': before}]
        result = self.module.pitr_delete()
        self.assertEqual(result['ids'], [1, 2])
        self.assertIn('2026-10-25', result['before_ts'])
        self.db.pg.assert_called_once()
        sql = self.db.pg.call_args.args[0]
        self.assertIn('INSERT INTO workshop_control.pitr_recovery', sql)
        self.assertIn('DELETE FROM app.opportunities USING recovery', sql)
        self.assertIn('ON CONFLICT DO NOTHING', sql)

    def test_repeated_delete_cannot_overwrite_pending_recovery(self):
        self.db.pg.side_effect = [[], [{'id': 1}]]
        with self.assertRaises(HTTPException) as caught:
            self.module.pitr_delete()
        self.assertEqual(caught.exception.status_code, 409)

    def test_state_exposes_durable_recovery(self):
        self.db.pg.side_effect = [[{'before_ts': '2026-10-25T00:00:00Z', 'ids': [1, 2]}], [{'n': 98}]]
        self.ops.list_branches.return_value = ['production']
        result = self.module.pitr_state()
        self.assertEqual(result['opportunities'], 98)
        self.assertEqual(result['recovery']['ids'], [1, 2])

    def test_missing_restore_rows_do_not_report_success_or_clear_marker(self):
        self.ops.pg_on.return_value = [{'opportunity_id': 1, 'name': 'one'}]
        with self.assertRaises(HTTPException) as caught:
            self.module.pitr_copy_back(self.module.CopyBackIn(ids=[1, 2]))
        self.assertEqual(caught.exception.status_code, 409)
        self.db.pg.assert_not_called()

    def test_copy_failure_keeps_marker_for_retry(self):
        self.ops.pg_on.return_value = [{'opportunity_id': 1, 'name': 'one'}, {'opportunity_id': 2, 'name': 'two'}]
        self.db.pg.side_effect = [[], ConnectionError('write interrupted')]
        with self.assertRaises(ConnectionError):
            self.module.pitr_copy_back(self.module.CopyBackIn(ids=[1, 2]))
        self.assertFalse(any('DELETE FROM workshop_control' in call.args[0] for call in self.db.pg.call_args_list))

    def test_success_checks_all_recovery_ids_before_removing_marker(self):
        self.ops.pg_on.return_value = [{'opportunity_id': 1, 'name': 'one'}]
        self.module.pitr_copy_back(self.module.CopyBackIn(ids=[1]))
        sql = self.db.pg.call_args.args[0]
        self.assertIn('DELETE FROM workshop_control.pitr_recovery', sql)
        self.assertIn('NOT EXISTS', sql)
        self.assertIn('unnest(recovery.ids)', sql)
