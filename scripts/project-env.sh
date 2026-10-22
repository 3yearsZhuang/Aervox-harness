#!/usr/bin/env bash
# Shared by mise and the launcher: caller exports > .env > project defaults.
aervox_env_file="$(dirname "${BASH_SOURCE[0]}")/../.env"
if [ -f "$aervox_env_file" ]; then
  aervox_inherited_exports="$(export -p)"
  set -a
  source "$aervox_env_file"
  set +a
  eval "$aervox_inherited_exports"
  unset aervox_inherited_exports
fi
unset aervox_env_file
export AERVOX_PROJECT="${AERVOX_PROJECT-aervox-harness}"
export AERVOX_NODE_MIN="${AERVOX_NODE_MIN-22.19}"
export AERVOX_LOOP_PROVIDER="${AERVOX_LOOP_PROVIDER-llm}"
