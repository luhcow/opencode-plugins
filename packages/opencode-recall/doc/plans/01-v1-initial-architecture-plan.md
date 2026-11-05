# OpenCode 历史会话语义检索插件 (`opencode-recall`) 设计方案

## 1. 核心设计原则

在 `packages/opencode-recall` 新增一个极简、零冗余的 OpenCode V2 历史会话语义检索（RAG）插件：

1. **直接 `ATTACH` OpenCode 原生 SQLite 库 + `message_id` 集合对齐 + `content_hash` 向量去重**：
   - OpenCode V2 的所有会话与消息存储在本地 `~/.local/share/opencode/opencode.db` 的 `session_v2` 与 `session_message` 表中。
   - 插件打开自己的向量库 `~/.local/share/opencode/recall/index.sqlite` 后，直接只读挂载：
     ```sql
     ATTACH DATABASE 'file:/.../opencode/opencode.db?mode=ro' AS oc;
     ```
   - 采用 **`session_turns`（会话有效轮次映射表）+ `embeddings`（按 `content_hash` 去重的向量表）** 双表解耦设计，一次性解决**多次穿插回滚（Revert）**与**会话分叉（Fork）**的所有边界情况。
2. **严格“用时申请、用完立即释放”的显存/内存生命周期（零延迟驻留）**：
   - **不设任何 Keep-Alive 定时器驻留模型**。
   - 仅当同步后发现存在 `embeddings` 表中尚未收录的新 `content_hash`，或 `session_search` 需要计算 Query 向量时，才在作用域内申请 `llama` / `model` / `embeddingContext`；一旦当次推理结束，在 `finally` 块中**立即执行 `await context.dispose(); await model.dispose(); await llama.dispose()`**，确保非计算期间 GPU/内存占用严格为 0。
3. **只做语义向量检索，只处理原始对话文本**：
   - 纯粹基于 `node-llama-cpp`（Apple Metal GPU 加速 GGUF Embedding）对原始 `user` + `assistant` 问答轮次做余弦相似度 Top-K 检索，跳过 `type = 'compaction'`。
4. **只暴露单一 `session_search` 工具（无需 `session_read`）**：
   - 搜索结果以 `content_hash` 为单位占 Top-K 名额（避免相同问答正文重复刷屏），但在每条命中结果下列出**所有包含该轮次的 `sessionID` 及其各自的关联位置（`turn` + `userMessageID` / `assistantMessageID`）**，既不浪费名额，也不丢失任何 Fork 分支入口。

---

## 2. 模块结构

计划在 `packages/opencode-recall` 下创建以下文件：

- `packages/opencode-recall/package.json` ：插件包定义，依赖 `@opencode/plugin` 与 `node-llama-cpp`
- `packages/opencode-recall/src/index.ts` ：Server 插件入口，注册 `session_search` 工具、空闲事件触发器与卸载清理
- `packages/opencode-recall/src/db.ts` ：`node:sqlite` 跨库管理（只读 `ATTACH` 原生 `opencode.db`、`session_turns` 集合对账、`content_hash` 去重向量存储与多会话聚合 Top-K 检索）
- `packages/opencode-recall/src/embedder.ts` ：`node-llama-cpp` Metal GPU 严格作用域管理器（`withScope(fn)`，进入时加载、退出 `finally` 立即 `dispose()`，支持并发引用计数）
- `packages/opencode-recall/src/indexer.ts` ：单飞同步与检索协调器（合并缺失 `content_hash` 向量计算与 Query 向量计算于单次 GPU 生命周期内）
- `packages/opencode-recall/test/recall.test.ts` ：多次穿插回滚（`7 -> 4 -> 11 -> 9 -> 12`）、Fork 克隆聚合返回/源会话回滚或删除/半克隆轮次、以及严格即用即放生命周期的单元测试

---

## 3. Revert 与 Fork 的底层行为及双表设计 (`src/db.ts`)

### 3.1 双表结构：`session_turns` + `embeddings(content_hash)`

将 **“会话里有哪些有效轮次”** 与 **“一段问答文本对应的向量”** 解耦为两张表：

