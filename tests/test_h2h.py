"""Harness regression checks without workspace credentials or database access."""
import importlib.util
import sys
import threading
import time
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.warmed = set()
        self.parameters = {"lakebase": {}, "dbsql": {}}
        self.checked_out = 0
        self.peak = 0
        self.lock = threading.Lock()
        test = self

        class Connection:
            description = True

            def execute(self, *args):
                test.parameters["lakebase"].setdefault(threading.get_ident(), []).append(args[1])
                time.sleep(.001)
                return self

            def fetchall(self):
                return []

        class Pool:
            @contextmanager
            def connection(self):
                with test.lock:
                    test.checked_out += 1
                    test.peak = max(test.peak, test.checked_out)
                try:
                    yield Connection()
                finally:
                    with test.lock:
                        test.checked_out -= 1

        def dbsql(*args):
            self.warmed.add(threading.get_ident())
            self.parameters["dbsql"].setdefault(threading.get_ident(), []).append(args[1])
            return [], 1.0

        db = types.ModuleType('db')
        db.prod = Pool()
        db.dbsql_query = dbsql
        db.pg_query = lambda *args: ([], 1.0)
        db.summary = lambda samples: {'n': len(samples), 'p50': sorted(samples)[len(samples)//2]}
        db.uc = lambda table: f'catalog.schema.{table}'
        db._ms = lambda start: (time.perf_counter() - start) * 1000
        spec = importlib.util.spec_from_file_location('h2h_test', Path(__file__).parents[1] / 'app/h2h.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, db=db):
            spec.loader.exec_module(self.module)

    def tearDown(self):
        self.module._users.shutdown()

    def test_fifty_users_have_distinct_warmed_sessions_and_connections(self):
        result = self.module.concurrent(self.module.ConcurrentIn(action='rep_scorecard', users=50, per_user=3))
        self.assertEqual(len(self.warmed), 50)
        self.assertEqual(self.peak, 50)
        self.assertEqual(self.checked_out, 0)
        self.assertEqual(self.parameters["lakebase"], {k: [p for p in v if p] for k, v in self.parameters["dbsql"].items()})
        for engine in ('lakebase', 'dbsql'):
            self.assertEqual(result[engine]['n'], 150)
            self.assertEqual(result[engine]['errors'], [])

    def test_single_run_shared_rep_reads_and_writes_on_both_engines(self):
        for action in ('rep_scorecard', 'log_activity'):
            for engine in ('lakebase', 'dbsql'):
                with self.subTest(action=action, engine=engine), \
                     patch.object(self.module, 'pg_query', return_value=([{'rep_id': 7}], 1.0)) as pg, \
                     patch.object(self.module, 'dbsql_query', return_value=([], 2.0)) as db:
                    result = self.module.run(engine, action, self.module.RunIn(rep_id=7))
                    self.assertEqual(result['rep_id'], 7)
                    query = pg if engine == 'lakebase' else db
                    sent = query.call_args.args[-1]
                    self.assertEqual(sent['rep_id'], 7)
                    if action == 'log_activity':
                        self.assertIn('account_id', sent)
                        self.assertEqual('activity_id' in sent, engine == 'dbsql')

    def test_single_run_optional_rep_and_http_validation(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        app.include_router(self.module.router)
        with TestClient(app) as client, \
             patch.object(self.module, 'pg_query', return_value=([{'rep_id': 7}], 1.0)), \
             patch.object(self.module.random, 'randint', return_value=7):
            for body in (None, {}, {'rep_id': 7}):
                response = client.post('/api/h2h/lakebase/rep_scorecard', json=body)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['rep_id'], 7)
            for rep in (0, -1, 1.5, '7', True):
                self.assertEqual(client.post('/api/h2h/lakebase/rep_scorecard', json={'rep_id': rep}).status_code, 422)
            with patch.object(self.module, 'pg_query', return_value=([], 1.0)):
                for engine in ('lakebase', 'dbsql'):
                    for action in ('rep_scorecard', 'log_activity'):
                        self.assertEqual(client.post(f'/api/h2h/{engine}/{action}', json={'rep_id': 51}).status_code, 422)

    def test_non_rep_actions_do_not_gain_unused_query_parameters(self):
        with patch.object(self.module, 'pg_query', return_value=([{'rep_id': 7}], 1.0)), \
             patch.object(self.module, 'run_once', return_value=([], 2.0)) as run:
            result = self.module.run('lakebase', 'pipeline_list', self.module.RunIn(rep_id=7))
        self.assertIsNone(result['rep_id'])
        self.assertNotIn('rep_id', run.call_args.args[2])

    def test_defaults_and_scan_shape(self):
        body = self.module.ConcurrentIn(action='rep_scorecard')
        self.assertEqual((body.users, body.per_user), (10, 5))
        query = self.module.analytics_sql('ref.activities_history_100000')
        self.assertIn('count(DISTINCT account_id)', query)
        self.assertNotIn('WHERE', query)

    def test_analytics_checks_equal_results_and_row_counts(self):
        rows = [{"region": "West", "quarter": "2025-Q1", "activity_type": "Call",
                 "visits": 100000, "amount": 123, "accounts": 2000}]
        pool = MagicMock()
        connection = pool.connection.return_value.__enter__.return_value
        connection.execute.return_value.fetchall.return_value = rows
        with patch.object(self.module, 'prod', pool), patch.object(self.module, 'dbsql_query', return_value=(rows, 2.0)):
            result = self.module.analytics(self.module.AnalyticsIn(rows=100000))
        self.assertTrue(result['results_equal'])
        self.assertEqual(result['scanned_rows'], {'lakebase': 100000, 'dbsql': 100000})
        self.assertEqual(result['lakebase']['n'], 1)
        self.assertEqual(result['timeout_seconds'], 12)

    def test_analytics_reports_timeout_instead_of_a_false_fast_result(self):
        pool = MagicMock()
        connection = pool.connection.return_value.__enter__.return_value
        connection.execute.side_effect = TimeoutError('query budget exceeded')
        with patch.object(self.module, 'prod', pool), patch.object(self.module, 'dbsql_query', return_value=([], 2.0)):
            result = self.module.analytics(self.module.AnalyticsIn(rows=2000000, repetitions=1))
        self.assertEqual(result['timeout_seconds'], 12)
        self.assertNotIn('p50', result['lakebase'])
        self.assertEqual(result['lakebase']['errors'], ['TimeoutError: query budget exceeded'])
        self.assertFalse(result['results_equal'])

    def test_five_million_tier_and_bounded_timeout_override(self):
        body = self.module.AnalyticsIn(rows=5000000, repetitions=1, timeout_seconds=60)
        self.assertEqual(body.timeout_seconds, 60)
        self.assertEqual(self.module.AnalyticsIn(rows=2000000, repetitions=1).rows, 2000000)
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            self.module.AnalyticsIn(rows=5000000, repetitions=1, timeout_seconds=61)
        with self.assertRaises(ValidationError):
            self.module.AnalyticsIn(rows=5000000, repetitions=3, timeout_seconds=60)

    def test_only_retained_tiers_and_default_five_million_budget(self):
        from pydantic import ValidationError
        self.assertEqual(self.module.TIERS, (100000, 1000000, 2000000, 5000000))
        for retired in (10000000, 50000000):
            with self.assertRaises(ValidationError):
                self.module.AnalyticsIn(rows=retired)
        pool = MagicMock()
        pool.connection.return_value.__enter__.return_value.execute.return_value.fetchall.return_value = []
        with patch.object(self.module, 'prod', pool), patch.object(self.module, 'dbsql_query', return_value=([], 2.0)):
            result = self.module.analytics(self.module.AnalyticsIn(rows=5000000))
        self.assertEqual(result['timeout_seconds'], 60)
        self.assertEqual(result['repetitions'], 1)

    def test_slow_dbsql_does_not_start_a_60_second_scan_without_budget(self):
        pool = MagicMock()
        with patch.object(self.module, 'prod', pool), patch.object(self.module, 'dbsql_query', return_value=([], 2.0)), \
             patch.object(self.module.time, 'perf_counter', side_effect=[0, 0, 16, 16]):
            result = self.module.analytics(self.module.AnalyticsIn(rows=5000000, repetitions=1, timeout_seconds=60))
        pool.connection.assert_not_called()
        self.assertIn('Not started:', result['lakebase']['errors'][0])
        self.assertNotIn('p50', result['lakebase'])

    def test_expired_warm_session_retries_once(self):
        original = self.module.dbsql_query
        attempts = []
        def query(sql, parameters):
            if sql == 'SELECT 1':
                attempts.append(sql)
                if len(attempts) == 1:
                    raise ConnectionError('expired session')
            return original(sql, parameters)
        with patch.object(self.module, 'dbsql_query', side_effect=query):
            result = self.module.concurrent(self.module.ConcurrentIn(action='rep_scorecard', users=1, per_user=1))
        self.assertEqual(len(attempts), 2)
        self.assertEqual(result['dbsql']['errors'], [])

    def test_analytics_restores_session_timeout_after_error(self):
        def query(sql, *args):
            if sql.startswith('SET STATEMENT_TIMEOUT'):
                raise RuntimeError('failed to set timeout')
            return [], 1
        with patch.object(self.module, 'dbsql_query', side_effect=query) as mocked, self.assertRaises(RuntimeError):
            self.module.analytics(self.module.AnalyticsIn(rows=100000))
        self.assertEqual(mocked.call_args.args[0], 'RESET STATEMENT_TIMEOUT')

    def test_reset_timeout_failure_does_not_mask_results(self):
        pool = MagicMock()
        pool.connection.return_value.__enter__.return_value.execute.return_value.fetchall.return_value = []
        def query(sql, *args):
            if sql == 'RESET STATEMENT_TIMEOUT':
                raise ConnectionError('reset failed; session discarded')
            return [], 1.0
        with patch.object(self.module, 'prod', pool), patch.object(self.module, 'dbsql_query', side_effect=query):
            result = self.module.analytics(self.module.AnalyticsIn(rows=100000))
        self.assertTrue(result['results_equal'])
        self.assertEqual(result['lakebase']['n'], 1)


if __name__ == '__main__':
    unittest.main()

class LimitsTests(unittest.TestCase):
    def test_caps(self):
        from pydantic import ValidationError
        test = HarnessTests()
        test.setUp()
        try:
            with self.assertRaises(ValidationError):
                test.module.ConcurrentIn(action='rep_scorecard', users=51)
        finally:
            test.tearDown()
