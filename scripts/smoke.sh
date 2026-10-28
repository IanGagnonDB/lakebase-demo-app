#!/usr/bin/env bash
# Live API smoke test for the deployed app. Usage: PROFILE=<profile> scripts/smoke.sh
# Every call is a plain assignment, so any failed request stops the script (set -e).
set -euo pipefail
: "${PROFILE:?Set PROFILE to your Databricks CLI profile}"
URL=$(databricks apps get lakebase-demo-app -p "$PROFILE" -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
TOKEN=$(databricks auth token -p "$PROFILE" -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

api() {  # api METHOD PATH [JSON]
  local args=(-sSf -m 300 -X "$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
  [ $# -ge 3 ] && args+=(-d "$3")
  curl "${args[@]}" "$URL$2"
}
get() { python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)$1))"; }

# Check recovery state before warmup or any other mutation. Never repair it here.
r=$(api GET /api/demo/reset)
echo "$r" | python3 -c '
import json, sys
state = json.load(sys.stdin)
if state["status"] in {"running", "failed"}:
    sys.exit("smoke: Demo reset unfinished (" + state["status"] + "). Finish Reset demo, then re-run.")
'
r=$(api GET /api/pitr/state)
echo "$r" | python3 -c '
import json, sys
state = json.load(sys.stdin)
recovery = state["recovery"]
if recovery is not None:
    sys.exit("smoke: PITR recovery pending (" + str(len(recovery["ids"])) +
             " rows deleted at " + str(recovery["before_ts"]) +
             "). Finish it in the PITR tab (Copy back) or click Reset demo, then re-run.")
'
r=$(api GET /api/branching/state)
echo "$r" | python3 -c '
import json, sys
state = json.load(sys.stdin)
if state.get("recoverable"):
    sys.exit("smoke: Branching reset unfinished. Finish Reset in the Branching tab or click Reset demo, then re-run.")
'

r=$(api GET /api/meta);                      echo "provisioning: $(echo "$r" | get "['provisioning']")"
api POST /api/h2h/warmup >/dev/null
for a in rep_scorecard pipeline_list log_activity region_leaderboard; do
  lb=$(api POST "/api/h2h/lakebase/$a" | get "['server_ms']")
  db=$(api POST "/api/h2h/dbsql/$a" | get "['server_ms']")
  echo "$a: lakebase $lb ms, dbsql $db ms"
done
r=$(api POST /api/h2h/batch '{"action":"rep_scorecard","n":20}'); echo "batch x20 speedup: $(echo "$r" | get "['speedup']")x"
r=$(api POST /api/sync/edit-target '{"rep_id":3,"visits_target":77}'); echo "sync edit: $r"
api POST /api/sync/trigger >/dev/null
r=$(api POST /api/cdf/change '{"op":"insert","table":"activities"}'); PK=$(echo "$r" | get "['pk']")
r=$(api POST /api/branching/add-column);    echo "branching add-column: $(echo "$r" | get "['only_on_demo']")"
r=$(api POST /api/branching/reset);         echo "branching reset: $(echo "$r" | get "['only_on_demo']")"
DEL=$(api POST /api/pitr/delete)
TS=$(echo "$DEL" | get "['before_ts']"); IDS=$(echo "$DEL" | get "['ids']")
r=$(api POST /api/pitr/restore "{\"before_ts\":$TS,\"ids\":$IDS}"); echo "pitr restore: $(echo "$r" | get "['found']") found"
r=$(api POST /api/pitr/copy-back "{\"ids\":$IDS}");               echo "pitr copy-back: $(echo "$r" | get "['copied']") copied"
r=$(api POST /api/scaling/wake);            echo "scaling wake: $r"
sleep 30
r=$(api GET '/api/sync/compare?rep_id=3');  echo "sync compare: $r"
r=$(api GET "/api/cdf/history?table=activities&pk=$PK"); echo "cdf history: $(echo "$r" | get "['status']")"
api POST /api/cdf/change '{"op":"delete","table":"activities"}' >/dev/null
echo "smoke OK"
