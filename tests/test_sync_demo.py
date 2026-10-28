"""CRUD batching, CDF evidence and row equality without workspace access."""
import asyncio
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError


class SyncDemoTests(unittest.TestCase):
    def setUp(self):
        self.db = types.ModuleType('db')
        self.db.S = {'CATALOG': 'test', 'SCHEMA': 'demo'}
        self.db.uc = lambda table: f'test.demo.{table}'
        for name in ('dbsql', 'pg', 'w'):
            setattr(self.db, name, MagicMock())
        provision = MagicMock()
        provision.synced_id.side_effect = lambda table: f'lake.ref.{table}'
        spec = importlib.util.spec_from_file_location('sync_demo_test', Path(__file__).parents[1] / 'app/sync_demo.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, db=self.db, provision=provision):
            spec.loader.exec_module(self.module)

    def test_cdf_pairs_updates_and_keeps_repeated_key_changes(self):
        events = [{'row_id': 'a', 'demo_value': v, '_change_type': k, '_commit_version': n} for v, k, n in
                  [(100, 'insert', 1), (100, 'update_preimage', 2), (110, 'update_postimage', 2), (110, 'delete', 3)]]
        changes = self.module._changes(events)
        self.assertEqual([(c['op'], c['before'], c['after']) for c in changes],
                         [('insert', None, 100), ('update', 100, 110), ('delete', 110, None)])

    def test_pending_compares_current_values_and_checks_synced_version(self):
        events = [{'row_id': k, 'demo_value': v, '_change_type': op, '_commit_version': n} for k, v, op, n in
                  [('new', 100, 'insert', 1), ('old', 10, 'update_preimage', 2),
                   ('old', 20, 'update_postimage', 2), ('deleted', 30, 'delete', 3)]]
        delta = [{'row_id': 'new', 'demo_value': 100}, {'row_id': 'old', 'demo_value': 20}]
        lake = [{'row_id': 'old', 'demo_value': 10}, {'row_id': 'deleted', 'demo_value': 30}]
        status = self.db.w.postgres.get_synced_table.return_value.status
        for synced, actual_lake, expected in ((0, lake, 'stale'), (2, delta, 'in_sync'), (3, delta, 'in_sync')):
            with patch.object(self.module, '_version', return_value=3), patch.object(self.module, '_base', return_value=0):
                status.last_sync.delta_table_sync_info.delta_commit_version = synced
                self.db.dbsql.side_effect = [events, delta]
                self.db.pg.return_value = actual_lake
                result = self.module._pending()
            self.assertEqual([r['status'] for r in result['pending']], [expected] * 3)
            self.assertEqual(result['sync_complete'], synced == 3)
        self.assertIn('table_changes', self.db.dbsql.call_args_list[-2].args[0])

    def test_changes_only_mutate_fixed_tagged_demo_table_and_avoid_touched_keys(self):
        current = {'sync_complete': False, 'delta_version': 3, 'pending': [{'pk': 'inserted'}]}
        after = {**current, 'delta_version': 4}
        for op in ('insert', 'update', 'delete'):
            self.db.dbsql.reset_mock()
            self.db.dbsql.return_value = [{'row_id': 'seed-first', 'demo_value': 100},
                                         {'row_id': 'inserted', 'demo_value': 100}]
            with patch.object(self.module, '_pending', side_effect=[current, after]):
                result = self.module.delta_change(self.module.DeltaChangeIn(op=op))
            statement, params = self.db.dbsql.call_args.args
            self.assertIn('test.demo.sync_demo', statement)
            self.assertEqual(params['tag'], self.module.TAG)
            if op != 'insert':
                self.assertEqual(params['pk'], 'seed-first')
                self.assertIn('AND tag = :tag', statement)
            self.assertEqual(result['change']['op'], op)
        self.db.pg.assert_not_called()  # incomplete batches retain their persisted cursor

    def test_completed_batch_advances_cursor_on_next_change_only(self):
        completed = {'sync_complete': True, 'delta_version': 5, 'pending': []}
        with patch.object(self.module, '_version', side_effect=[5, 6]), patch.object(self.module, '_pending', side_effect=[completed, completed]):
            self.module.delta_change(self.module.DeltaChangeIn(op='insert'))
        self.db.pg.assert_called_once_with('UPDATE sync_experiment.batch SET base_version=%(v)s WHERE id=1', {'v': 5})

    def test_empty_table_delete_creates_only_a_tagged_candidate(self):
        current = {'sync_complete': False, 'delta_version': 3, 'pending': []}
        self.db.dbsql.return_value = []
        with patch.object(self.module, '_version', side_effect=[3, 4]), patch.object(self.module, '_pending', side_effect=[current, current]):
            result = self.module.delta_change(self.module.DeltaChangeIn(op='delete'))
        self.assertIsNone(result['change']['after'])
        self.assertEqual(result['change']['before'], 100)
        self.assertIn('INSERT INTO test.demo.sync_demo', self.db.dbsql.call_args_list[-2].args[0])
        self.assertIn('DELETE FROM test.demo.sync_demo', self.db.dbsql.call_args.args[0])

    def test_initial_copy_is_retryable_before_lakebase_table_exists(self):
        self.db.w.postgres.get_synced_table.return_value.status.last_sync = None
        with patch.object(self.module, '_version', return_value=1), patch.object(self.module, '_base', return_value=1), \
             self.assertRaises(HTTPException) as caught:
            self.module._pending()
        self.assertEqual(caught.exception.status_code, 503)
        self.db.pg.assert_not_called()

    def test_no_arbitrary_sql_or_operation(self):
        for body in ({'op': 'truncate'}, {'op': 'delete', 'sql': 'DELETE FROM targets'}):
            with self.assertRaises(ValidationError):
                self.module.DeltaChangeIn(**body)

    def test_history_ignores_maintenance_commits(self):
        self.db.dbsql.return_value = [
            {'version': 9, 'operation': 'OPTIMIZE'}, {'version': 8, 'operation': 'UPDATE'},
            {'version': 7, 'operation': 'WRITE'}]
        self.assertEqual(self.module._version(), 8)

    def test_busy_mutation_rejects_without_warehouse_calls(self):
        with self.module.mutation(), self.assertRaises(HTTPException) as caught:
            self.module.delta_change(self.module.DeltaChangeIn(op='insert'))
        self.assertEqual(caught.exception.status_code, 409)
        self.db.dbsql.assert_not_called()

    def test_pending_coalesces_polls_without_mutation_lock(self):
        async def run():
            with self.module.mutation(), patch.object(self.module, '_pending', return_value={'pending': []}) as read:
                results = await asyncio.gather(*(self.module.pending() for _ in range(50)))
                self.assertEqual(len(results), 50)
                read.assert_called_once()
        asyncio.run(run())

    def test_mutation_releases_lock_before_response_reads(self):
        def read():
            self.assertFalse(self.module.lock.locked())
            return {'sync_complete': False, 'delta_version': 3, 'pending': []}
        with patch.object(self.module, '_pending', side_effect=read), patch.object(self.module, '_version', return_value=3):
            self.module.delta_change(self.module.DeltaChangeIn(op='insert'))

    def test_preparation_invalidated_by_another_writer_returns_conflict(self):
        def prepared():
            self.module._revision += 1
            return {'sync_complete': True, 'delta_version': 3, 'pending': []}
        with patch.object(self.module, '_pending', side_effect=prepared), self.assertRaises(HTTPException) as caught:
            self.module.delta_change(self.module.DeltaChangeIn(op='insert'))
        self.assertEqual(caught.exception.status_code, 409)
        self.db.dbsql.assert_not_called()
        self.db.pg.assert_not_called()

    def test_base_does_not_issue_request_time_ddl(self):
        self.db.pg.return_value = [{'base_version': 3}]
        self.assertEqual(self.module._base(4), 3)
        self.assertFalse(any('CREATE ' in c.args[0] for c in self.db.pg.call_args_list))


    def test_daily_batch_is_one_tagged_merge_with_disjoint_keys_and_bounded_counts(self):
        current = {'sync_complete': True, 'delta_version': 5, 'pending': []}
        after = {'sync_complete': False, 'delta_version': 6, 'pending': []}
        candidates = [{'row_id': f'baseline-{i}', 'demo_value': i} for i in range(100)]
        self.db.dbsql.return_value = candidates
        with patch.object(self.module, '_pending', side_effect=[current, after]):
            self.assertEqual(self.module.daily_batch(), after)
        self.assertEqual(self.db.dbsql.call_count, 2)  # read candidates, then one commit
        statement, params = self.db.dbsql.call_args.args
        self.assertIn('MERGE INTO test.demo.sync_demo', statement)
        self.assertIn('target.tag = :tag', statement)
        self.assertEqual(params['tag'], self.module.TAG)
        changes = json.loads(params['changes'])
        self.assertEqual(len(changes), len({c['row_id'] for c in changes}))
        for op, lower, upper in [('insert', 250, 400), ('update', 15, 35), ('delete', 1, 5)]:
            count = sum(c['op'] == op for c in changes)
            self.assertTrue(lower <= count <= upper)
        originals = {c['row_id']: c['demo_value'] for c in candidates}
        for change in changes:
            if change['op'] == 'update':
                self.assertGreater(change['demo_value'], originals[change['row_id']])
            elif change['op'] == 'delete':
                self.assertIn(change['row_id'], originals)
            else:
                self.assertNotIn(change['row_id'], originals)
        self.db.pg.assert_called_once_with('UPDATE sync_experiment.batch SET base_version=%(v)s WHERE id=1', {'v': 5})

    def test_daily_batch_requires_completed_sync(self):
        with patch.object(self.module, '_pending', return_value={'sync_complete': False}), self.assertRaises(HTTPException) as caught:
            self.module.daily_batch()
        self.assertEqual(caught.exception.status_code, 409)
        self.db.dbsql.assert_not_called()
        self.db.pg.assert_not_called()

    def test_daily_batch_requires_baseline_and_does_not_write_on_failure(self):
        self.db.dbsql.return_value = []
        with patch.object(self.module, '_pending', return_value={'sync_complete': True}), self.assertRaises(HTTPException) as caught:
            self.module.daily_batch()
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.db.dbsql.call_count, 1)
        self.db.pg.assert_not_called()

    def test_daily_batch_busy_rejects_before_preparation(self):
        with self.module.mutation(), self.assertRaises(HTTPException) as caught:
            self.module.daily_batch()
        self.assertEqual(caught.exception.status_code, 409)
        self.db.dbsql.assert_not_called()

    def test_daily_batch_rejects_stale_preparation(self):
        def candidates(*args):
            self.module._revision += 1
            return [{'row_id': str(i), 'demo_value': i} for i in range(100)]
        self.db.dbsql.side_effect = candidates
        with patch.object(self.module, '_pending', return_value={'sync_complete': True}), self.assertRaises(HTTPException) as caught:
            self.module.daily_batch()
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(self.db.dbsql.call_count, 1)
        self.db.pg.assert_not_called()


    def test_one_commit_batch_counts_updates_once_despite_preimages(self):
        events = []
        for op, count in [('insert', 300), ('update', 25), ('delete', 2)]:
            for i in range(count):
                kinds = ['update_preimage', 'update_postimage'] if op == 'update' else [op]
                for kind in kinds:
                    events.append({'row_id': f'{op}-{i}', 'demo_value': 110 if kind == 'update_postimage' else 100,
                                   '_change_type': kind, '_commit_version': 6})
        changes = self.module._changes(events)
        self.assertEqual(len(changes), 327)
        self.assertEqual({op: sum(c['op'] == op for c in changes) for op in ['insert', 'update', 'delete']},
                         {'insert': 300, 'update': 25, 'delete': 2})

    def test_source_cache_reuses_evidence_but_expires_and_tracks_mutations(self):
        self.db.dbsql.return_value = [{'row_id': 'a', 'demo_value': 100}]
        with patch.object(self.module, '_version', return_value=3) as version, \
             patch.object(self.module, '_base', return_value=3), \
             patch.object(self.module.time, 'monotonic', return_value=100) as clock:
            first = self.module._source(cached=True)
            self.assertEqual(self.module._source(cached=True), first)
            version.assert_called_once()
            self.module._revision += 1
            self.module._source(cached=True)
            self.assertEqual(version.call_count, 2)
            clock.return_value = 131
            self.module._source(cached=True)
            self.assertEqual(version.call_count, 3)
            self.module._source()  # mutation preparations never trust GET cache
            self.assertEqual(version.call_count, 4)

    def test_cached_source_still_reads_lakebase_and_pipeline_on_every_poll(self):
        snapshot = (3, [{'row_id': 'a', 'demo_value': 100,
                         '_change_type': 'insert', '_commit_version': 3}], {'a': 100})
        status = self.db.w.postgres.get_synced_table.return_value.status
        status.last_sync.delta_table_sync_info.delta_commit_version = 2
        status.last_sync.sync_end_time.ToJsonString.return_value = '2026-10-27T12:00:00Z'
        status.detailed_state.value = 'SYNCED_TABLE_ONLINE_UPDATING'
        self.db.pg.return_value = []
        with patch.object(self.module, '_source', return_value=snapshot):
            before = self.module._pending(cached_source=True)
            status.last_sync.delta_table_sync_info.delta_commit_version = 3
            status.detailed_state.value = 'SYNCED_TABLE_ONLINE_NO_PENDING_UPDATE'
            self.db.pg.return_value = [{'row_id': 'a', 'demo_value': 100}]
            after = self.module._pending(cached_source=True)
        self.assertFalse(before['sync_complete'])
        self.assertTrue(before['running'])
        self.assertTrue(after['sync_complete'])
        self.assertFalse(after['running'])
        self.assertEqual(after['completed_at'], '2026-10-27T12:00:00Z')
        self.assertEqual(self.db.pg.call_count, 2)
        self.assertEqual(self.db.w.postgres.get_synced_table.call_count, 2)
        self.db.dbsql.assert_not_called()

    def test_refresh_does_not_cache_a_read_crossing_a_mutation(self):
        def read(**kwargs):
            self.assertTrue(kwargs['cached_source'])
            self.module._revision += 1
            return {'sync_complete': True}
        with patch.object(self.module, '_pending', side_effect=read):
            self.assertEqual(asyncio.run(self.module._refresh()), {'sync_complete': True})
        self.assertIsNone(self.module._poll_cache)

    def test_progress_bypasses_response_cache_and_coalesces_readers(self):
        async def run():
            self.module._poll_cache = (self.module.time.monotonic(), {'sync_complete': False})
            with patch.object(self.module, '_pending', return_value={'sync_complete': True}) as read:
                self.assertFalse((await self.module.pending())['sync_complete'])
                read.assert_not_called()
                results = await asyncio.gather(*(self.module.pending(progress=True) for _ in range(20)))
                self.assertTrue(all(r['sync_complete'] for r in results))
                read.assert_called_once_with(cached_source=True)
        asyncio.run(run())
