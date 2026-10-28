#!/usr/bin/env bash
# Run the UI against the deployed app's real API. Usage: PROFILE=<cli-profile> scripts/dev-live.sh [-- --port 5180]
set -euo pipefail
: "${PROFILE:?Set PROFILE to your Databricks CLI profile}"
cd "$(dirname "$0")/.."
APP_URL=$(databricks apps get lakebase-demo-app -p "$PROFILE" -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['url'])")
DATABRICKS_TOKEN=$(databricks auth token -p "$PROFILE" -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
export APP_URL DATABRICKS_TOKEN
exec npm run dev:live "$@"
