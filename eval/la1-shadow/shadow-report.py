#!/usr/bin/env python3
"""LA-1 影子期数据分析：对比 off / min2 / min3 / min4 四种配置。

判据（照 open-loops 第 21 条对检索改动的要求）：
  - 目标能召回：过滤后每个 query 仍有结果（回退机制是否兜住）
  - 对照行不掉：durable 条目不能因为过滤反而丢失
  - 逐条说明掉出的性质：掉的是碎片还是结论
"""
import json, glob, os, re, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Desktop/la1-shadow")
CONFIGS = ["off", "min2", "min3", "min4"]
TRANSCRIPT_SCOPE = re.compile(r'^(cc|codex|kimi|gemini|antigravity):')
TRANSCRIPT_SRC = {"cc", "codex", "kimi", "gemini", "antigravity"}


def rows_of(path):
    try:
        j = json.load(open(path, encoding="utf-8"))
    except Exception:
        return None, []
    out = []
    for r in j.get("results", []):
        try:
            m = json.loads(r.get("metadata") or "{}")
        except Exception:
            m = {}
        scope = r.get("scope") or ""
        ev = bool(TRANSCRIPT_SCOPE.match(scope)) or m.get("source") in TRANSCRIPT_SRC
        out.append({"ev": ev, "scope": scope,
                    "text": re.sub(r"\s+", " ", r.get("text") or "")[:46]})
    return j.get("query", ""), out


def collect(cfg):
    d = os.path.join(OUT, cfg)
    res = {}
    for f in glob.glob(d + "/q*.json"):
        n = int(re.search(r"q(\d+)\.json", f).group(1))
        res[n] = rows_of(f)
    return res


def main():
    data = {c: collect(c) for c in CONFIGS}
    qs = sorted(data["off"].keys()) if data["off"] else []
    if not qs:
        print(f"没有数据（{OUT}/off 为空）——shadow 可能还在跑")
        return

    print(f"{'query':<26} " + " ".join(f"{c:>13}" for c in CONFIGS))
    print("-" * 84)
    tot = {c: [0, 0, 0] for c in CONFIGS}   # [evidence, total, 回退次数]

    for n in qs:
        q = (data["off"].get(n) or ("", []))[0][:24]
        cells = []
        for c in CONFIGS:
            _, rows = data[c].get(n, ("", []))
            if not rows:
                cells.append(f"{'--':>13}"); continue
            ev = sum(1 for r in rows if r["ev"])
            tot[c][0] += ev; tot[c][1] += len(rows)
            # 与 off 相比条数没减少 且 仍有 evidence → 判定为触发了回退
            off_rows = (data["off"].get(n) or ("", []))[1]
            if c != "off" and ev > 0 and len(rows) >= len(off_rows):
                tot[c][2] += 1
            cells.append(f"{ev:>2}/{len(rows):<2}碎片{'':>5}")
        print(f"{q:<26} " + " ".join(cells))

    print("-" * 84)
    print(f"{'合计 evidence 占比':<26} " +
          " ".join(f"{(t[0]/t[1]*100 if t[1] else 0):>11.1f}%{'':>1}" for t in tot.values()))
    print(f"{'触发回退的 query 数':<26} " +
          " ".join(f"{t[2]:>12}{'':>1}" for t in tot.values()))

    # 逐条说明：min3 相对 off 掉了什么
    print("\n=== min3 相对 off 掉出的条目（逐条判性质）===")
    for n in qs:
        _, a = data["off"].get(n, ("", []))
        q, b = data["min3"].get(n, ("", []))
        if not a or not b:
            continue
        gone = [r for r in a if r["text"] not in {x["text"] for x in b}]
        if not gone:
            continue
        print(f"\n[{q[:30]}] 掉出 {len(gone)} 条")
        for r in gone:
            print(f"   {'碎片' if r['ev'] else '★结论(警告)'} {r['scope'][:16]:<16} {r['text']}")


if __name__ == "__main__":
    main()
