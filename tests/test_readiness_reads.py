import sys
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'app'))
from readiness_reads import ReadFailure, Reads


class ReadinessReadTests(unittest.TestCase):
    def test_postgres_readonly_timeouts_and_no_mutations(self):
        w = Mock()
        w.postgres.get_endpoint.return_value.name = 'endpoint'
        w.postgres.get_endpoint.return_value.status.hosts.host = 'host'
        w.postgres.generate_database_credential.return_value.token = 'secret'
        reads = Reads(w, dict(LAKEBASE_ENDPOINT='endpoint', PGDATABASE='database', PGUSER='app'))
        with patch('readiness_reads.psycopg.connect') as connect:
            connect.return_value.__enter__.return_value.execute.return_value.fetchall.return_value = [{'present': True}]
            self.assertEqual(reads.pg('SELECT true AS present'), [{'present': True}])
            self.assertIn('default_transaction_read_only=on', connect.call_args.kwargs['options'])
            self.assertIn('statement_timeout=5000', connect.call_args.kwargs['options'])
            self.assertEqual(connect.call_args.kwargs['connect_timeout'], 5)
        w.postgres.update_endpoint.assert_not_called()

    def test_sql_success_maps_named_columns(self):
        w = Mock()
        w.statement_execution.execute_statement.return_value = NS(
            status=NS(state='SUCCEEDED'), result=NS(data_array=[['recent']]),
            manifest=NS(schema=NS(columns=[NS(name='latest')])) )
        rows = Reads(w, dict(DATABRICKS_WAREHOUSE_ID='warehouse')).sql('SELECT max(ts) AS latest FROM system.lakebase.compute_gauges')
        self.assertEqual(rows, [{'latest': 'recent'}])
        self.assertEqual(w.statement_execution.execute_statement.call_args.kwargs['row_limit'], 1)
        w.warehouses.start.assert_not_called()

    def test_sql_permission_failure_is_not_missing(self):
        w = Mock()
        w.statement_execution.execute_statement.return_value = NS(status=NS(state='FAILED', error=NS(error_code='PERMISSION_DENIED')))
        with self.assertRaises(ReadFailure) as caught:
            Reads(w, dict(DATABRICKS_WAREHOUSE_ID='warehouse')).sql('SELECT 1')
        self.assertEqual(caught.exception.status, 'unable_to_verify')

    def test_sql_startup_timeout_is_bounded(self):
        w = Mock()
        w.statement_execution.execute_statement.return_value = NS(status=NS(state='PENDING'), statement_id='statement')
        with patch('readiness_reads.time.monotonic', side_effect=[0, 10]):
            with self.assertRaises(TimeoutError):
                Reads(w, dict(DATABRICKS_WAREHOUSE_ID='warehouse')).sql('SELECT 1')
        w.statement_execution.cancel_execution.assert_not_called()
