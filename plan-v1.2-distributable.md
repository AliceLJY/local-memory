# RecallNest v1.2: 首个可传播版本 Plan

> 目标：别人 15 分钟能跑起来，30 分钟能感知价值
> 负责人：CC (实现) + 用户 (审批)
> 预计：3-4 天

---

## 阻塞项（必须修，按优先级排）

### B1: `recallnest doctor` 命令（新增） ✅ DONE
**问题**：用户装完后没有一键验证手段，每个环节都可能静默失败
**方案**：新增 `lm doctor` 子命令，检查清单：
- [x] Bun 运行时可用？（检测版本）
- [x] Jina API key 已配置？（读 .env）
- [x] Jina API key 有效？（发一个测试 embedding 请求）
- [x] CC transcript 路径可访问？（auto-detect 或 config）
- [x] LanceDB 数据目录可写？
- [x] 已有索引？多少条？
- 输出：绿色 PASS / 红色 FAIL + 修复建议

### B2: README 安装体验重写 ✅ DONE
**问题**：Bun 未提及、Jina key 获取无引导、步骤跳跃
**方案**：
- [x] Prerequisites 段：明确列出 Bun ≥1.0 + Node ≥20（Bun 优先，Node 作为 fallback 说明）
- [x] 快速开始改为 5 步 copy-paste：clone → install → 配 key → doctor → search
- [x] 每步附带预期输出（用户知道"成功了"长什么样）
- [x] 添加 "Troubleshooting" 段：Bun not found / Jina 401 / 路径不存在

### B3: Jina API key 前置验证 ✅ DONE
**问题**：config 加载成功，但第一次 ingest 才报 embedding 失败，错误信息是 OpenAI SDK 的原始 401
**方案**：
- [x] `ingest` 命令启动时，先调 embedder 发一个测试请求（embed "test"）
- [x] 失败则立即报错：`Jina API key invalid or missing. Get one at https://jina.ai/embeddings/`
- [x] `doctor` 命令复用同一验证逻辑

### B4: Gemini 支持诚实化 ✅ DONE
**问题**：README 说支持 Gemini CLI，config 里有 gemini 源，但实际 Gemini 会话是加密 protobuf，解析不了
**方案**：
- [x] README 中 Gemini 行标注为 `Coming soon`（不是 ✅）
- [x] config.json.example 中移除 gemini source（新用户不会误配）
- [x] ingest 遇到 gemini source 时打印明确 warning：`Gemini CLI sessions are encrypted protobuf; skipping`
- [x] doctor 显示 Gemini 状态为 warn（已有配置的用户看到明确提示）
- 不删代码，保留未来扩展能力

### B5: 配置路径健壮化 ✅ DONE
**问题**：`./data/lancedb` 是相对路径，换目录就炸；auto-detect 失败后建议不够具体
**方案**：
- [x] config.json.example 默认路径改为 `~/.recallnest/data/lancedb`（绝对，用户无感）
- [x] 首次运行自动创建目录（validateStoragePath 已有 mkdirSync recursive）
- [x] auto-detect 失败时，给出完整示例（含用户名的真实路径）
- [x] config.json 加入 .gitignore，用户配置不被 git 覆盖
- [x] findConfigPath 失败时提示 `cp config.json.example config.json`

---

## 加分项（做了更好，不阻塞发布）

### P1: Demo 查询内置 ✅ DONE
- [x] `lm demo` 命令：用 3 个内置 query 跑搜索，展示结果格式
- [x] 显示索引统计 + 每条结果的分数/来源/预览

### P2: 一键安装脚本
- [ ] `curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash`
- [ ] 检测 Bun → clone → npm install → 提示配 key → 跑 doctor
- [ ] 可以 Q2 再做，现在 README 手动步骤够用

### P3: CI 基础 ✅ DONE
- [x] GitHub Actions：push/PR 时跑 `doctor --ci` + TypeScript check
- [x] `lm doctor --ci` 模式跳过 API key 在线验证

### P4: CHANGELOG.md ✅ DONE
- [x] v1.0.0 到 v1.2.0 的变更记录
- [x] 后续每个 release 维护

---

## 不做的事（明确排除）

- ❌ 不做 Docker 化（用户群是 CLI/MCP 用户，不是 Docker 用户）
- ❌ 不做 NPM 发布（先 git clone 模式验证需求）
- ❌ 不做 UI 重写（现有 UI 够用，不是本次重点）
- ❌ 不做多用户支持（单 operator 场景）
- ❌ 不重写检索逻辑（已经够好，不是本次范围）

---

## 执行顺序

```
Day 1: B1 (doctor) + B3 (Jina 验证) — 核心安全网 ✅
Day 2: B5 (路径健壮化) + B4 (Gemini 诚实化) + B2 (README 重写) ✅
Day 3: P1 (demo 查询) + P3 (CI) + P4 (CHANGELOG) ✅
Day 4: 自测完整流程
```

---

## 验收标准

1. 全新 macOS 机器（有 Bun），从 clone 到第一条搜索结果 ≤ 15 分钟
2. `lm doctor` 全绿
3. Jina key 错误时，3 秒内给出明确修复建议
4. README 无需翻代码即可完成安装
5. `lm search "telegram bridge"` 返回有意义结果
