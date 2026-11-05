# opencode-recall

OpenCode V2 历史会话语义检索（RAG）插件，基于内置 `node:sqlite` 与 `node-llama-cpp`。向量推理在本机执行，后端由库根据平台自动选择（如 Metal、CUDA 或 CPU）。

## 核心特性

1. **直接 `ATTACH` OpenCode 原生 SQLite 库 + 双表解耦（`session_turns` + `embeddings`）**：
   - 只读挂载 `~/.local/share/opencode/opencode.db`（`file:...?mode=ro`），直接对齐 `session_v2` 与 `session_message`（包含正在运行中会话的已完成历史轮次）。
   - `session_turns` 按 `(session_id, user_message_id)` 维护有效对话轮次，自动感知并清理多次穿插回滚（`revert`）、原地消息更新与已删除会话。
   - `embeddings` 按 `(content_hash, chunk_index)` 复合主键存储向量：会话分叉（Fork）克隆的历史轮次 100% 复用已有向量，零重复推理；源会话回滚或删除后，只要仍有 Fork 会话引用该轮次，向量自动保留。
2. **2048 Token 上下文预算 + 超长轮次自动多分片 + 单条流式处理**：
   - 显式限制 `contextSize = 2048`（单切片上限 `2000` Tokens，重叠步长 `128` Tokens），消除默认 32K 上下文带来的数 GB 内存开销。
   - 当单轮对话超出 `2048` Token 上限时，自动按滑动窗口切分为多个分片（`chunk_index = 0, 1, ...`）分别计算向量；检索时按 `content_hash` 取 `MAX(score)` 聚合去重排序，实现长对话 100% 全量可查询。
   - 同步时每次仅从 SQLite 读取 **1 条** 待处理对话送入内存（`LIMIT 1`），完成切片与原子落库后再读取下一条，并通过 `globalThis[Symbol.for("opencode.recall.shared.v1")]` 在多工作区间共享单一协调器实例。
3. **严格“用时申请、用完即放”的显存/内存生命周期**：
   - 无任何驻留定时器（Zero Keep-Alive Timer）。
   - 仅在存在缺失 `content_hash` 向量或执行 `session_search` 查询时进入 `ScopedEmbedder.withScope()` 加载模型，并在 `finally` 块中立即调用 `await context.dispose(); await model.dispose(); await llama.dispose()` 释放全部显存与内存。
   - 当 `session_search` 触发时，排队等待所有待处理历史轮次同步完成后，在同一 `withScope` 作用域内计算 Query 向量并执行检索。
4. **单一 `session_search` 工具 + 多会话聚合展示 + 极简摘要截断**：
   - 检索结果按 `content_hash` 占 Top-K 名额（相同问答正文只输出一次），同时在 `sessions (N)` 下完整列出源会话与所有关联 Fork 分支的 `sessionID`、标题及各自对应的 `turn #X (userMessageID, assistantMessageID)`。
   - 每条命中结果的展示文本严格截断为 `User` 最多 **50 字符**、`Assistant` 最多 **100 字符**（超出追加 `...`），防止撑爆主模型上下文。

## 配置方式

在本仓库根目录的项目级 `opencode.jsonc` 中添加插件；其他项目使用自己的安装位置或发布后的包名：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./packages/opencode-recall"
  ]
}
```

可选参数：

```jsonc
{
  "package": "./packages/opencode-recall",
  "options": {
    "modelUri": "hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0",
    "contextSize": 2048,
    "maxChunkTokens": 2000,
    "chunkOverlapTokens": 128,
    "idleDebounceMs": 30000
  }
}
```

### 路径与数据

- `opencodeDbPath`：宿主数据库，默认取 `$XDG_DATA_HOME/opencode/opencode.db` ，未设置时取 `~/.local/share/opencode/opencode.db` 。自定义数据目录、独立实例应显式指定。
- `dbPath`：索引库，默认位于同一数据根目录的 `opencode/recall/index.sqlite` 。保存完整问答文本及向量，按当前用户私有文件权限创建。
- `modelDir`：本地模型目录，默认 `opencode/recall/models` 。首次按 `modelUri` 下载模型；也可以指定已有 GGUF 文件。
- 文件路径支持 `~` 和相对路径；相对路径按插件工作区解析。索引库和宿主库必须是不同文件。
- `scope: "project"` 使用调用会话的项目标识，缺少项目及目录时返回空结果；`scope: "all"` 显式搜索所有已索引项目。返回片段会进入当前模型上下文。

需要支持 `node:sqlite` 的宿主运行时，以及所用 OpenCode 版本的 `session_v2` / `session_message` 表结构。GGUF 下载需要网络；推理不向远端发送会话文本。索引在本地保留，随源会话删除或回滚在后续同步时清理。

## AI 驱动工程复现文档 (`doc/`)

本插件从 0 到 1 的完整 AI 驱动研发过程（包括前期 SQLite 跨会话共享预研、原始需求分析与 Revert/Fork 边界推导、V1 首次实现、线上 10.5 GB 内存暴涨根因诊断、Astra 双重 Review 报告、V2 2048 Token 多分片与流式改造、以及引用的宿主契约与设计方案）均已脱敏归档至 [`./doc/`](./doc/README.md)。

## 运行测试

```bash
npm run test:recall
```
