# `opencode-recall` 内存暴涨（10.5 GB）与全量分片检索优化正式方案

## 一、问题根因回顾

1. **多工作区重复实例化（`× 4` 内存放大与并发冲突）**：
   - OpenCode Server 按打开的工作区目录分别调用 `plugin.setup(ctx)`（当前进程内 4 个工作区），每次均新建独立的 `RecallDatabase`、`ScopedEmbedder` 和 `RecallIndexer`，导致空闲时 4 个实例同时加载 GGUF 模型并并发向 Metal 提交推理。
2. **`createEmbeddingContext()` 未限制 `contextSize`（单实例分配 ~2.64 GB）**：
   - `Qwen3-Embedding-0.6B` 默认训练上下文为 `32,768`（32K）。未显式指定 `contextSize` 时，单个实例分配约 `2.64 GB` 匿名脏内存，4 个实例叠加达 **10.5 GB**。
3. **全量 692 条一次性载入内存批处理 + 超长文本无分片处理**：
   - `syncPendingSessions()` 一次性读取全部 692 条待处理对话送入 `embedBatch`，要求全部算完才写入 SQLite；且当单条对话超过 `contextSize` 时，`node-llama-cpp` 直接抛错中断，导致进度归零、模型无法释放。

---

## 二、核心设计原则（对齐最新 4 项要求）

1. **超 2048 Token 自动多切片（Multi-Chunk Slicing），全量可查询**：
   - `createEmbeddingContext` 显式限制 `contextSize: 2048`。
   - 当某个轮次（`seq` / `content_hash`）格式化后的 Token 数超出 `2048` 上限时（预留特殊 Token 后单分片上限如 `2000` Tokens），不再丢弃超长部分，而是将该轮对话按 Token 边界**再次切片为多个分片（`chunk_index = 0, 1, 2, ...`）**。
   - 每个分片均独立计算向量并存入 `main.embeddings (content_hash, chunk_index, embedding)`；检索时取同一 `content_hash` 下所有分片的**最高相似度得分（`MAX(score)`）**参与排序，确保长对话的任意位置均 100% 可被语义检索命中。
2. **流式单条读取与单条处理（One-Turn-at-a-Time Streaming）**：
   - 同步待处理对话时，**不在内存中一次性读取全部待处理文本列表**。
   - 每次仅通过 SQLite 查询读取 **1 条** 待处理对话（`LIMIT 1`）送入内存 -> 完成该条的 Token 切片与向量计算 -> 立即将该条的所有分片向量原子写入 SQLite -> 释放该条内存后，再从 SQLite 载入下一条，直到待处理队列为空。
3. **搜索排队等待所有历史会话完成（含正在运行中会话的已完成历史）**：
   - 调用 `session_search` 时，复用同一个进程级串行队列与 `ScopedEmbedder` 作用域，**排队等待所有待处理历史轮次完成向量化落库后**，再对搜索 `query` 向量化并执行检索，保证每次搜索都覆盖 100% 完整历史。
   - `reconcileTurns()` 对账时**包含正在运行中会话（Active / Busy Sessions）已完成的对话轮次**（只要某轮 `user` 消息已有对应的 `assistant` 文本回复即入库索引；当运行中会话后续更新回复或新增轮次时，通过 `max_valid_seq` 及消息更新时间自动增量刷新）。
4. **搜索结果极简文本摘要（User 50 字符 / Assistant 100 字符）**：
   - 数据库与向量切片仍基于完整原文，但在 `formatSearchResults()` 构造工具返回文本时，每条结果严格截断为：
     - `User`：最多保留 **50 个字符**（超出加 `...`）
     - `Assistant`：最多保留 **100 个字符**（超出加 `...`）
   - 既保留完整的 `sessionID`、`title`、`turn #N`、`userMessageID`、`assistantMessageID` 定位元数据，又大幅压缩返回体积。

---

## 三、分模块修改计划

