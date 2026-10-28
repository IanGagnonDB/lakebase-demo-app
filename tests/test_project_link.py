import sys
import unittest
from uuid import uuid4
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).parents[1] / "app"))
from project_link import project_uid, project_url


class ProjectLinkTests(unittest.TestCase):
    def setUp(self):
        project_uid.cache_clear()

    def tearDown(self):
        project_uid.cache_clear()

    def test_resolves_and_caches_uid_for_console_link(self):
        client = Mock()
        expected_uid = str(uuid4())
        client.postgres.get_project.return_value.uid = expected_uid
        uid = project_uid(client, "example-project")
        self.assertEqual(project_uid(client, "example-project"), uid)
        client.postgres.get_project.assert_called_once_with(name="projects/example-project")
        self.assertEqual(project_url("https://workspace.example/", uid),
                         f"https://workspace.example/lakebase/projects/{expected_uid}")

    def test_lookup_failure_logs_and_caches_projects_list_fallback(self):
        client = Mock()
        client.postgres.get_project.side_effect = RuntimeError("lookup failed")
        with self.assertLogs("project_link", level="ERROR"):
            uid = project_uid(client, "example-project")
        self.assertIsNone(uid)
        self.assertIsNone(project_uid(client, "example-project"))
        client.postgres.get_project.assert_called_once()
        self.assertEqual(project_url("https://workspace.example", uid),
                         "https://workspace.example/lakebase/projects")

    def test_missing_uid_falls_back(self):
        client = Mock()
        client.postgres.get_project.return_value.uid = None
        with self.assertLogs("project_link", level="ERROR"):
            self.assertIsNone(project_uid(client, "example-project"))
