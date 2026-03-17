#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/ci-common.sh"

export OPENCLAW_VERSION=${OPENCLAW_VERSION:-2026.3.13}
INPUT_PLUGIN_TARBALL=${PLUGIN_TARBALL:-}
PLUGIN_TARBALL=$(ensure_plugin_tarball "${PLUGIN_TARBALL:-}")
GENERATED_TARBALL=0
if [[ -z "$INPUT_PLUGIN_TARBALL" ]]; then
  GENERATED_TARBALL=1
fi
trap 'cleanup_generated_tarball "$PLUGIN_TARBALL" "$GENERATED_TARBALL"' EXIT

setup_openclaw_env

log "Installing plugin tarball into isolated OpenClaw state"
install_output=$(run_openclaw plugins install "$PLUGIN_TARBALL" 2>&1)
printf '%s\n' "$install_output"

assert_not_contains "$install_output" 'plugin id mismatch'
assert_not_contains "$install_output" 'invalid config'
assert_not_contains "$install_output" 'dangerous code patterns'
assert_contains "$install_output" 'Installed plugin: bastion'

[[ -f "$OPENCLAW_CONFIG_PATH" ]] || fail "Expected config file at $OPENCLAW_CONFIG_PATH"

node - "$OPENCLAW_CONFIG_PATH" <<'NODE'
const fs = require('node:fs');

const configPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (config.plugins?.entries?.['bastion']?.enabled !== true) {
  throw new Error('plugins.entries.bastion.enabled should be true after install');
}

if (!config.plugins?.installs?.['bastion']) {
  throw new Error('plugins.installs.bastion should exist after install');
}
NODE

list_output=$(run_openclaw plugins list 2>&1)
printf '%s\n' "$list_output"

assert_not_contains "$list_output" 'invalid config'
assert_not_contains "$list_output" 'plugin not found'
assert_contains "$list_output" 'bastion'

log "OpenClaw install smoke check passed for $OPENCLAW_VERSION"