### 1. `packages/opencode-recall/src/embedder.ts`
- **显式限制 `contextSize = 2048`**：
  - 新增 `DEFAULT_EMBEDDING_CONTEXT_SIZE = 2048`、`DEFAULT_MAX_CHUNK_TOKENS = 2000`（预留 BOS/EOS 等特殊 Token 余量，严格满足 `< 2048`）。
  - 在 `acquire()` 中调用 `model.createEmbeddingContext({ contextSize: this.contextSize })`，将单实例内存从 `~2.64 GB` 降至 `~150 MB`。
- **支持单条文本超长自动切片与向量化（`embedDocumentSlices`）**：
  - 在 `ActiveEmbeddingSession` 中暴露基于 `model.tokenize()` / `model.detokenize()`（或 Token 序列）的切片能力：
    - 若输入文本 Token 数 `<= DEFAULT_MAX_CHUNK_TOKENS`，直接作为单个分片 `[vec0]` 返回；
    - 若输入文本 Token 数 `> DEFAULT_MAX_CHUNK_TOKENS`，按固定步长（如窗口 `2000` Tokens，重叠 `128` Tokens 防止语义在切点断裂，并在每個分片前携带简短上下文头）切分为多个分片，依次计算归一化向量并返回 `Float32Array[]`（对应 `chunk_index = 0..k-1`）。
  - 保留/兼容 `embedBatch` 接口，使每个输入文本可返回单个或多个分片向量。

### 2. `packages/opencode-recall/src/db.ts`
- **分片向量表结构升级（`main.embeddings`）**：
  - 将 `main.embeddings` 表升级为支持多切片主键（并在检测到旧版单列主键表结构时平滑迁移或自动重建）：
    ```sql
    CREATE TABLE IF NOT EXISTS main.embeddings (
      content_hash TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      embedding BLOB NOT NULL,
      PRIMARY KEY (content_hash, chunk_index)
    );
    ```
  - 配置 `PRAGMA busy_timeout = 5000;`，防止并发访问时立即报 `database is locked`。
- **单条流式拉取与单条原子落库 API**：
  - 新增 `getMissingEmbeddingCount(): number`（仅统计缺失的 `COUNT(DISTINCT content_hash)`，不加载大文本进内存）。
  - 新增 `getNextMissingEmbedding(excludeHashes?: ReadonlySet<string>): MissingEmbeddingItem | null`：每次使用 `LIMIT 1` 仅读取 **1 条** 尚未存在于 `main.embeddings` 的 `(content_hash, user_text, assistant_text)`。
  - 新增 `saveTurnEmbeddings(contentHash: string, sliceVectors: readonly (Float32Array | readonly number[])[]): void`：在单条事务中先清理该 `content_hash` 旧分片，再写入 `chunk_index = 0..N-1` 的全部切片向量，保证单条对话的所有分片原子生效。
- **包含运行中会话的已完成历史 & 原地更新感知**：
  - `reconcileTurns()` 对账时不再跳过正在运行的会话，所有 `s.parent_id IS NULL` 会话中已形成完整 `(user, assistant)` 配对的历史轮次全部入库。
  - 在 `oc_bounds` 与 `st_bounds` 脏检测中，除对比 `max_valid_seq !== max_end_seq` 外，增加会话消息最大 `time_updated` / 有效消息数校验，确保运行中会话在流式更新或完成后能准确刷新最后一轮的文本与 `content_hash`。
- **多切片聚合检索（`searchTurns`）**：
  - 候选集扫描时读取匹配范围内的 `(content_hash, chunk_index, embedding)`，计算 `dotProduct(queryVec, sliceVec)` 后按 `content_hash` 聚合取 **`MAX(score)`**，再选出 Top-K 个唯一 `content_hash` 关联会话元数据。

