#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/ci-common.sh"

export OPENCLAW_VERSION=${OPENCLAW_VERSION:-2026.3.13}
export OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-bastion-ci-token}
export OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT:-18789}
export BASTION_PORT=${BASTION_PORT:-3000}
export BASTION_SERVER_URL=${BASTION_SERVER_URL:-"http://127.0.0.1:${BASTION_PORT}"}
export URL_PATTERN=${URL_PATTERN:-https://postman-echo.com/**}
export ACTION=${ACTION:-postman.echo}
export ALLOWED_URL=${ALLOWED_URL:-https://postman-echo.com/post?source=bastion-ci}
export BYPASS_URL=${BYPASS_URL:-https://postman-echo.com/get?source=bastion-ci}
export NODE_ENV=${NODE_ENV:-test}

require_env DATABASE_URL REDIS_URL MASTER_KEY PROJECT_API_KEY
PLUGIN_TARBALL=$(ensure_plugin_tarball "${PLUGIN_TARBALL:-}")

setup_openclaw_env

tmp_dir=$(mktemp -d)
api_log="$tmp_dir/bastion-api.log"
gateway_log="$tmp_dir/openclaw-gateway.log"
allowed_response_file="$tmp_dir/allowed-response.json"
audit_response_file="$tmp_dir/audit-response.json"
bypass_response_file="$tmp_dir/bypass-response.json"

cleanup() {
  local exit_code=$?

  if [[ -n "${GATEWAY_PID:-}" ]] && kill -0 "$GATEWAY_PID" >/dev/null 2>&1; then
    kill "$GATEWAY_PID" >/dev/null 2>&1 || true
    wait "$GATEWAY_PID" >/dev/null 2>&1 || true
  fi

  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" >/dev/null 2>&1; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi

  if [[ "$exit_code" -ne 0 ]]; then
    if [[ -f "$api_log" ]]; then
      printf '\n--- Bastion API log ---\n' >&2
      sed -n '1,200p' "$api_log" >&2 || true
    fi
    if [[ -f "$gateway_log" ]]; then
      printf '\n--- OpenClaw gateway log ---\n' >&2
      sed -n '1,200p' "$gateway_log" >&2 || true
    fi
  fi

  rm -rf "$tmp_dir" "$OPENCLAW_STATE_DIR"
  exit "$exit_code"
}

trap cleanup EXIT

wait_for_gateway_tools_invoke() {
  local attempts=${1:-60}
  local url="http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/tools/invoke"
  local i
  for ((i = 0; i < attempts; i += 1)); do
    local code
    code=$(
      curl -sS -o /dev/null -w '%{http_code}' \
        -X POST "$url" \
        -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
        -H 'Content-Type: application/json' \
        -d '{}' || true
    )
    if [[ "$code" == "400" || "$code" == "404" || "$code" == "500" ]]; then
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for OpenClaw gateway HTTP API"
}

log "Installing plugin tarball"
run_openclaw plugins install "$PLUGIN_TARBALL" >/dev/null

log "Preparing Bastion API"
(
  cd "$REPO_DIR"
  npm run db:generate --workspace=packages/api >/dev/null
  npx prisma migrate deploy --schema "$REPO_DIR/packages/api/prisma/schema.prisma" >/dev/null
  npm run build --workspace=packages/api >/dev/null
)

log "Starting Bastion API"
(
  cd "$REPO_DIR"
  PORT="$BASTION_PORT" \
  BASE_URL="$BASTION_SERVER_URL" \
  DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="$REDIS_URL" \
  MASTER_KEY="$MASTER_KEY" \
  PROJECT_API_KEY="$PROJECT_API_KEY" \
  NODE_ENV="$NODE_ENV" \
  npm run start --workspace=packages/api >"$api_log" 2>&1
) &
API_PID=$!

wait_for_url "$BASTION_SERVER_URL/health/live"

log "Seeding Bastion agent"
agent_response=$(curl -fsS \
  -X POST "$BASTION_SERVER_URL/v1/agents" \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H 'Content-Type: application/json' \
  --data @"$FIXTURE_DIR/seed-agent.json")

export AGENT_ID
AGENT_ID=$(node -e 'const payload=JSON.parse(process.argv[1]); process.stdout.write(payload.id);' "$agent_response")
export BASTION_AGENT_SECRET
BASTION_AGENT_SECRET=$(node -e 'const payload=JSON.parse(process.argv[1]); process.stdout.write(payload.agentSecret);' "$agent_response")

log "Seeding Bastion credential"
render_fixture "$FIXTURE_DIR/seed-credential.json" "$tmp_dir/seed-credential.json"
credential_response=$(curl -fsS \
  -X POST "$BASTION_SERVER_URL/v1/credentials" \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H 'Content-Type: application/json' \
  --data @"$tmp_dir/seed-credential.json")

export CREDENTIAL_ID
CREDENTIAL_ID=$(node -e 'const payload=JSON.parse(process.argv[1]); process.stdout.write(payload.id);' "$credential_response")

log "Seeding Bastion policy"
render_fixture "$FIXTURE_DIR/seed-policy.json" "$tmp_dir/seed-policy.json"
curl -fsS \
  -X POST "$BASTION_SERVER_URL/v1/policies" \
  -H "Authorization: Bearer $PROJECT_API_KEY" \
  -H 'Content-Type: application/json' \
  --data @"$tmp_dir/seed-policy.json" >/dev/null

log "Writing OpenClaw config"
merge_fixture_into_config "$FIXTURE_DIR/openclaw.valid.json"

log "Starting OpenClaw gateway"
OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
BASTION_AGENT_SECRET="$BASTION_AGENT_SECRET" \
npx -y "openclaw@${OPENCLAW_VERSION}" gateway run \
  --allow-unconfigured \
  --token "$OPENCLAW_GATEWAY_TOKEN" \
  --port "$OPENCLAW_GATEWAY_PORT" >"$gateway_log" 2>&1 &
GATEWAY_PID=$!

wait_for_gateway_tools_invoke

log "Invoking bastion_fetch through OpenClaw"
render_fixture "$FIXTURE_DIR/tool-invoke.allowed.json" "$tmp_dir/tool-invoke.allowed.json"
curl -fsS \
  -X POST "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/tools/invoke" \
  -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data @"$tmp_dir/tool-invoke.allowed.json" >"$allowed_response_file"

node - "$allowed_response_file" "$CREDENTIAL_ID" "$ACTION" <<'NODE'
const fs = require('node:fs');

const responsePath = process.argv[2];
const expectedCredentialId = process.argv[3];
const expectedAction = process.argv[4];

const payload = JSON.parse(fs.readFileSync(responsePath, 'utf8'));

if (payload.ok !== true) {
  throw new Error(`Expected ok=true from bastion_fetch, got: ${JSON.stringify(payload)}`);
}

const details = payload.result?.details;
if (!details || typeof details !== 'object') {
  throw new Error('Missing tool result details from bastion_fetch');
}

if (details.status !== 200) {
  throw new Error(`Expected proxied HTTP status 200, got ${details.status}`);
}

if (details._bastion?.credentialId !== expectedCredentialId) {
  throw new Error('Unexpected Bastion credentialId in tool result');
}

if (details._bastion?.action !== expectedAction) {
  throw new Error('Unexpected Bastion action in tool result');
}
NODE

log "Checking Bastion audit trail"
curl -fsS \
  "$BASTION_SERVER_URL/v1/audit?agentId=$AGENT_ID&action=$ACTION&limit=5" \
  -H "Authorization: Bearer $PROJECT_API_KEY" >"$audit_response_file"

audit_response=$(cat "$audit_response_file")
assert_contains "$audit_response" "$ACTION"
assert_contains "$audit_response" "$CREDENTIAL_ID"

log "Verifying direct web_fetch bypass is blocked"
render_fixture "$FIXTURE_DIR/tool-invoke.bypass.json" "$tmp_dir/tool-invoke.bypass.json"
bypass_status=$(
  curl -sS -o "$bypass_response_file" -w '%{http_code}' \
    -X POST "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/tools/invoke" \
    -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data @"$tmp_dir/tool-invoke.bypass.json"
)

if [[ "$bypass_status" == "200" ]]; then
  fail 'Expected direct protected web_fetch call to be blocked'
fi

bypass_response=$(cat "$bypass_response_file")
assert_contains "$bypass_response" 'must use bastion_fetch'

log "OpenClaw plugin E2E passed for $OPENCLAW_VERSION"