```sql
-- 1. 会话有效轮次表：与 oc.session_message 当前存活的有效消息严格按 message_id 对齐
CREATE TABLE IF NOT EXISTS session_turns (
  session_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  user_seq INTEGER NOT NULL,
  turn_index INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  assistant_text TEXT NOT NULL,
  content_hash TEXT NOT NULL, -- sha256(user_text + "\0" + assistant_text)
  PRIMARY KEY (session_id, user_message_id)
);

CREATE INDEX IF NOT EXISTS idx_session_turns_hash ON session_turns(content_hash);

-- 2. 内容去重向量表：相同问答内容全库只算一次、只存一份向量
CREATE TABLE IF NOT EXISTS embeddings (
  content_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL
);
```

### 3.2 四步同步流水线（同时免疫任意 Revert 与任意 Fork 组合）

1. **清理失效轮次（处理所有 Revert 与会话删除，纯 SQL `< 1ms`）**：
   通过 CTE 算出 `oc` 中每个顶层会话（`parent_id IS NULL`）当前的有效消息 `valid_messages`（即未被物理删除且 `m.seq < COALESCE(revert_seq, ∞)`）。删除 `session_turns` 中 `user_message_id` 或 `assistant_message_id` 已不在 `valid_messages` 中的行。
2. **对齐有效轮次写入 `session_turns`（纯 CPU/SQL，不调 GPU）**：
   找出有新增或变动有效消息的会话，提取原始 `(user_text, assistant_text)` 并计算 `content_hash = sha256(...)`，写入 `session_turns`。
3. **清理孤儿向量（纯 SQL `< 1ms`）**：
   ```sql
   DELETE FROM main.embeddings
   WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM main.session_turns);
   ```
4. **仅对缺失的 `content_hash` 启动 GPU 计算向量**：
   ```sql
   SELECT st.content_hash, st.user_text, st.assistant_text
   FROM main.session_turns st
   LEFT JOIN main.embeddings e ON e.content_hash = st.content_hash
   WHERE e.content_hash IS NULL
   GROUP BY st.content_hash;
   ```
   若结果为空则不启动 GPU；若存在新 `content_hash`，进入 `withScope` 批量计算向量写入 `embeddings`，退出 `finally` 立即 `dispose()`。

### 3.3 多个相同 `content_hash` 会话的聚合返回策略

当命中的某一轮对话（同一个 `content_hash`）同时存在于源会话 `ses_A` 以及分叉出去的 `ses_B`、`ses_C` 时：
- **如果只返回其中一个 `sessionID`**：Agent 就不知道从这一轮还分叉出了其他会话分支，可能会漏掉在 Fork 分支里的后续讨论。
- **如果拆成多条独立结果返回**：相同的问答正文会重复打印多次，且挤占 Top-K 的 `limit` 名额。

**解决方案：按 `content_hash` 聚合为 1 个命中项（只占 1 个 `limit` 名额、问答正文只输出 1 次），并在该项的 `sessions` 列表中完整返回所有关联会话的 `sessionID`、标题、是否为 Fork 以及各自对应的 `turn` / `userMessageID` / `assistantMessageID`！**

查询流程：
1. 先从 `embeddings`（限定在符合 `scope` 的 `session_turns` 关联范围内）按余弦相似度选出 Top-K 个不同的 `content_hash`。
2. 对这 Top-K 个 `content_hash`，一次性关联查询 `session_turns st JOIN oc.session_v2 s ON s.id = st.session_id`，按源会话优先、创建时间升序（`ORDER BY (s.fork_session_id IS NOT NULL) ASC, s.time_created ASC`）挂载到该命中项的 `sessions` 数组中。

---

## 4. 严格“用时申请、用完即放”的 GPU 内存管理 (`src/embedder.ts`)

绝不保留任何 `setTimeout` 延迟卸载逻辑，采用 **RAII / 引用计数作用域 (`withScope`)**：

