#!/bin/sh
set -eu
# Same service and config as run.sh; one user-only generation.
if [ "$#" -ne 3 ]; then echo 'Usage: run_baseline.sh CONFIG TASK OUT' >&2; exit 2; fi
exec mise exec -- node "$(dirname "$0")/cli.mjs" run "$1" "$2" B0 "$3"
