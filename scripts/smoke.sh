#!/usr/bin/env bash
# LeadWorks smoke: health plus a source → lead round-trip against a live server.
# Usage: WID=<workspace-id> bash scripts/smoke.sh (defaults to the demo workspace)
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${LEADWORKS_URL:-http://127.0.0.1:3300}"
WID="${WID:-cmu99qk5y0000ni35n530i6ld}"
# Tenant isolation: every /api route except /health needs a workspace API key.
KEY="${API_KEY:-$(npm run seed:key 2>&1 | grep -oE '[a-z]+_live_[A-Za-z0-9_-]+' | head -1)}"
AUTH=(-H "Authorization: Bearer $KEY")
PASS=0
FAIL=0

check() { # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "  PASS  $1"; PASS=$((PASS + 1));
  else echo "  FAIL  $1 (expected '$2', got '$3')"; FAIL=$((FAIL + 1)); fi
}

echo "--- health ---"
check "no key is rejected" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/leads?workspaceId=$WID")"
check "health answers" 200 "$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/health")"
check "database is up" "up" "$(curl -s "${AUTH[@]}" --max-time 10 "$BASE/api/health" | python3 -c 'import json,sys;print(json.load(sys.stdin)["db"])')"

echo "--- sources ---"
SRC=$(curl -s "${AUTH[@]}" --max-time 10 "$BASE/api/sources?workspaceId=$WID")
check "sources list" "true" "$(printf '%s' "$SRC" | python3 -c 'import json,sys;print(isinstance(json.load(sys.stdin)["sources"],list))' | tr A-Z a-z)"

echo "--- leads ---"
STAMP=$(date +%s)
LEAD=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/leads" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"email\":\"smoke.$STAMP@probe.test\",\"firstName\":\"Smoke\",\"company\":\"Probe Co\"}")
LID=$(printf '%s' "$LEAD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
check "lead creates with email" "smoke.$STAMP@probe.test" "$(printf '%s' "$LEAD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["email"])')"
check "lead reads back" "Probe Co" "$(curl -s "${AUTH[@]}" --max-time 10 "$BASE/api/leads/$LID" | python3 -c 'import json,sys;print(json.load(sys.stdin)["company"])')"
check "lead qualifies" "QUALIFIED" "$(curl -s "${AUTH[@]}" --max-time 15 -X PATCH "$BASE/api/leads/$LID" -H 'Content-Type: application/json' -d '{"status":"QUALIFIED"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')"
check "lead deletes" 200 "$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' --max-time 10 -X DELETE "$BASE/api/leads/$LID")"

echo "--- jobs ---"
check "jobs list" "true" "$(curl -s "${AUTH[@]}" --max-time 10 "$BASE/api/jobs?workspaceId=$WID" | python3 -c 'import json,sys;print(isinstance(json.load(sys.stdin)["jobs"],list))' | tr A-Z a-z)"

echo "--- exports (create -> worker completes -> download streams) ---"
EXP=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/exports" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"format\":\"csv\",\"fields\":[\"email\",\"firstName\",\"company\"]}")
EXPID=$(printf '%s' "$EXP" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("export",{}).get("id",""))')
check "export created (201)" "true" "$(printf '%s' "$EXPID" | python3 -c 'import sys;print(len(sys.stdin.read().strip())>0)' | tr A-Z a-z)"
ESTATE="PENDING"
for _ in $(seq 1 15); do
  ESTATE=$(curl -s "${AUTH[@]}" --max-time 10 "$BASE/api/exports/$EXPID" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status",""))')
  if [ "$ESTATE" = "COMPLETED" ] || [ "$ESTATE" = "FAILED" ]; then break; fi
  sleep 2
done
check "export worker completes it" "COMPLETED" "$ESTATE"
check "download URL issued" "true" "$(curl -s "${AUTH[@]}" --max-time 10 -X POST "$BASE/api/exports/$EXPID?action=download" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(bool(json.load(sys.stdin).get("downloadUrl")))' | tr A-Z a-z)"
DLURL=$(curl -s "${AUTH[@]}" --max-time 10 -X POST "$BASE/api/exports/$EXPID?action=download" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("downloadUrl",""))')
check "download streams CSV" "text/csv" "$(curl -s "${AUTH[@]}" --max-time 15 -o /dev/null -w '%{content_type}' "$BASE$DLURL" | cut -d';' -f1)"

echo "--- ai explain-lead (explains the score, never changes it) ---"
ALEAD=$(curl -s "${AUTH[@]}" --max-time 15 -X POST "$BASE/api/leads" -H 'Content-Type: application/json' \
  -d "{\"workspaceId\":\"$WID\",\"email\":\"ai.$STAMP@probe.test\",\"firstName\":\"Aiprobe\",\"company\":\"ProbeCo\",\"title\":\"VP Sales\"}")
ALID=$(printf '%s' "$ALEAD" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
EXPL=$(curl -s "${AUTH[@]}" --max-time 20 "$BASE/api/ai/explain-lead?id=$ALID")
check "explain-lead answers (200)" "200" "$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/api/ai/explain-lead?id=$ALID")"
check "deterministic score returned" "true" "$(printf '%s' "$EXPL" | python3 -c 'import json,sys;print(isinstance(json.load(sys.stdin).get("score"),int))' | tr A-Z a-z)"
check "explanation or honest no-key" "true" "$(printf '%s' "$EXPL" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("explained",False) is True or d.get("configured",True) is False)' | tr A-Z a-z)"
check "explain-lead rejects anon" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/ai/explain-lead?id=$ALID")"
curl -s "${AUTH[@]}" --max-time 10 -X DELETE "$BASE/api/leads/$ALID" > /dev/null

echo "================================"
echo "  $PASS passed, $FAIL failed"
echo "================================"
[[ "$FAIL" -eq 0 ]]
