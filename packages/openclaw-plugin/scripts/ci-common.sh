#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_DIR=$(cd "$PACKAGE_DIR/../.." && pwd)
FIXTURE_DIR="$PACKAGE_DIR/test-fixtures"

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_env() {
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      fail "Missing required environment variable: $name"
    fi
  done
}

setup_openclaw_env() {
  export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$(mktemp -d)}"
  export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"
  mkdir -p "$OPENCLAW_STATE_DIR"
}

ensure_plugin_tarball() {
  local candidate=${1:-}
  if [[ -n "$candidate" && -f "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  printf '==> %s\n' "Packing plugin tarball" >&2
  local pack_json
  local filename
  pushd "$REPO_DIR" >/dev/null
  # Fallback path for local runs that don't provide a prebuilt tarball.
  # Build sdk-node first so @bastion-ai/bastion can resolve @bastion-ai/sdk types.
  if ! npm run build --workspace=packages/sdk-node >/dev/null; then
    popd >/dev/null
    fail 'Failed to build packages/sdk-node before packing plugin tarball'
  fi
  if ! pack_json=$(npm pack --workspace=packages/openclaw-plugin --json); then
    popd >/dev/null
    fail 'Failed to pack plugin tarball'
  fi
  popd >/dev/null

  if ! filename=$(
    node -e 'const parsed=JSON.parse(process.argv[1]); const name=parsed?.[0]?.filename; if(!name){ process.exit(1); } process.stdout.write(name);' "$pack_json"
  ); then
    fail "Failed to parse tarball filename from npm pack output: $pack_json"
  fi

  local tarball_path="$REPO_DIR/$filename"
  if [[ ! -f "$tarball_path" ]]; then
    fail "Expected packed tarball to exist at: $tarball_path"
  fi

  printf '%s\n' "$tarball_path"
}

cleanup_generated_tarball() {
  local tarball_path=${1:-}
  local should_cleanup=${2:-0}
  if [[ "$should_cleanup" -eq 1 && -n "$tarball_path" && -f "$tarball_path" ]]; then
    rm -f "$tarball_path"
  fi
}

run_openclaw() {
  require_env OPENCLAW_VERSION OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH
  OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
    npx -y "openclaw@${OPENCLAW_VERSION}" "$@"
}

render_fixture() {
  local template_path=$1
  local output_path=$2

  node - "$template_path" "$output_path" <<'NODE'
const fs = require('node:fs');

const templatePath = process.argv[2];
const outputPath = process.argv[3];

let contents = fs.readFileSync(templatePath, 'utf8');

for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  const placeholder = `__${key}__`;
  contents = contents.split(placeholder).join(value);
}

fs.writeFileSync(outputPath, contents);
NODE
}

merge_fixture_into_config() {
  local template_path=$1
  local rendered_path
  rendered_path=$(mktemp)
  render_fixture "$template_path" "$rendered_path"

  node - "$OPENCLAW_CONFIG_PATH" "$rendered_path" <<'NODE'
const fs = require('node:fs');

const configPath = process.argv[2];
const renderedPath = process.argv[3];

const current = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : {};
const next = JSON.parse(fs.readFileSync(renderedPath, 'utf8'));

if (current.plugins?.installs !== undefined) {
  next.plugins = next.plugins ?? {};
  next.plugins.installs = current.plugins.installs;
}

if (current.meta !== undefined) {
  next.meta = current.meta;
}

fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
NODE

  rm -f "$rendered_path"
}

assert_contains() {
  local haystack=$1
  local needle=$2
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "Expected output to contain: $needle"
  fi
}

assert_not_contains() {
  local haystack=$1
  local needle=$2
  if [[ "$haystack" == *"$needle"* ]]; then
    fail "Did not expect output to contain: $needle"
  fi
}

wait_for_url() {
  local url=$1
  local attempts=${2:-60}
  local i
  for ((i = 0; i < attempts; i += 1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Timed out waiting for $url"
}
