import importlib.util
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock
from databricks.sdk.errors import NotFound, PermissionDenied
sys.path.insert(0, str(Path(__file__).parents[1] / "app"))

spec = importlib.util.spec_from_file_location("readiness", Path(__file__).parents[1] / "app/readiness.py")
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)


def check(run, unknown=False):
    return m.Check("example", "resource", "Example", "metadata GET", "Ask an administrator.", run, unknown)


class ReadinessTests(unittest.TestCase):
    def test_ready(self):
        row = m.evaluate(check(lambda: ("ready", "Available.")))
        self.assertEqual(row["status"], "ready")
        self.assertEqual(row["action"], "")

    def test_missing_resource_is_not_ready(self):
        self.assertEqual(m.evaluate(check(Mock(side_effect=NotFound("private catalog"))))["status"], "not_ready")

    def test_unknown_setting_is_unable_to_verify(self):
        self.assertEqual(m.evaluate(check(Mock(side_effect=NotFound("setting")), True))["status"], "unable_to_verify")

    def test_403_is_unable_to_verify_and_redacted(self):
        with self.assertLogs(m.log, level="ERROR"):
            row = m.evaluate(check(Mock(side_effect=PermissionDenied("token secret private_catalog"))))
        self.assertEqual(row["status"], "unable_to_verify")
        self.assertNotIn("secret", str(row))
        self.assertNotIn("private_catalog", str(row))

    def test_timeout_exception_is_unable_to_verify(self):
        with self.assertLogs(m.log, level="ERROR"):
            row = m.evaluate(check(Mock(side_effect=TimeoutError("sensitive server"))))
        self.assertEqual(row["status"], "unable_to_verify")
        self.assertNotIn("sensitive", str(row))

    def test_concurrent_deadline_preserves_partial_result_and_cache(self):
        gate = threading.Event()
        slow = check(lambda: (gate.wait(1), ("ready", "Done"))[1])
        fast = check(lambda: ("not_ready", "Failed"))
        fast.id = "fast"
        service = m.ReadinessService(timeout=.03)
        started = time.monotonic()
        try:
            result = service.get([slow, fast])
            self.assertLess(time.monotonic() - started, .3)
            self.assertEqual([r["status"] for r in result["checks"]], ["unable_to_verify", "not_ready"])
            self.assertIs(service.get([slow, fast]), result)
        finally:
            gate.set()

    def test_single_flight(self):
        call = Mock(side_effect=lambda: (time.sleep(.02), ("ready", "Done"))[1])
        service = m.ReadinessService(timeout=.2)
        results = []
        threads = [threading.Thread(target=lambda: results.append(service.get([check(call)]))) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(call.call_count, 1)
        self.assertTrue(all(r is results[0] for r in results))

    def test_preview_effective_value_and_disabled(self):
        w = Mock()
        s = {k: k for k in ("LAKEBASE_PROJECT", "LAKEBASE_ENDPOINT", "CATALOG", "SCHEMA", "BRONZE_SCHEMA", "LAKEBASE_CATALOG", "PGDATABASE")}
        preview = next(c for c in m.checks(w, s) if c.id == "preview_cdf")
        for value, expected in [(True, "ready"), (False, "not_ready"), (None, "unable_to_verify")]:
            w.workspace_settings_v2.get_public_workspace_setting.return_value.effective_boolean_val.value = value
            self.assertEqual(m.evaluate(preview)["status"], expected)

    def test_only_metadata_services_are_used_to_build_checks(self):
        w = Mock()
        s = {k: k for k in ("LAKEBASE_PROJECT", "LAKEBASE_ENDPOINT")}
        m.checks(w, s)
        self.assertEqual(w.mock_calls, [])

    def test_worker_capacity_bounds_hanging_checks(self):
        gate = threading.Event()
        service = m.ReadinessService(ttl=0, timeout=.01, capacity=1)
        run = Mock(side_effect=lambda: (gate.wait(1), ("ready", "Done"))[1])
        try:
            service.get([check(run)])
            result = service.get([check(run)])
            self.assertEqual(run.call_count, 1)
            self.assertEqual(result["checks"][0]["status"], "unable_to_verify")
        finally:
            gate.set()

    def test_live_synced_table_states(self):
        w = Mock()
        s = {k: k for k in ("LAKEBASE_PROJECT", "LAKEBASE_ENDPOINT", "LAKEBASE_CATALOG")}
        c = next(c for c in m.checks(w, s) if c.id == "sync_reps")
        st = w.postgres.get_synced_table.return_value
        st.status.pipeline_id = "pipeline"
        w.pipelines.get.return_value.state = "IDLE"
        for value, expected in [("SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE", "ready"),
                                ("SYNCED_TABLE_OFFLINE", "not_ready"),
                                ("SYNCED_TABLE_ONLINE_PIPELINE_FAILED", "not_ready"),
                                ("SYNCED_TABLE_ONLINE_TRIGGERED_UPDATE", "warning"),
                                (None, "unable_to_verify")]:
            st.status.detailed_state = value
            self.assertEqual(m.evaluate(c)["status"], expected)

    def test_warehouse_stopped_ready_with_neutral_note(self):
        w = Mock()
        s = {k: k for k in ("LAKEBASE_PROJECT", "LAKEBASE_ENDPOINT", "DATABRICKS_WAREHOUSE_ID")}
        c = next(c for c in m.checks(w, s) if c.id == "warehouse")
        for current, expected, note in [("STOPPED", "ready", "Stopped"), ("RUNNING", "ready", None), ("DELETED", "not_ready", None), ("FAILED", "not_ready", None)]:
            with self.subTest(state=current):
                w.warehouses.get.return_value.state = current
                row = m.evaluate(c)
                self.assertEqual(row["status"], expected)
                self.assertEqual(row.get("state_note"), note)
                if expected == "ready":
                    self.assertEqual(row["action"], "")
        w.warehouses.start.assert_not_called()

    def test_endpoint_suspended_ready_and_failures_not_ready(self):
        w = Mock()
        s = {k: k for k in ("LAKEBASE_PROJECT", "LAKEBASE_ENDPOINT")}
        c = next(c for c in m.checks(w, s) if c.id == "endpoint_demo")
        endpoint = Mock()
        w.postgres.list_endpoints.return_value = [endpoint]
        endpoint.status.disabled = False
        for current, expected, note in [("IDLE", "ready", "Suspended"), ("ACTIVE", "ready", None), ("FAILED", "not_ready", None), ("DELETING", "not_ready", None)]:
            with self.subTest(state=current):
                endpoint.status.current_state = current
                row = m.evaluate(c)
                self.assertEqual(row["status"], expected)
                self.assertEqual(row.get("state_note"), note)
                if expected == "ready":
                    self.assertEqual(row["action"], "")
        endpoint.status.current_state = "IDLE"
        endpoint.status.disabled = True
        self.assertEqual(m.evaluate(c)["status"], "not_ready")
        w.postgres.list_endpoints.return_value = []
        self.assertEqual(m.evaluate(c)["status"], "not_ready")
        w.postgres.create_endpoint.assert_not_called()

    def compute_checks(self):
        w, reads = Mock(), Mock()
        s = {k: k for k in ("LAKEBASE_PROJECT", "LAKEBASE_ENDPOINT", "LAKEBASE_CATALOG", "CATALOG", "SCHEMA", "PGDATABASE")}
        return w, reads, {c.id: c for c in m.checks(w, s, reads)}

    def test_seed_verified_and_missing_rows(self):
        _, reads, checks = self.compute_checks()
        row = dict(activities=True, opportunities=True, reset_records=1)
        reads.pg.return_value = [row]
        self.assertEqual(m.evaluate(checks['seed'])['status'], 'ready')
        for field in ('activities', 'opportunities'):
            with self.subTest(field=field):
                reads.pg.return_value = [{**row, field: 0}]
                self.assertEqual(m.evaluate(checks['seed'])['status'], 'not_ready')

    def test_compute_permission_error_is_unverified(self):
        from readiness_reads import ReadFailure
        _, reads, checks = self.compute_checks()
        reads.pg.side_effect = ReadFailure('unable_to_verify', 'SELECT access denied.')
        with self.assertLogs(m.log, level='ERROR'):
            row = m.evaluate(checks['seed'])
        self.assertEqual(row['status'], 'unable_to_verify')

    def test_pitr_saved_timestamp_within_configured_bounds(self):
        from datetime import datetime, timedelta, timezone
        from google.protobuf.timestamp_pb2 import Timestamp
        w, reads, checks = self.compute_checks()
        now = datetime.now(timezone.utc)
        w.postgres.get_project.return_value.status.history_retention_duration.seconds = 7 * 86400
        created = Timestamp()
        created.FromDatetime(now - timedelta(days=10))
        w.postgres.get_branch.return_value.create_time = created
        for before, ids, expected in [(None, None, 'ready'), (now - timedelta(hours=1), 5, 'warning'),
                                      (now - timedelta(days=8), 5, 'not_ready'), (now, 0, 'not_ready')]:
            with self.subTest(before=before, ids=ids):
                reads.pg.return_value = [dict(now=now, before_ts=before, saved_ids=ids)]
                row = m.evaluate(checks['pitr'])
                self.assertEqual(row['status'], expected)
                if expected in ('ready', 'warning'):
                    self.assertIn('exact provider restore boundary', row['detail'].lower())

    def test_telemetry_verified_recent_and_empty(self):
        w, reads, checks = self.compute_checks()
        w.postgres.get_endpoint.return_value.uid = 'ep-example'
        for latest, expected in [('2026-10-26T16:00:00Z', 'ready'), (None, 'warning')]:
            reads.sql.return_value = [dict(latest=latest)]
            self.assertEqual(m.evaluate(checks['telemetry'])['status'], expected)
        self.assertIn('ep-example', reads.sql.call_args.args[0])

    def test_missing_or_unreadable_telemetry_is_optional(self):
        w, reads, checks = self.compute_checks()
        for error in [NotFound("missing"), PermissionDenied("private")]:
            w.tables.get.side_effect = error
            result = m.evaluate(checks['telemetry'])
            self.assertEqual(result['status'], 'warning')
            reads.sql.assert_not_called()

    def test_telemetry_query_failure_is_warning(self):
        w, reads, checks = self.compute_checks()
        w.postgres.get_endpoint.return_value.uid = 'ep-example'
        reads.sql.side_effect = m.ReadFailure('unable_to_verify', 'private')
        result = m.evaluate(checks['telemetry'])
        self.assertEqual(result['status'], 'warning')
        self.assertNotIn('private', result['detail'])

    def test_disabled_observability_preview_is_optional(self):
        w, reads, checks = self.compute_checks()
        w.workspace_settings_v2.get_public_workspace_setting.return_value.effective_boolean_val.value = False
        self.assertEqual(m.evaluate(checks['preview_observability'])['status'], 'warning')
        self.assertEqual(m.evaluate(checks['preview_cdf'])['status'], 'not_ready')

    def test_benchmark_tiers_are_independent_and_read_rows(self):
        w, reads, checks = self.compute_checks()
        tiers = [c for key, c in checks.items() if key.startswith('history_tier_')]
        self.assertEqual(len(tiers), 4)
        self.assertTrue(all(c.timeout == 10 for c in tiers))
        st = w.postgres.get_synced_table.return_value
        st.status.detailed_state = 'SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE'
        st.status.pipeline_id = 'pipeline'
        w.pipelines.get.return_value.state = 'IDLE'
        reads.pg.return_value = [dict(populated=True)]
        self.assertTrue(all(m.evaluate(c)['status'] == 'ready' for c in tiers))
        reads.pg.return_value = [dict(populated=False)]
        self.assertEqual(m.evaluate(tiers[0])['status'], 'not_ready')

    def test_per_check_deadline_and_longer_probe_budget(self):
        fast = check(lambda: (time.sleep(.04), ('ready', 'Done'))[1])
        fast.timeout = .01
        slow = check(lambda: (time.sleep(.04), ('ready', 'Done'))[1])
        slow.timeout = .15
        slow.id = 'long'
        rows = m.ReadinessService(timeout=.2).get([fast, slow])['checks']
        self.assertEqual([r['status'] for r in rows], ['unable_to_verify', 'ready'])

    def test_control_missing_and_initialized(self):
        _, reads, checks = self.compute_checks()
        reads.pg.return_value = [dict(t0=True, t1=True, t2=False, t3=False)]
        row = m.evaluate(checks['controls'])
        self.assertEqual(row['status'], 'not_ready')
        self.assertIn('workshop_control.reset_state', row['detail'])
        self.assertEqual(row['action'], 'Restart the app so provisioning recreates the control tables, then verify database SELECT access.')
        reads.pg.assert_called_once()
        reads.pg.side_effect = [[dict(t0=True, t1=True, t2=True, t3=True)], [dict(t0=False, t1=True, t2=True, t3=False)]]
        self.assertEqual(m.evaluate(checks['controls'])['status'], 'ready')

    def test_control_tables_empty_before_first_reset_are_ready(self):
        _, reads, checks = self.compute_checks()
        reads.pg.side_effect = [
            [dict(t0=True, t1=True, t2=True, t3=True)],
            [dict(t0=False, t1=False, t2=False, t3=False)],
        ]
        row = m.evaluate(checks['controls'])
        self.assertEqual(row['status'], 'ready')
        self.assertEqual(row['detail'], 'Control tables readable · no reset has run yet')
        self.assertEqual(row['action'], '')
        query = reads.pg.call_args.args[0]
        self.assertNotIn('count(', query.lower())
        for table in ('branch_control.reset_recovery', 'sync_experiment.batch',
                      'workshop_control.reset_state', 'workshop_control.pitr_recovery'):
            self.assertIn(f'SELECT 1 FROM {table} LIMIT 1', query)

    def test_control_tables_unreadable_are_unverified(self):
        from readiness_reads import ReadFailure
        for error in (ReadFailure('unable_to_verify', 'SELECT access denied.'),
                      TimeoutError('query timeout')):
            with self.subTest(error=type(error).__name__):
                _, reads, checks = self.compute_checks()
                reads.pg.side_effect = [
                    [dict(t0=True, t1=True, t2=True, t3=True)], error,
                ]
                with self.assertLogs(m.log, level='ERROR'):
                    row = m.evaluate(checks['controls'])
                self.assertEqual(row['status'], 'unable_to_verify')
