"""Live backend experiment. Uses the same app URL + OAuth bearer auth as smoke.sh.

Run: python3 scripts/benchmark.py part1|part2|diagnostics --output results.jsonl
No credentials are written to the output. Times are milliseconds.
"""
import argparse
import os
import json
import subprocess
import time
import urllib.error
import urllib.request


def cli(*args):
    return json.loads(subprocess.check_output(["databricks", *args, "-p", os.environ["PROFILE"], "-o", "json"]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("part", choices=("part1", "part2", "diagnostics"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--rows", type=int, choices=(100_000, 1_000_000, 2_000_000, 5_000_000),
                        help="Restrict part2 to one tier")
    parser.add_argument("--timeout-seconds", type=int, choices=range(1, 26),
                        help="Single-scan analytics override; defaults remain unchanged")
    args = parser.parse_args()
    url = cli("apps", "get", "lakebase-demo-app")["url"]
    token = cli("auth", "token")["access_token"]

    def call(path, body=None, label=None):
        started = time.perf_counter()
        request = urllib.request.Request(url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            result = {"http_error": exc.code, "detail": exc.read().decode()}
        record = {"label": label or path, "request": body, "response": result,
                  "client_wall_ms": round((time.perf_counter() - started) * 1000, 2)}
        with open(args.output, "a") as out:
            out.write(json.dumps(record) + "\n")
        print(json.dumps(record), flush=True)

    call("/api/h2h/diagnostics")
    if args.part == "part1":
        call("/api/h2h/warmup", {}, "warmup")
        call("/api/h2h/batch", {"action": "rep_scorecard", "n": 20}, "sequential20")
        for users, queries in ((10, 5), (25, 3), (50, 3)):
            for repetition in range(1, 4):
                call("/api/h2h/concurrent", {"action": "rep_scorecard", "users": users, "per_user": queries},
                     f"{users}x{queries}-{repetition}")
    elif args.part == "part2":
        call("/api/h2h/warmup", {}, "warmup")
        for rows in ((args.rows,) if args.rows else (100_000, 1_000_000, 2_000_000, 5_000_000)):
            for repetition in range(1, 4):
                body = {"rows": rows, "repetitions": 1}
                if args.timeout_seconds is not None:
                    body.update(repetitions=1, timeout_seconds=args.timeout_seconds)
                call("/api/h2h/analytics", body,
                     f"{rows}-{repetition}")


if __name__ == "__main__":
    main()
