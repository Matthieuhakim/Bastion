#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

source "$SCRIPT_DIR/ci-common.sh"

INPUT_PLUGIN_TARBALL=${PLUGIN_TARBALL:-}
TARBALL_PATH=$(ensure_plugin_tarball "${PLUGIN_TARBALL:-}")
[[ -f "$TARBALL_PATH" ]] || fail "Tarball not found: $TARBALL_PATH"
GENERATED_TARBALL=0
if [[ -z "$INPUT_PLUGIN_TARBALL" ]]; then
  GENERATED_TARBALL=1
fi
trap 'cleanup_generated_tarball "$TARBALL_PATH" "$GENERATED_TARBALL"' EXIT

log "Inspecting tarball contents"
contents=$(tar -tzf "$TARBALL_PATH")

assert_contains "$contents" 'package/openclaw.plugin.json'
assert_contains "$contents" 'package/package.json'
assert_contains "$contents" 'package/dist/index.js'
assert_contains "$contents" 'package/dist/plugin.js'
assert_not_contains "$contents" 'package/src/'
assert_not_contains "$contents" '__test__'
assert_not_contains "$contents" '.test.'

manifest_json=$(tar -xOf "$TARBALL_PATH" package/openclaw.plugin.json)
manifest_id=$(node -e 'const manifest=JSON.parse(process.argv[1]); console.log(manifest.id);' "$manifest_json")
if [[ "$manifest_id" != "bastion" ]]; then
  fail "Expected manifest id bastion, got $manifest_id"
fi

secret_ref_bundle=$(tar -xOf "$TARBALL_PATH" package/dist/secretRef.js)
assert_not_contains "$secret_ref_bundle" 'child_process'
assert_not_contains "$secret_ref_bundle" 'execSync'
assert_not_contains "$secret_ref_bundle" '$exec'

log "Tarball verification passed: $TARBALL_PATH"