### 3. `packages/opencode-recall/src/indexer.ts`
- **逐条流式索引（Single-Item Streaming Loop）**：
  - 在 `syncPendingSessions()` 与 `searchSessions()` 的同步阶段：
    1. 先执行 `this.db.reconcileTurns()` 更新 `session_turns` 元数据并清理孤儿向量；
    2. 若 `this.db.getMissingEmbeddingCount() > 0`，进入单个 `embedder.withScope`；
    3. 循环调用 `this.db.getNextMissingEmbedding()`：**每次只取 1 条**送入内存 -> 切片并计算该条的所有分片向量 -> 立即调用 `this.db.saveTurnEmbeddings(item.contentHash, sliceVectors)` 落库 -> 再读取下一条，直至全部完成。
    4. 单条若发生不可恢复异常，记录失败 hash 跳过该条，避免死循环卡住后续条目。
- **搜索排队等待全量历史完成**：
  - `searchSessions()` 进入同一个串行 `syncQueue`：若后台正在执行逐条同步，搜索自然排队复用或等待其处理完剩余历史条目；并在同一 `withScope` 内确保所有历史会话（含运行中会话的已完成历史轮次）100% 同步完毕后，计算 `query` 向量并执行检索，随后立即在 `finally` 中释放 GPU 模型内存。
- **搜索结果文本定长截断（User 50 / Assistant 100）**：
  - 新增常量 `MAX_RESULT_USER_CHARS = 50`、`MAX_RESULT_ASSISTANT_CHARS = 100`。
  - 新增辅助函数 `truncateDisplayText(text: string, maxChars: number): string`（按 Unicode 码点/`Array.from(text)` 截断前 `maxChars` 个字符，超出追加 `...`）。
  - 在 `formatSearchResults()` 中将输出格式化为：
    - `   User: ${truncateDisplayText(item.userText, 50)}`
    - `   Assistant: ${truncateDisplayText(item.assistantText, 100)}`
- **异步安全销毁（`dispose(): Promise<void>`）**：
  - 设置 `disposed = true`，等待当前 `syncQueue` 与 `embedder` 释放完毕后再关闭 SQLite 连接，杜绝 `database is not open` 异常。

### 4. `packages/opencode-recall/src/index.ts`
- **基于 `globalThis[Symbol.for("opencode.recall.shared.v1")]` 的进程级共享单例**：
  - 同一 `opencode-cli` 进程内的多个工作区（4 个 `setup(ctx)`）共享同一个 `{ db, embedder, indexer, refCount }` 实例，彻底消除 `× 4` 模型重复加载与并发 Metal 冲突（测试传入自定义 `embedder` 或 `:memory:` 时保持独立隔离）。
  - 引用计数管理卸载：仅当最后一个工作区卸载（`refCount === 0`）时异步调用 `await indexer.dispose()`。
- **OpenCode V2 事件适配**：
  - 监听 `session.status`、`session.execution.*` 及 `session.idle` 事件，维护活跃会话集合并在空闲时触发增量同步。

---

## 四、测试与验证计划（`test/recall.test.ts`）

1. **超 2048 Token 自动多切片与检索测试**：
   - 构造一条超长对话（例如前段讨论 `alpha`，后段在 >2048 Token 位置讨论 `omega`），验证被切分为多个 `chunk_index` 存入 `main.embeddings`，且搜索 `omega` 能准确命中该轮次并去重返回。
2. **逐条流式加载与单条落库测试**：
   - 验证存在多条缺失记录时，每次只加载 1 条送入模型处理并立即落库。
3. **搜索等待全量完成 & 包含运行中会话已完成历史测试**：
   - 验证在有未同步历史以及运行中会话已有已完成轮次时，调用 `session_search` 会排队完成所有已完成轮次的索引并检索出结果。
4. **结果文本 50 / 100 字符截断测试**：
   - 验证 `formatSearchResults` 输出中 `User:` 正文不超过 50 字符（超出带 `...`），`Assistant:` 正文不超过 100 字符（超出带 `...`）。
5. **多工作区共享单实例测试**：
   - 验证 4 个工作区同时 `setup(ctx)` 只初始化 1 份底层资源。
