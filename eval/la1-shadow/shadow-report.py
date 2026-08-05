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
    # 空文件/坏 JSON（如网络抖动写出 0 字节）→ 返回 None 显式标缺，调用方负责展示
    try:
        j = json.load(open(path, encoding="utf-8"))
    except Exception:
        return None
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

    missing = 0
    for n in qs:
        q = next((e[0] for c in CONFIGS if (e := data[c].get(n)) is not None), f"q{n}")[:24]
        cells = []
        for c in CONFIGS:
            entry = data[c].get(n)
            if entry is None:
                missing += 1
                cells.append(f"{'MISSING':>13}"); continue
            _, rows = entry
            if not rows:
                cells.append(f"{'--':>13}"); continue
            ev = sum(1 for r in rows if r["ev"])
            tot[c][0] += ev; tot[c][1] += len(rows)
            # 与 off 相比条数没减少 且 仍有 evidence → 判定为触发了回退
            off_entry = data["off"].get(n)
            off_rows = off_entry[1] if off_entry else []
            if c != "off" and ev > 0 and len(rows) >= len(off_rows):
                tot[c][2] += 1
            cells.append(f"{ev:>2}/{len(rows):<2}碎片{'':>5}")
        print(f"{q:<26} " + " ".join(cells))
    if missing:
        print(f"⚠️ {missing} 个数据文件缺失或损坏（0 字节/坏 JSON），对应格显示 MISSING，未计入占比——先补跑再下结论")

    print("-" * 84)
    print(f"{'合计 evidence 占比':<26} " +
          " ".join(f"{(t[0]/t[1]*100 if t[1] else 0):>11.1f}%{'':>1}" for t in tot.values()))
    print(f"{'触发回退的 query 数':<26} " +
          " ".join(f"{t[2]:>12}{'':>1}" for t in tot.values()))

    # 逐条说明：min3 相对 off 掉了什么
    print("\n=== min3 相对 off 掉出的条目（逐条判性质）===")
    for n in qs:
        a_entry = data["off"].get(n)
        b_entry = data["min3"].get(n)
        if not a_entry or not b_entry:
            continue
        _, a = a_entry
        q, b = b_entry
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
