#!/usr/bin/env python3
"""取证脚本：生成差距矩阵所需的全部定量事实。

所有数字必须由本脚本产出，不得手工填写。前一版因两条正则缺陷
（不含大写字母、关键字代替路由）导致 Aervox 路由数 112 vs 实际 174、
命名空间 21 vs 实际 28，故改为单一脚本 + 断言。

用法：
    python3 scripts/measure.py \
        --dsh-go /path/to/dsh-go \
        --aervox /path/to/Aervox-harness
"""
import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

# Aervox `/v1/` 路径字面量。必须含大写字母：`/v1/attachments/:attachmentId`
# 这类驼峰参数曾被 `[a-z0-9/:{}-]` 静默漏掉 62 条。
V1_PATH = re.compile(r"\"/v1/[A-Za-z0-9/:{}_.*-]+\"")
# 实际注册调用的形态（含泛型），用于和路径字面量互相校验。
REGISTERED = re.compile(r'app\.(?:get|post|put|delete|patch)(?:<[^>]*>)?\(\s*"(/v1/[^"]+)"')
RPC_CALL = re.compile(r"\.call(?:Result)?\('([a-zA-Z0-9./_-]+)'")


def count_lines(paths):
    total = 0
    for p in paths:
        total += sum(1 for _ in p.open("r", encoding="utf-8", errors="replace"))
    return total


def dsh_go_facts(root: Path):
    lib = root / "app" / "lib"
    client = root / "packages" / "dsh_client" / "lib"
    bridge = root / "runtime" / "bridge"

    eps = set()
    for f in client.rglob("*.dart"):
        eps.update(RPC_CALL.findall(f.read_text(encoding="utf-8", errors="replace")))

    return {
        "app_dart_files": len(list(lib.rglob("*.dart"))),
        "app_ui_dart_files": len(list((lib / "ui").rglob("*.dart"))),
        "app_dart_loc": count_lines(sorted(lib.rglob("*.dart"))),
        "chat_dart_files": len(list((lib / "ui" / "chat").rglob("*.dart"))),
        "client_dart_files": len(list(client.rglob("*.dart"))),
        "client_dart_loc": count_lines(sorted(client.rglob("*.dart"))),
        "bridge_loc": count_lines(
            sorted([p for p in bridge.rglob("*") if p.suffix in (".js", ".mjs")])
        ),
        "endpoints": sorted(eps),
        "endpoint_count": len(eps),
        "namespaces": sorted({e.split("/")[0] for e in eps}),
        "namespace_count": len({e.split("/")[0] for e in eps}),
    }


def aervox_facts(root: Path):
    src = root / "packages" / "host-runtime" / "src"
    paths, registered = set(), set()
    for f in src.rglob("*.ts"):
        text = f.read_text(encoding="utf-8", errors="replace")
        paths.update(m.group(0)[1:-1] for m in V1_PATH.finditer(text))
        registered.update(REGISTERED.findall(text))
    return {
        "v1_unique_paths": len(paths),
        "v1_registered_routes": len(registered),
        # 注册形态必须全部出现在路径字面量集合里，否则说明正则仍有盲区。
        "registered_missing_from_paths": sorted(registered - paths),
    }


def check(cond, message):
    if not cond:
        print(f"ASSERT FAILED: {message}", file=sys.stderr)
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsh-go", required=True)
    ap.add_argument("--aervox", required=True)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    d = dsh_go_facts(Path(args.dsh_go))
    a = aervox_facts(Path(args.aervox))

    # 断言：注册路由必须全部能被路径正则看到。这条断言正是上一版的缺口。
    check(
        not a["registered_missing_from_paths"],
        f"路径正则漏掉了已注册路由：{a['registered_missing_from_paths'][:5]}",
    )
    # 断言：端点调用必须都形如 ns/name。
    check(
        all("/" in e and len(e.split("/")) == 2 for e in d["endpoints"]),
        "端点名不是两段式，统计口径可能混入噪声",
    )

    result = {"dsh_go": d, "aervox": a}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    print("== dsh-Go ==")
    for k in (
        "app_dart_files", "app_ui_dart_files", "app_dart_loc", "chat_dart_files",
        "client_dart_files", "client_dart_loc", "bridge_loc",
        "endpoint_count", "namespace_count",
    ):
        print(f"  {k}: {d[k]}")
    print("== Aervox ==")
    for k in ("v1_unique_paths", "v1_registered_routes"):
        print(f"  {k}: {a[k]}")


if __name__ == "__main__":
    main()
