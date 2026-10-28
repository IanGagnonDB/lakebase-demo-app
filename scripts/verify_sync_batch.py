"""Live verification of tagged Delta CRUD followed by one triggered sync."""
import os
import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


def cli(*args):
    return json.loads(subprocess.check_output(['databricks', *args, '-p', os.environ['PROFILE'], '-o', 'json']))


def main():
    url = cli('apps', 'get', 'lakebase-demo-app')['url']
    token = cli('auth', 'token')['access_token']
    output = Path('docs/benchmarks/2026-10-24-sync-batch.jsonl')

    def call(path, body=None, expected=200):
        t0 = time.perf_counter()
        req = urllib.request.Request(url + '/api/' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                status, result = response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            status = exc.code
            raw = exc.read().decode()
            try:
                result = json.loads(raw)
            except json.JSONDecodeError:
                result = {"detail": raw}
        record = {'path': path, 'request': body, 'status': status, 'response': result,
                  'client_wall_ms': round((time.perf_counter() - t0) * 1000, 2)}
        with output.open('a') as stream:
            stream.write(json.dumps(record) + '\n')
        print(json.dumps(record), flush=True)
        assert status in (expected if isinstance(expected, tuple) else (expected,)), record
        return result

    # Initial triggered sync must have copied the two tagged baseline candidates.
    deadline = time.monotonic() + 600
    while True:
        meta = call('meta')
        if meta['provisioning'].get('synced_tables') == 'ok':
            break
        assert not str(meta['provisioning'].get('synced_tables')).startswith('error:'), meta
        assert time.monotonic() < deadline, 'Provisioning exceeded ten minutes; inspect before continuing'
        time.sleep(5)
    while not call('sync/pending', expected=(200, 503)).get('sync_complete'):
        assert time.monotonic() < deadline, 'Initial copy did not finish within ten minutes'
        time.sleep(5)
    for op in ('insert', 'update', 'delete'):
        result = call('sync/delta-change', {'op': op})
        assert result['change']['op'] == op
    pending = call('sync/pending')
    assert len(pending['pending']) == 3 and len({r['pk'] for r in pending['pending']}) == 3, pending
    assert all(r['status'] == 'stale' for r in pending['pending']), pending
    call('sync/delta-change', {'op': 'truncate'}, 422)
    call('sync/delta-change', {'op': 'delete', 'sql': 'SELECT 1'}, 422)
    started = time.perf_counter()
    trigger = call('sync/trigger', {})
    assert set(trigger['updates']) == {'targets', 'sync_demo'}
    deadline = time.monotonic() + 600
    while True:
        result = call('sync/pending')
        if result['sync_complete'] and all(r['status'] == 'in_sync' for r in result['pending']):
            break
        assert time.monotonic() < deadline, 'Sync exceeded ten minutes; inspect before continuing'
        time.sleep(3)
    elapsed = round(time.perf_counter() - started, 3)
    assert len(result['pending']) == 3
    retained = call('sync/pending')
    assert retained['pending'] == result['pending']
    record = {'label': 'sync_latency', 'seconds': elapsed, 'delta_version': result['delta_version'],
              'synced_version': result['synced_version'], 'rows': len(result['pending'])}
    with output.open('a') as stream:
        stream.write(json.dumps(record) + '\n')
    print(json.dumps(record), flush=True)


if __name__ == '__main__':
    main()
