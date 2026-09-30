#!/usr/bin/env bash
#
# 双击在 macOS Terminal 中直接启动思隅 CLI
#
cd "$(dirname "$0")" || exit 1
exec ./run-cli "$@"
