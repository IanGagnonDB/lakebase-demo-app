import importlib.util
import unittest
from pathlib import Path
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("telemetry_setup", Path(__file__).parents[1] / "setup/telemetry.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SparkError(Exception):
    def __init__(self, condition):
        self.condition = condition

    def getCondition(self):
        return self.condition


class TelemetrySetupTests(unittest.TestCase):
    def test_absent_table_does_not_attempt_grants(self):
        spark = Mock()
        spark.sql.side_effect = SparkError("TABLE_OR_VIEW_NOT_FOUND")
        self.assertEqual(module.grant_telemetry(spark, "app-id"), "missing_table")
        self.assertEqual(spark.sql.call_count, 1)

    def test_permission_failure_is_optional(self):
        spark = Mock()
        spark.sql.side_effect = [None, SparkError("INSUFFICIENT_PERMISSIONS")]
        self.assertEqual(module.grant_telemetry(spark, "app-id"), "permission_denied")

    def test_azure_sqlstate_permission_failure_is_optional(self):
        spark = Mock()
        error = SparkError("UNAUTHORIZED_ACCESS")
        error.getSqlState = lambda: "42501"
        spark.sql.side_effect = error
        self.assertEqual(module.grant_telemetry(spark, "app-id"), "permission_denied")

    def test_unexpected_failure_is_not_hidden(self):
        spark = Mock()
        spark.sql.side_effect = RuntimeError("warehouse broken")
        with self.assertRaises(RuntimeError):
            module.grant_telemetry(spark, "app-id")

    def test_repeated_setup_grants_only_table_read_and_parent_usage(self):
        spark = Mock()
        for _ in range(2):
            self.assertEqual(module.grant_telemetry(spark, "app`id"), "ready")
        statements = [call.args[0] for call in spark.sql.call_args_list]
        self.assertEqual(statements[:4], statements[4:])
        self.assertEqual(statements[:4], [
            "DESCRIBE TABLE system.lakebase.compute_gauges",
            "GRANT USE CATALOG ON CATALOG system TO `app``id`",
            "GRANT USE SCHEMA ON SCHEMA system.lakebase TO `app``id`",
            "GRANT SELECT ON TABLE system.lakebase.compute_gauges TO `app``id`",
        ])
