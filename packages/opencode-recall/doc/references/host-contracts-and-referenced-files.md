# 对话引用宿主文件与底层契约归档 (Referenced Host Files & Contracts)

本文档归档了在 `opencode-recall` 需求分析、架构设计、10.5 GB 内存暴涨排查及 Astra 代码审查过程中所引用的全部外部宿主文件（OpenCode V2 Core / Schema / Plugin Loader 与 `node-llama-cpp`）的关键源码与契约，确保无需依赖本地外部仓库即可 100% 复现全部工程决策。

---

## 1. OpenCode V2 原生 SQLite 存储契约 (`opencode.db`)

### 1.1 引用路径
- `<opencode-repo>/packages/core/src/session/sql.ts`
- `<opencode-repo>/packages/core/src/session/stored.ts`
- `<opencode-repo>/packages/core/src/session/message-updater.ts`
- `<opencode-repo>/packages/schema/src/session-revert.ts`
- `<opencode-repo>/packages/schema/src/session-message.ts`

### 1.2 核心表结构 (`session_v2` 与 `session_message`)

OpenCode V2 将所有会话与消息存储在 `~/.local/share/opencode/opencode.db`（WAL 模式）中：

```sql
CREATE TABLE session_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  parent_id TEXT,          -- 子代理会话 (subagent) 的父 session_id；顶层主会话为 NULL
  fork_session_id TEXT,    -- 若为分叉会话 (fork)，指向源 session_id
  fork_boundary TEXT,      -- JSON: {"type":"through","messageID":"msg_..."}
  slug TEXT NOT NULL,
  directory TEXT NOT NULL,
  title TEXT,
  version TEXT NOT NULL,
  revert TEXT,             -- JSON: {"messageID":"msg_..."}（回滚暂存态，提交后清空为 NULL）
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,      -- 'user' | 'assistant' | 'tool' | 'compaction' | 'system' | 'synthetic' | 'idle' ...
  seq INTEGER NOT NULL,    -- 会话内单调递增序号
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL       -- JSON 载荷
);
```

### 1.3 Revert（多次穿插回滚）在宿主中的两阶段存储行为
在对话 [`02-requirements-and-v1-design.md`](../sessions/02-requirements-and-v1-design.md) 的 Turn #6–#7 中，通过查阅 `packages/core/src/session/stored.ts` 确认了 OpenCode V2 处理回滚的精确机制：
1. **暂存回滚阶段（Staged Revert）**：
   - 用户触发回滚（到某条 `revertMessageID`）但尚未发送新消息时，`session_message` 中的旧消息尚未物理删除，但 `session_v2.revert` 字段被写入 `{"messageID": "msg_..."}`。
   - 此时该会话中所有 `seq >= (SELECT seq FROM session_message WHERE id = revert.messageID)` 的消息均已处于**逻辑失效状态**。
2. **提交回滚阶段（Committed Revert）**：
   - 当用户在回滚点之后继续发送新消息时，宿主执行：
     ```sql
     DELETE FROM session_message WHERE session_id = ? AND seq >= ?;
     UPDATE session_v2 SET revert = NULL WHERE id = ?;
     ```
   - 随后新消息从当前最大存活 `seq + 1`（或新分配的递增 `seq`）继续追加。
3. **对 `opencode-recall` 的设计约束**：
   - 不能仅靠记录上次同步的 `max_seq` 游标判断增量（因为 `7 -> 回滚到 4 -> 聊到 11 -> 回滚到 9 -> 聊到 12` 时，中间的 `4..7` 和 `9..11` 已被删除或替换）。
   - 必须通过 `session_turns` 集合对账：清理已不在 `valid_messages`（`m.seq < COALESCE(revert_seq, ∞)`）中的 `(user_message_id, assistant_message_id)`，并对比 `max_valid_seq` 与会话消息指纹（`MAX(time_updated)` + `SUM(LENGTH(data))` + `COUNT(id)`）感知任何回滚、新增或原地流式更新。

### 1.4 Fork（会话分叉）在宿主中的克隆行为
通过查阅 `packages/core/src/session/stored.ts` 确认：
- 当从源会话 `ses_src` 分叉出 `ses_fork` 时，宿主会将源会话分叉点之前的历史消息**深度克隆一份新的 `session_message` 行**（生成新的 `message.id`，但问答正文完全相同），并在 `session_v2` 中记录 `fork_session_id = 'ses_src'`。
- 因此：
  1. `embeddings` 表以 `content_hash = sha256(user_text + "\0" + assistant_text)` 作为去重键，Fork 会话克隆的历史轮次 100% 复用已有向量，**零重复 GPU 推理**；
  2. 源会话后续若在分叉点之前发生 Revert 或被整个删除，只要 Fork 会话仍在 `session_turns` 中引用该 `content_hash`，其向量就绝不会被孤儿清理误删；
  3. 搜索结果按 `content_hash` 占 Top-K 名额，并在单条命中结果下聚合列出源会话与所有 Fork 分支的 `sessionID` 及各自对应的 `turn #N (userMessageID, assistantMessageID)`。

