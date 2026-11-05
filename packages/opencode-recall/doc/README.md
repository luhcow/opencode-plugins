# `opencode-recall` AI 驱动工程复现总览 (AI-Driven Engineering Reproduction Guide)

本目录完整保存了 `opencode-recall`（OpenCode V2 历史会话语义检索 RAG 插件）从 **前期技术预研 → 原始需求分析与边界推导 → V1 首次编码实现 → 线上 10.5 GB 内存暴涨根因诊断 → Astra 双重代码与方案评审 → V2 多分片流式架构演进与线上验证** 的全部 AI 对话 Session 记录、设计方案文档（Plans）及宿主引用契约（References）。

这些是保留阶段、工具调用顺序、设计争论与验证结果的脱敏工程记录。会话和消息 ID 已一致化为虚构别名，业务样例、地址和私有模型标识已替换；别名不能用于查询真实会话。性能数值和技术代码用于说明当时的实验结果，不代表通用性能保证。

历史代码片段反映当时版本，当前安装配置以各插件 README 和源码为准。文档不包含在 npm 发布包内。可用 `npm run docs:redact` 重复执行已知模式脱敏，再用 `npm run check:public` 扫描工作树。原始未脱敏材料如需另存，请放在已忽略的 `private/` 目录中。

---

## 一、全链路工程演进拓扑与文档索引

### 1. 设计方案文档 (`./plans/`)

| 阶段 | 文档路径 | 核心内容 |
| :--- | :--- | :--- |
| **V1 初始架构方案** | [`./plans/01-v1-initial-architecture-plan.md`](./plans/01-v1-initial-architecture-plan.md) | 只读 `ATTACH` 原生 `opencode.db`、`session_turns` + `embeddings(content_hash)` 双表解耦、多次穿插 Revert 与多分支 Fork 对账流水线、`ScopedEmbedder.withScope` 显存即用即放、`session_search` 多会话聚合输出格式。 |
| **V2 内存优化与分片检索方案** | [`./plans/02-v2-memory-and-chunking-plan.md`](./plans/02-v2-memory-and-chunking-plan.md) | 10.5 GB 内存根因拆解、Astra 双重 Review 结论评定、`contextSize: 2048` + 超长对话滑动窗口多分片 `(content_hash, chunk_index)`、`LIMIT 1` 单条流式读取与原子落库、包含运行中会话已完成历史、结果文本 User 50 / Assistant 100 字符截断、以及 `globalThis[Symbol.for(...)]` 进程级共享协调器。 |

---

### 2. 全量 AI 对话 Session 归档 (`./sessions/`)

