"""扫描全部会话记录，产出「每个 session 有几张图」的映射。

与 scripts/backfill-session-images.ts 配套：本脚本产出映射，那个脚本据此给存量
记忆打标。ingest 侧的新记忆由 src/ingest.ts 的 countImageSignals 自动带标，
不需要跑这里——只有回填存量、或想重新核对全库图片分布时才用。

口径与 ingest.ts 严格对齐（改一边必须改另一边）：
  - 用户贴图：各端按自己的格式精确认（cc=image / codex=input_image / kimi=image_url）
  - AI 产图：**补集**——整条记录的图片信号减去用户贴的，不枚举来源。
    枚举过一版，漏了 5126 张图和 376 个 session（最大一类是 codex 的生图，
    它既不在 payload.content 也不在 payload.output）。
  - sessionId 取法也各端不同：cc 读行内、codex 读 session_meta、kimi 从路径倒数第 4 段

输出 /tmp/image-sessions-v4.json: { "<scope 前缀>:<sid 前8位>": {"user": N, "tool": M} }
key 直接就是库里的 scope，回填时做字符串相等匹配。

用法（数据在哪台机就在哪台跑）:
    python3 scripts/scan-image-sessions.py
    bun scripts/backfill-session-images.ts --dry-run
    bun scripts/backfill-session-images.ts

已知不覆盖：minis 源。它的 jsonl 落在 ~/Desktop/minis-outbox/ingest，
被 macOS TCC 挡住无法列举，也不在 ~/conversation-truth 里。影响面实测 22 条
记忆（全库 0.026%）。
"""
import json, os, time, collections

ROOT = os.path.expanduser("~/conversation-truth")
OUT = "/tmp/image-sessions-v4.json"

def count_image_signals(node, depth=0):
    """与 ingest.ts countImageSignals 同口径：命中即计一次并停止下钻。"""
    if depth > 10 or node is None:
        return 0
    if isinstance(node, list):
        return sum(count_image_signals(x, depth + 1) for x in node)
    if not isinstance(node, dict):
        return 0
    t = node.get("type")
    mt = node.get("media_type") or node.get("mimeType")
    if ((isinstance(t, str) and "image" in t)
            or isinstance(node.get("image_url"), str)
            or isinstance(node.get("imageUrl"), dict)
            or (isinstance(mt, str) and mt.startswith("image/"))):
        return 1
    return sum(count_image_signals(v, depth + 1)
               for v in node.values() if isinstance(v, (dict, list)))

def user_images_cc(rec):
    msg = rec.get("message") or {}
    if msg.get("role") != "user":
        return 0
    c = msg.get("content")
    if not isinstance(c, list):
        return 0
    return sum(1 for b in c if isinstance(b, dict) and b.get("type") == "image")

def user_images_codex(rec):
    p = rec.get("payload")
    if not isinstance(p, dict) or p.get("role") != "user":
        return 0
    c = p.get("content")
    if not isinstance(c, list):
        return 0
    return sum(1 for b in c if isinstance(b, dict) and b.get("type") == "input_image")

def user_images_kimi(rec):
    t = rec.get("type")
    if t == "turn.prompt":
        if (rec.get("origin") or {}).get("kind") != "user":
            return 0
        inp = rec.get("input")
        return sum(1 for b in inp if isinstance(b, dict) and b.get("type") == "image_url") \
            if isinstance(inp, list) else 0
    if t == "context.append_message":
        m = rec.get("message") or {}
        if m.get("role") != "user" or (m.get("origin") or {}).get("kind") != "user":
            return 0
        c = m.get("content")
        return sum(1 for b in c if isinstance(b, dict) and b.get("type") == "image_url") \
            if isinstance(c, list) else 0
    return 0

def sid_cc(rec, path, cur):
    return cur or (rec.get("sessionId") if isinstance(rec.get("sessionId"), str) else None)

def sid_codex(rec, path, cur):
    if cur: return cur
    if rec.get("type") == "session_meta":
        return (rec.get("payload") or {}).get("id")
    return None

def sid_kimi(rec, path, cur):
    parts = path.split("/")
    raw = parts[-4] if len(parts) >= 4 else os.path.basename(path)[:-6]
    return raw[len("session_"):] if raw.startswith("session_") else raw

ENDS = {
    "claude": ("cc", user_images_cc, sid_cc),
    "codex": ("codex", user_images_codex, sid_codex),
    "kimi": ("kimi", user_images_kimi, sid_kimi),
}

result = collections.defaultdict(lambda: {"user": 0, "tool": 0})
per_end = collections.defaultdict(lambda: [0, 0, 0, 0])  # 有用户图会话/总会话/用户图/AI图
t0, scanned = time.time(), 0

for end, (prefix, fn_user, fn_sid) in ENDS.items():
    d = os.path.join(ROOT, end)
    if not os.path.isdir(d):
        continue
    for dirpath, _dn, fns in os.walk(d):
        for fn in fns:
            if not fn.endswith(".jsonl"):
                continue
            path = os.path.join(dirpath, fn)
            per_end[end][1] += 1
            scanned += 1
            if scanned % 2000 == 0:
                print(f"  ...{scanned} 文件 {time.time()-t0:.0f}s", flush=True)
            sid, u, tl = None, 0, 0
            try:
                with open(path, errors="ignore") as fp:
                    for line in fp:
                        if "image" not in line:
                            # 任何图片形态都会在行里留下 image 字样
                            # （type/image_url/imageUrl/media_type 全含），跳过是安全的
                            if sid is None and '"session_meta"' in line:
                                try: sid = fn_sid(json.loads(line), path, sid)
                                except Exception: pass
                            elif sid is None and '"sessionId"' in line:
                                try: sid = fn_sid(json.loads(line), path, sid)
                                except Exception: pass
                            continue
                        try: rec = json.loads(line)
                        except Exception: continue
                        sid = fn_sid(rec, path, sid)
                        total = count_image_signals(rec)
                        own = fn_user(rec)
                        u += own
                        tl += max(0, total - own)
            except Exception:
                continue
            if end == "kimi":
                sid = fn_sid(None, path, None)
            if not sid or (u == 0 and tl == 0):
                continue
            key = f"{prefix}:{sid[:8]}"
            result[key]["user"] += u
            result[key]["tool"] += tl
            if u: per_end[end][0] += 1
            per_end[end][2] += u
            per_end[end][3] += tl

with open(OUT, "w") as fp:
    json.dump(dict(result), fp, ensure_ascii=False, indent=0, sort_keys=True)

u_sess = sum(1 for v in result.values() if v["user"])
t_sess = sum(1 for v in result.values() if v["tool"])
print(f"\n扫描完成 {time.time()-t0:.0f}s，共 {scanned} 个 jsonl")
print(f"带图 session {len(result)} 个：有用户贴图 {u_sess}，有 AI 产图 {t_sess}")
print(f"用户贴图 {sum(v['user'] for v in result.values())} 张，"
      f"AI 产图 {sum(v['tool'] for v in result.values())} 张")
print("\n按端:")
for end, (w, tot, ui, ti) in sorted(per_end.items()):
    print(f"  {end:8} 有用户贴图会话 {w:5}/{tot:6}   用户贴图 {ui:5}  AI 产图 {ti:6}")
print(f"\n已写出 {OUT}")
