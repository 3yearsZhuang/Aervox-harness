#!/bin/sh
set -eu
# Internal development entry: CONFIG TASK OUT. Official ABI remains external.
if [ "$#" -ne 3 ]; then echo 'Usage: run.sh CONFIG TASK OUT' >&2; exit 2; fi
exec mise exec -- node "$(dirname "$0")/cli.mjs" run "$1" "$2" A2 "$3"
