import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("scaling_telemetry", Path(__file__).parents[1] / "app/scaling_telemetry.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ScalingTelemetryTests(unittest.TestCase):
    def setUp(self):
        module._cache.clear()

    def test_live_observed_memory_sizes(self):
        for memory, cu in [(996424000, .5), (4142152000, 2)]:
            module._cache.clear()
            query = Mock(return_value=[{"ts": datetime(2026, 10, 26, tzinfo=timezone.utc), "host_memory_total_bytes": memory}])
            result = module.allocation("endpoint", query)
            self.assertEqual(result["estimated_cu"], cu)
            self.assertTrue(result["sample_at"].endswith("+00:00"))
            self.assertEqual(query.call_args.args[1], {"endpoint_id": "endpoint"})

    def test_no_samples_returns_no_allocation(self):
        self.assertIsNone(module.allocation("endpoint", Mock(return_value=[]))["estimated_cu"])

    def test_invalid_memory_does_not_produce_marker(self):
        for memory in [None, 0, -1, float("nan"), float("inf")]:
            module._cache.clear()
            self.assertIsNone(module.allocation("endpoint", Mock(return_value=[{"ts": "2026-10-26T00:00:00Z", "host_memory_total_bytes": memory}]))["estimated_cu"])

    def test_shared_cache_is_scoped_by_endpoint(self):
        query = Mock(return_value=[])
        module.allocation("one", query)
        module.allocation("one", query)
        self.assertEqual(query.call_count, 1)
        module.allocation("two", query)
        self.assertEqual(query.call_count, 2)

    def test_errors_are_classified_without_exposing_details(self):
        for message, status in [
            ("[SCHEMA_NOT_FOUND] secret", "missing_table"),
            ("[TABLE_OR_VIEW_NOT_FOUND] secret", "missing_table"),
            ("[INSUFFICIENT_PERMISSIONS] secret", "permission_denied"),
            ("warehouse unavailable secret", "temporarily_unavailable"),
        ]:
            module._cache.clear()
            result = module.allocation("endpoint", Mock(side_effect=RuntimeError(message)))
            self.assertEqual(result["status"], status)
            self.assertIsNone(result["estimated_cu"])
            self.assertNotIn("secret", str(result))

    def test_failed_reads_back_off_then_recover_without_restart(self):
        query = Mock(side_effect=[RuntimeError("[SCHEMA_NOT_FOUND] missing"),
                                 [{"ts": "2026-10-28T12:00:00Z", "host_memory_total_bytes": 2147483648}]])
        with patch.object(module.time, "monotonic", return_value=100):
            self.assertEqual(module.allocation("endpoint", query)["status"], "missing_table")
        with patch.object(module.time, "monotonic", return_value=110):
            self.assertEqual(module.allocation("endpoint", query)["status"], "missing_table")
            self.assertEqual(query.call_count, 1)
        with patch.object(module.time, "monotonic", return_value=131):
            result = module.allocation("endpoint", query)
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["estimated_cu"], 1)

    def test_sqlstate_classification(self):
        for code, status in [("42501", "permission_denied"), ("42P01", "missing_table"),
                             ("08001", "temporarily_unavailable")]:
            error = RuntimeError("redacted")
            error.sqlstate = code
            self.assertEqual(module.error_status(error), status)