---

## 2. OpenCode V2 插件加载器与事件契约 (`@opencode/plugin`)

### 2.1 引用路径
- `<opencode-repo>/packages/plugin/src/source.bun.ts`
- `<opencode-repo>/packages/core/src/plugin/host.ts`
- `<opencode-repo>/packages/schema/src/session-event.ts`
- `<opencode-repo>/packages/schema/src/session-status-event.ts`
- `node_modules/@opencode/plugin/dist/index.d.ts`

### 2.2 多工作区实例化与模块缓存失效机制 (`source.bun.ts`)
在对话 [`04-10gb-memory-bug-analysis-and-v2-iteration.md`](../sessions/04-10gb-memory-bug-analysis-and-v2-iteration.md) 与 [`05-astra-plan-review-subagent.md`](../sessions/05-astra-plan-review-subagent.md) 中定位到的关键宿主行为：
1. **按工作区目录调用 `setup(ctx)`**：
   - OpenCode Server（`opencode serve --service`）为每个打开的工作区目录分别维护插件实例，因此同一进程内 `plugin.setup(ctx)` 会被调用多次（例如同时打开 4 个工作区时被调用 4 次）。
2. **本地源码插件热重载时清除 Bun 模块缓存**：
   - `packages/plugin/src/source.bun.ts:15-23` 在加载本地文件插件时，会主动从 `Loader.registry` 中删除入口文件及本地相对依赖的模块缓存。
   - **设计结论**：插件内部的模块顶层变量（如 `const map = new Map()`）无法在热重载或跨加载器重评估时保证唯一性，必须使用挂载在 `globalThis[Symbol.for("opencode.recall.shared.v1")]` 上的进程级引用计数注册表共享 `{ db, embedder, indexer }`。

### 2.3 会话状态与执行事件契约 (`session-event.ts`)
OpenCode V2 事件流通过 `ctx.event.subscribe()` 推送以下与会话空闲/忙碌相关的事件：
- `session.status`：`data.status.type` 为 `"busy" | "retry" | "idle"`
- `session.execution.started` / `session.execution.succeeded` / `session.execution.failed` / `session.execution.interrupted`
- `session.idle`（兼容事件）

---

## 3. `node-llama-cpp` 上下文分配与 Metal 同步契约

### 3.1 引用路径
- `node_modules/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js`
- `node_modules/node-llama-cpp/dist/gguf/insights/utils/resolveContextContextSizeOption.js`
- `node_modules/node-llama-cpp/llama/addon/AddonContext.cpp`

### 3.2 默认 `contextSize` 导致单实例 2.64 GB 内存分配的机制
1. `Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0` 模型的 GGUF 元数据中定义的训练上下文长度（`n_ctx_train`）为 **32,768 (32K)**。
2. 当调用 `model.createEmbeddingContext()` 未显式指定 `contextSize` 时，`resolveContextContextSizeOption.js` 默认尝试按模型的最大训练上下文（32,768）分配 KV Cache 与计算缓冲区。
3. 在 Apple Silicon Metal 后端下，单个 32K Embedding Context 会分配 **`2,464 MB`（`19 × 128 MB + 32 MB`）的 `Untagged` 匿名脏内存 + `172.2 MB` 缓冲区（合计 `~2.64 GB`）**。4 个工作区实例并发初始化即产生 **`10.5 GB` Physical Footprint**。
4. 显式传入 `{ contextSize: 2048 }` 后，进程峰值 Physical Footprint 直接降至 **`495 MB ~ 952 MB`**，且在 `withScope` 退出执行 `await context.dispose(); await model.dispose(); await llama.dispose()` 后，`Untagged` 内存立即回落至 **`~1 MB`**，GGUF 文件映射完全解除。

### 3.3 `LlamaEmbeddingContext.getEmbeddingFor()` 的长度检查契约
在 `node_modules/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js:24-55` 中：
- `getEmbeddingFor(input)` 会将输入拼装上 BOS/EOS 特殊 Token，然后检查：
  ```js
  if (resolvedInput.tokens.length >= this._llamaContext.contextSize) {
    throw new Error(`Input is longer than the context size (${resolvedInput.tokens.length} >= ${this._llamaContext.contextSize})`);
  }
  ```
- **设计结论**：
  1. 单分片的最大 Token 数必须预留特殊 Token 余量（`DEFAULT_MAX_CHUNK_TOKENS = 2000 < 2048`）；
  2. 当单轮问答 Token 数超过 `2000` 时，通过 `splitTextIntoTokenChunks()` 按滑动窗口（窗口 `2000` Tokens，重叠 `128` Tokens）切分为多个分片（`chunk_index = 0, 1, ...`）依次计算向量，既保证永不触发 `>= contextSize` 报错，又保证超长对话 100% 全文可检索。
