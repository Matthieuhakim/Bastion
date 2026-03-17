#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/ci-common.sh"

export OPENCLAW_VERSION=${OPENCLAW_VERSION:-2026.3.13}
export OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-bastion-ci-token}
export BASTION_SERVER_URL=${BASTION_SERVER_URL:-http://127.0.0.1:3000}
export BASTION_AGENT_SECRET=${BASTION_AGENT_SECRET:-bst_test_secret}
export URL_PATTERN=${URL_PATTERN:-https://postman-echo.com/**}
export ACTION=${ACTION:-postman.echo}
export CREDENTIAL_ID=${CREDENTIAL_ID:-cred_ci_test}

INPUT_PLUGIN_TARBALL=${PLUGIN_TARBALL:-}
PLUGIN_TARBALL=$(ensure_plugin_tarball "${PLUGIN_TARBALL:-}")
GENERATED_TARBALL=0
if [[ -z "$INPUT_PLUGIN_TARBALL" ]]; then
  GENERATED_TARBALL=1
fi
trap 'cleanup_generated_tarball "$PLUGIN_TARBALL" "$GENERATED_TARBALL"' EXIT

setup_openclaw_env

log "Installing plugin before config validation checks"
run_openclaw plugins install "$PLUGIN_TARBALL" >/dev/null

log "Valid config should load cleanly"
merge_fixture_into_config "$FIXTURE_DIR/openclaw.valid.json"

valid_doctor_output=$(run_openclaw plugins doctor 2>&1)
printf '%s\n' "$valid_doctor_output"
assert_not_contains "$valid_doctor_output" 'invalid config'
assert_not_contains "$valid_doctor_output" 'plugin not found'
assert_not_contains "$valid_doctor_output" 'plugin id mismatch'

valid_list_output=$(run_openclaw plugins list 2>&1)
printf '%s\n' "$valid_list_output"
assert_not_contains "$valid_list_output" 'invalid config'
assert_not_contains "$valid_list_output" 'plugin not found'
assert_contains "$valid_list_output" 'bastion'

log "Partial config should fail with missing required field errors"
merge_fixture_into_config "$FIXTURE_DIR/openclaw.invalid.missing-required.json"
set +e
missing_required_output=$(run_openclaw plugins list 2>&1)
missing_required_exit=$?
set -e
printf '%s\n' "$missing_required_output"
if [[ "$missing_required_output" != *'config.agentSecret'* && "$missing_required_output" != *'config.rules'* ]]; then
  fail 'Expected partial config failure to mention a missing required Bastion plugin field'
fi
if [[ "$missing_required_exit" -eq 0 ]]; then
  assert_contains "$missing_required_output" 'error'
fi

log "Stale config entry should fail with plugin not found"
merge_fixture_into_config "$FIXTURE_DIR/openclaw.invalid.stale-entry.json"
node - "$OPENCLAW_CONFIG_PATH" <<'NODE'
const fs = require('node:fs');

const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (config.plugins) {
  delete config.plugins.installs;
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
NODE
set +e
stale_entry_output=$(run_openclaw plugins list 2>&1)
stale_entry_exit=$?
set -e
printf '%s\n' "$stale_entry_output"
assert_contains "$stale_entry_output" 'plugin not found'
assert_contains "$stale_entry_output" 'bastion-fetch'
if [[ "$stale_entry_exit" -eq 0 ]]; then
  assert_contains "$stale_entry_output" 'Config invalid'
fi

log "OpenClaw config validation checks passed for $OPENCLAW_VERSION"
