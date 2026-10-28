"""Verify approved benchmark defaults and the fixed demo-only branching experiment live."""
import argparse
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
    parser = argparse.ArgumentParser()
    parser.add_argument('--branching-only', action='store_true')
    parser.add_argument('--skip-analytics', action='store_true')
    args = parser.parse_args()
    url = cli('apps', 'get', 'lakebase-demo-app')['url']
    token = cli('auth', 'token')['access_token']
    output = Path('docs/benchmarks/2026-10-24-productionize.jsonl')

    def call(path, body=None, expected=200):
        started = time.perf_counter()
        request = urllib.request.Request(url + '/api/' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status, result = response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            status, result = exc.code, json.load(exc)
        record = {'path': path, 'request': body, 'status': status, 'response': result,
                  'client_wall_ms': round((time.perf_counter() - started) * 1000, 2)}
        with output.open('a') as stream:
            stream.write(json.dumps(record) + '\n')
        print(json.dumps(record), flush=True)
        assert status == expected, record
        return result

    if not args.branching_only:
        call('h2h/warmup', {})
        if not args.skip_analytics:
            for rows in (100000, 1000000, 2000000, 5000000):
                r = call('h2h/analytics', {'rows': rows})
                assert r['results_equal'] and r['scanned_rows'] == {'lakebase': rows, 'dbsql': rows}, r
                assert r['wall_ms'] < 28000, r
        r = call('h2h/concurrent', {'action': 'rep_scorecard', 'users': 50, 'per_user': 3})
        assert not r['lakebase']['errors'] and not r['dbsql']['errors'] and r['wall_ms'] < 30000, r
    initial = call('branching/experiment')
    call('branching/reset', {})
    assert call('branching/experiment')['applied_steps'] == []
    call('branching/add-column', {})
    half = call('branching/test-change', {'branch': 'demo', 'step': 'halve_sample_amounts'})
    assert half['affected_rows'] == 3
    assert all(r['amount'] == r['before_amount'] / 2 for r in half['sample_rows'])
    call('branching/test-change', {'branch': 'demo', 'step': 'halve_sample_amounts'}, 409)
    call('branching/test-change', {'branch': 'production', 'step': 'drop_service_line'}, 422)
    call('branching/test-change', {'branch': 'demo', 'step': 'drop_service_line', 'sql': 'SELECT 1'}, 422)
    drop = call('branching/test-change', {'branch': 'demo', 'step': 'drop_service_line'})
    assert 'service_line' not in drop['state']['demo']
    current = call('branching/experiment')
    assert current['applied_steps'] == ['add_win_probability', 'halve_sample_amounts', 'drop_service_line']
    assert current['production_samples'] == initial['production_samples']
    assert current['state']['production'] == initial['state']['production']
    assert call('branching/experiment') == current
    call('branching/reset', {})
    reset = call('branching/experiment')
    assert reset['applied_steps'] == []
    assert reset['production_samples'] == initial['production_samples'] == reset['demo_samples']
    assert reset['state']['production'] == initial['state']['production'] == reset['state']['demo']
    print('All live backend assertions passed', flush=True)


if __name__ == '__main__':
    main()