| 序号 | 阶段与角色 | Session ID | 归档文件 | 关键工程产出 |
| :--- | :--- | :--- | :--- | :--- |
| **01** | **前期技术预研** | `ses_example_e0712d9d9097` | [`./sessions/01-sqlite-cross-session-research.md`](./sessions/01-sqlite-cross-session-research.md) | 确认 OpenCode 插件可在多对话/多工作区间通过 WAL + `busy_timeout` + 进程内单例共享同一个 SQLite 存储。 |
| **02** | **原始需求分析与 V1 架构设计（主会话）** | `ses_example_d76941d83c43` | [`./sessions/02-requirements-and-v1-design.md`](./sessions/02-requirements-and-v1-design.md) | 15 轮深度架构推演：对比 FTS5 与语义向量检索 → 选定 `Qwen3-Embedding-0.6B-GGUF:Q8_0` + `node-llama-cpp` Metal GPU → 砍掉冗余 `session_read` 仅保留 `session_search` → 推导 `7->4->11->9->12` 多次穿插 Revert 与连环 Fork 的全部边界条件 → 产出 V1 计划并调度子代理开发。 |
| **03** | **V1 首次编码实现（Subagent 会话）** | `ses_example_7575c89cdeb0` | [`./sessions/03-v1-implementation-subagent.md`](./sessions/03-v1-implementation-subagent.md) | 严格按 V1 方案实现 `src/db.ts`、`src/embedder.ts`、`src/indexer.ts`、`src/index.ts` 及 4 项核心测试套件（100% 通过）。 |
| **04** | **10.5 GB 内存 Bug 根因诊断、V2 迭代与实测（主会话）** | `ses_example_4cca5a4a3fe3` | [`./sessions/04-10gb-memory-bug-analysis-and-v2-iteration.md`](./sessions/04-10gb-memory-bug-analysis-and-v2-iteration.md) | 通过 `vmmap` / `lsof` / `sample` 定位 10.5 GB 内存与 Metal 死锁三大根因 → 调度两个 Astra 子代理并行 Review → 合入用户 4 项新要求制定 V2 计划 → 调度子代理实现 → 线上挂载实测（峰值内存从 10.9 GB 降至 952 MB，697 条历史切分为 897 个分片全部入库）→ 解析向量比对机制。 |
| **05** | **Astra 修改方案评审（Subagent 会话）** | `ses_example_fcdfcd7c5c4e` | [`./sessions/05-astra-plan-review-subagent.md`](./sessions/05-astra-plan-review-subagent.md) | 审查初步修复计划，指出 `source.bun.ts` 模块重载导致顶层 Map 单例失效、`getEmbeddingFor()` 在 `>= contextSize` 时直接抛错需配合 Tokenizer 处理、以及 `dispose()` 竞态。 |
| **06** | **Astra 全量代码审查（Subagent 会话）** | `ses_example_272b145f8511` | [`./sessions/06-astra-code-review-subagent.md`](./sessions/06-astra-code-review-subagent.md) | 审查 V1 代码，提出消息原地更新检测、单条毒丸容错隔离、`PRAGMA busy_timeout`、V2 事件名适配等 16 项改进建议。 |
| **07** | **V2 多分片与流式检索编码实现（Subagent 会话）** | `ses_example_8fef8a9ef89d` | [`./sessions/07-v2-chunking-and-streaming-implementation.md`](./sessions/07-v2-chunking-and-streaming-implementation.md) | 在 `opencode-plugins` 工作区完成 V2 全部代码实现与 8 项单元测试验证。 |

---

### 3. 宿主契约与引用文件归档 (`./references/`)

| 文档路径 | 核心内容 |
| :--- | :--- |
| [`./references/host-contracts-and-referenced-files.md`](./references/host-contracts-and-referenced-files.md) | 归档了对话中查阅的 OpenCode V2 `session_v2` / `session_message` 表结构、Revert 与 Fork 底层实现契约、`source.bun.ts` 插件加载器缓存失效机制、V2 事件流契约，以及 `node-llama-cpp` 的 `contextSize` 分配与 Token 长度校验源码。 |

---

## 二、如何从零复现本插件（Step-by-Step AI 驱动复现指南）

若要在新环境中通过 AI Coding Agent 完整复现 `opencode-recall` 的工程实现，可按以下 3 个步骤投喂上下文：

1. **Step 1 — 注入宿主契约上下文**：
   让 Agent 阅读 [`./references/host-contracts-and-referenced-files.md`](./references/host-contracts-and-referenced-files.md)，理解 OpenCode V2 的 `opencode.db` 表结构、Revert/Fork 语义、`@opencode/plugin` 接口以及 `node-llama-cpp` 的 `contextSize` 行为。
2. **Step 2 — 投喂最终架构方案**：
   让 Agent 阅读 [`./plans/01-v1-initial-architecture-plan.md`](./plans/01-v1-initial-architecture-plan.md) 与 [`./plans/02-v2-memory-and-chunking-plan.md`](./plans/02-v2-memory-and-chunking-plan.md)（重点关注其中经过真实线上 10.5 GB 故障与 Astra 双重评审沉淀出的 5 项核心机制：双表解耦、`globalThis[Symbol.for(...)]` 进程级单例、`contextSize: 2048` + 滑动窗口多分片 `MAX(score)` 聚合、`LIMIT 1` 单条流式落库、User 50 / Assistant 100 字符截断）。
3. **Step 3 — 执行实现与回归验证**：
   参考 [`./sessions/07-v2-chunking-and-streaming-implementation.md`](./sessions/07-v2-chunking-and-streaming-implementation.md) 中的实现步骤编写 `src/db.ts`、`src/embedder.ts`、`src/indexer.ts`、`src/index.ts` 与 `test/recall.test.ts`，并运行：
   ```bash
   npm run test:recall
   ```
   确认全部 8 个测试套件通过。