```ts
export class ScopedEmbedder {
  private activeUsers = 0
  private initPromise: Promise<ActiveSession> | null = null
  private session: ActiveSession | null = null

  async withScope<T>(fn: (embedBatch: (texts: string[]) => Promise<Float32Array[]>) => Promise<T>): Promise<T> {
    this.activeUsers += 1
    try {
      if (!this.initPromise) {
        this.initPromise = this.acquire() // getLlama() -> loadModel() -> createEmbeddingContext()
      }
      this.session = await this.initPromise
      return await fn((texts) => this.embedAll(this.session!, texts))
    } finally {
      this.activeUsers -= 1
      if (this.activeUsers === 0) {
        const current = this.session
        this.session = null
        this.initPromise = null
        await current?.context.dispose().catch(() => {})
        await current?.model.dispose().catch(() => {})
        await current?.llama.dispose().catch(() => {})
      }
    }
  }
}
```

---

## 5. `session_search` 工具输入与响应设计

### 5.1 输入参数 (`input` JSON Schema)

```ts
{
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural language query describing the problem, topic, or discussion to search for in historical OpenCode sessions."
    },
    scope: {
      type: "string",
      enum: ["project", "all"],
      description: "Search within the current project ('project', default) or across all projects ('all')."
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Maximum number of matching turns to return (default: 10)."
    }
  },
  required: ["query"],
  additionalProperties: false
}
```

### 5.2 响应内容格式 (`content` 文本结构，支持多会话聚合展示)

每个命中项只输出一遍问答原文，同时在 `sessions` 下完整列出所有拥有该轮次的 `sessionID` 及其各自关联位置：

```markdown
Found 2 matching turns across 4 sessions (synced 1 pending session in 35ms)

1. score: 0.91 | sessions (3):
   - sessionID: ses_eacaf8... | title: "EXAMPLE-ISSUE 问题说明、正常表现与排查" | location: turn #2 (userMessageID: msg_1580..., assistantMessageID: msg_1581...) | directory: ~/code/Sample-Service | updated: 2026-10-25 11:20
   - sessionID: ses_ea7e34... (fork of ses_eacaf8...) | title: "EXAMPLE-ISSUE 问题说明、正常表现与排查 (fork #1)" | location: turn #2 (userMessageID: msg_1581..._12, assistantMessageID: msg_1581..._15) | directory: ~/code/Sample-Service | updated: 2026-10-25 11:45
   - sessionID: ses_ea2623... (fork of ses_eacaf8...) | title: "EXAMPLE-ISSUE 问题说明、正常表现与排查 (fork #2)" | location: turn #2 (userMessageID: msg_15d9..._12, assistantMessageID: msg_15d9..._15) | directory: ~/code/Sample-Service | updated: 2026-10-26 09:10
   User: 帮我梳理一下 EXAMPLE-ISSUE 的正常表现和异常分支
   Assistant: 在正常路径下，当请求命中示例配置时...

2. score: 0.86 | sessions (1):
   - sessionID: ses_01JXYZ... | title: "修复 compact-before 边界回滚与摘要原位渲染" | location: turn #4 (userMessageID: msg_01JAAA..., assistantMessageID: msg_01JBBB...) | directory: . | updated: 2026-10-28 14:32
   User: 为什么回滚之后压缩摘要没有显示在保留边界前？
   Assistant: 因为原生压缩消息存储在链表末尾，需要在 TUI 渲染层找到 boundaryMessageID 对应的节点...
```

---

## 6. 实施步骤

1. **初始化包结构**：创建 `packages/opencode-recall/package.json`，并在根 `package.json` 添加 `test:recall` 脚本。
2. **实现双表跨库对齐与多会话聚合检索层**（`src/db.ts`）：只读 `ATTACH` 原生 `opencode.db`，实现 `session_turns` 集合对账、`embeddings` 按 `content_hash` 去重存储及搜索时按 `content_hash` 聚合所有关联 `sessionID` 返回。
3. **实现即用即放的 Metal GPU Embedder 与同步器**（`src/embedder.ts`、`src/indexer.ts`）：实现 `withScope` 引用计数作用域，退出 `finally` 立即 `dispose()`。
4. **注册 `session_search` 工具与单元测试**（`src/index.ts`、`test/recall.test.ts`）：覆盖多次穿插 Revert、连环 Fork 多会话 `sessionID` 聚合输出、源会话删除/回滚后 Fork 兜底、分叉边界“同问不同答”以及 GPU 立即释放。
