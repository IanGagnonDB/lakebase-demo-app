import importlib.util
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock

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

    def test_failure_is_not_cached(self):
        query = Mock(side_effect=[RuntimeError("permission denied"), []])
        with self.assertRaises(RuntimeError):
            module.allocation("endpoint", query)
        self.assertIsNone(module.allocation("endpoint", query)["sample_at"])
