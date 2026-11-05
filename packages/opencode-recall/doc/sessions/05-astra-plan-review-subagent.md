# Astra review modification plan

- **工程阶段**：阶段 3.1：Astra 修改方案深度评审（Subagent 会话）
- **Session ID**：`ses_example_fcdfcd7c5c4e`
- **Parent Session ID**：`ses_example_4cca5a4a3fe3`
- **工作区目录**：`~/workspace`
- **创建时间**：2026-11-04T09:29:16.478Z
- **更新时间**：2026-11-04T09:33:53.267Z
- **定位说明**：由 Astra 模型对初步内存修复计划进行批判性审查，指出 source.bun.ts 模块缓存清除导致顶层 Map 单例失效、node-llama-cpp >= contextSize 直接抛错需配合 Tokenizer 级处理、以及 dispose() 关闭数据库竞争等关键问题。

---

## Turn #1 — User (seq `4`, id `msg_example_604050949e77`)

You are a subagent spawned by another session.
You are reviewing a proposed modification plan for fixing a 10.5 GB memory spike and Metal GPU hang in the OpenCode V2 plugin `packages/opencode-recall`.

## Background & Root Cause Findings (Verified on macOS PID 2945 `opencode-cli serve --service`)
1. **Per-Workspace Plugin Instantiation (`× 4` duplication)**:
   - OpenCode Server calls `plugin.setup(ctx)` once per active project/workspace directory (currently 4 workspaces in `opencode-cli`).
   - In `packages/opencode-recall/src/index.ts`, `setup(ctx)` creates a brand-new `RecallDatabase`, `ScopedEmbedder`, and `RecallIndexer` on each call, and subscribes to `ctx.event.subscribe()`.
   - When `session.idle` fires, all 4 `RecallIndexer` instances trigger `syncPendingSessions()` after 30s debounce, causing 4 concurrent `node-llama-cpp` model loads (`4 × 603.9 MB` mmap of `hf_Qwen_Qwen3-Embedding-0.6B.Q8_0.gguf`), 4 SQLite connections (`index.sqlite` + `opencode.db`), and 4 concurrent embedding contexts.
2. **Unbounded `contextSize` in `model.createEmbeddingContext()` (`~2.64 GB` per instance)**:
   - In `packages/opencode-recall/src/embedder.ts`, `model.createEmbeddingContext()` is called with no options.
   - `Qwen3-Embedding-0.6B` has a 32,768 (32K) training context size. Without an explicit `contextSize`, `node-llama-cpp` allocates `2,464 MB` (`19 × 128 MB + 32 MB`) of `Untagged` KV cache / compute buffer + `172.2 MB` per context (`~2.64 GB` per instance, `10.5 GB` across 4 instances).
3. **Metal CommandQueue Hang & All-Or-Nothing Batch Sync**:
   - In `sample 2945`, 4 threads (`Bun Pool 1/3/4/6`) are permanently stuck in `AddonContextDecodeBatchWorker::Execute() -> llama_context::synchronize() -> ggml_metal_synchronize -> -[_MTLCommandBuffer waitUntilCompleted]`, and `com.Metal.CommandQueueDispatch` is stuck in `IOGPUCommandQueueSubmitCommandBuffers`.
   - `index.sqlite` has 843 `session_turns` (692 distinct `content_hash` missing embeddings) and `0` rows in `embeddings` because `syncPendingSessions()` embeds all 692 turns before calling `this.db.saveEmbeddings(...)` once at the end, and only disposes the `ScopedEmbedder` in `finally` after the entire batch finishes.

## Initial Modification Plan to Review
1. **Process-level Singleton / Shared Core**:
   - Share a single `RecallDatabase`, `ScopedEmbedder`, and `RecallIndexer` across all `setup(ctx)` workspace instances in the same process (when using the same `dbPath`/`opencodeDbPath`/`modelUri`), with reference-counted lifecycle disposal so hot-reload or workspace teardown only closes the shared instance when the last workspace unmounts (while keeping custom `options.embedder` / `:memory:` isolated for unit tests).
2. **Explicit `contextSize` and Input Truncation**:
   - Pass explicit `contextSize` (e.g. `2048`) to `model.createEmbeddingContext({ contextSize })` and truncate/cap input text before embedding so a 19,711-char turn never exceeds the context window or allocates a 32K KV buffer.
3. **Chunked / Incremental Embedding & Persistence + Preemption**:
   - In `syncPendingSessions()`, process `missing` embeddings in small chunks (e.g. 16 or 32 items per chunk) and call `this.db.saveEmbeddings(chunk)` immediately after each chunk so progress is persisted incrementally.
   - Allow background idle sync to be preempted/aborted between chunks when `cancelIdleSync()` (e.g. user starts a prompt) is triggered, or when `searchSessions()` is called.

## Your Task
Read the files in `packages/opencode-recall/src/` (`index.ts`, `embedder.ts`, `indexer.ts`, `db.ts`) and `packages/opencode-recall/test/recall.test.ts` if needed.
Critically review this modification plan:
1. Are there any flaws, subtle edge cases, or missing pieces in the 3 proposed changes above?
2. Why specifically did `AddonContextDecodeBatchWorker::Execute()` hang in Metal, and does `node-llama-cpp` / `Bun` have additional gotchas (e.g. Metal concurrency, `contextSize` vs token count truncation in `node-llama-cpp`, `reload` / file-watcher behavior in OpenCode when editing plugin files, SQLite `BEGIN IMMEDIATE` busy timeouts across processes)?
3. Provide concrete, actionable feedback on the modification plan.

### Tool Call: `skill` (seq `5`, status: `completed`)

**Input:**
```json
{
  "id": "opencode"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
<skill_content name="OpenCode">
# Skill: OpenCode

# OpenCode

Use this guide as the starting point for work involving OpenCode itself. It
covers the core concepts needed to configure and customize OpenCode, extend it
with plugins, and build integrations with the OpenCode SDK, clients, and API.

Full documentation is available at <https://opencode.ai/v2/docs/>. This overview is
only an index of core concepts. Before answering a question about a topic below,
fetch the URL named in that section and use the full page as the source of
truth. Follow links from that page when the question needs more detail. Fetch
<https://opencode.ai/v2/docs/> first when you need to discover the relevant
documentation page.

A machine-readable documentation index is available at
<https://opencode.ai/v2/llms.txt>.

## Version policy

Always answer for OpenCode V2 unless the user explicitly asks about V1,
legacy OpenCode, or migrating from V1.

Use only <https://opencode.ai/v2/docs/> documentation as the source of truth for V2.
Do not use <https://opencode.ai/docs/>, which documents V1, and do not use
general web search to resolve a V2 documentation question when the V2 docs or
linked pages cover it. The schema served from
<https://opencode.ai/config.json> accepts both V2 fields and deprecated V1
fields. Never recommend a field it marks deprecated. If V2 documentation is
missing or contradictory, state the uncertainty or ask for clarification instead of falling back to V1.

V1 documentation and syntax may be consulted only when the user explicitly
asks about V1 or when needed as migration input. Outputs and recommendations
must still use V2 unless the user specifically requests a V1 result.

## [CLI](https://opencode.ai/v2/docs/cli)

For questions about the terminal interface, command-line invocation, `run`,
`mini`, terminal providers, or other CLI behavior, fetch the
[CLI guide](https://opencode.ai/v2/docs/cli) and the relevant page linked from
that section.

CLI and TUI preferences are separate from OpenCode's server and project
configuration. They live in the global `~/.config/opencode/cli.json`, or
`$XDG_CONFIG_HOME/opencode/cli.json` when `XDG_CONFIG_HOME` is set. There is no
project-local CLI configuration. Set `OPENCODE_CLI_CONFIG_CONTENT` to merge
inline JSON over the global settings. Most preferences can also be changed from
the TUI by pressing `Ctrl+P` and selecting **Open settings**.


... [省略中间 205 行输出，完整源码与引用契约见仓库及 doc/references/] ...

  `opencode api get /api/info`.
- Compare with `opencode --standalone`, which runs the TUI with a private
  server, to isolate shared-service issues.
- Inspect `~/.local/share/opencode/log/opencode.log`. Filter `role=cli` for
  client startup and `role=server` for sessions, providers, plugins,
  permissions, and tools.
- Run one reproduction with `OPENCODE_LOG_LEVEL=DEBUG` when normal logs are not
  sufficient.
- Do not delete or edit the database, service registration, or service config
  while diagnosing a problem. Back up persistent data before inspecting it
  with external tools.
- Redact API keys, authorization headers, prompts, file contents, and other
  sensitive data before sharing diagnostics.

See the [full troubleshooting guide](https://opencode.ai/v2/docs/troubleshooting)
for service lifecycle commands, API inspection, log locations, explicit server
connections, issue-reporting details, and local development paths.

Base directory for this skill: /builtin
Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.
Note: file list is sampled.

<skill_files>
</skill_files>
</skill_content>
```
</details>

### Tool Call: `read` (seq `12`, status: `completed`)

**Input:**
```json
{
  "path": "packages/opencode-recall/src/index.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file packages/opencode-recall/src/index.ts, lines 1-227
1: import { Plugin } from "@opencode/plugin"
2: import {
3:   RecallDatabase,
4:   computeContentHash,
5:   dotProduct,
6:   extractAssistantText,
7:   extractUserText,
8:   getDefaultOpencodeDbPath,
9:   getDefaultRecallDbPath,
10:   groupMessagesIntoTurns,
11:   normalizeVector,
12:   type ExtractedTurn,
13:   type MissingEmbeddingItem,
14:   type RecallDbOptions,
15:   type ReconcileOptions,
16:   type ReconcileSummary,
17:   type SearchResultItem,
18:   type SearchResultSession,
19:   type SearchTurnsOptions,
20: } from "./db.ts"
21: import {
22:   DEFAULT_EMBEDDING_MODEL_URI,
23:   ScopedEmbedder,
24:   getDefaultModelDir,
25:   type ActiveEmbeddingSession,
26:   type DisposableResource,
27:   type EmbedBatchFn,
28:   type Embedder,
29:   type ScopedEmbedderOptions,
30: } from "./embedder.ts"
31: import {
32:   DEFAULT_IDLE_DEBOUNCE_MS,
33:   RecallIndexer,
34:   formatSearchResults,
35:   formatTimestamp,
36:   formatTurnForEmbedding,
37:   type RecallIndexerOptions,
38:   type SearchSessionsInput,
39:   type SearchSessionsResult,
40:   type SyncPendingResult,
41: } from "./indexer.ts"
42: 
43: export {
44:   DEFAULT_EMBEDDING_MODEL_URI,
45:   DEFAULT_IDLE_DEBOUNCE_MS,
46:   RecallDatabase,
47:   RecallIndexer,
48:   ScopedEmbedder,
49:   computeContentHash,

... [省略中间 153 行输出，完整源码与引用契约见仓库及 doc/references/] ...

203:               data?: { sessionID?: string }
204:               properties?: { sessionID?: string }
205:             }
206:             if (ev.type === "session.idle" || ev.type === "session.execution.succeeded") {
207:               indexer.scheduleIdleSync()
208:             } else if (ev.type === "session.busy" || ev.type === "session.prompt") {
209:               indexer.cancelIdleSync()
210:             }
211:           }
212:         } catch (error) {
213:           if (!controller.signal.aborted) {
214:             console.error("[opencode-recall] event loop error", error)
215:           }
216:         }
217:       })()
218:     }
219: 
220:     return async () => {
221:       controller.abort()
222:       indexer.dispose()
223:       await promptRegistration?.dispose?.()
224:       await toolRegistration?.dispose?.()
225:     }
226:   },
227: })
```
</details>

### Tool Call: `read` (seq `12`, status: `completed`)

**Input:**
```json
{
  "path": "packages/opencode-recall/src/embedder.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file packages/opencode-recall/src/embedder.ts, lines 1-151
1: import { mkdirSync } from "node:fs"
2: import { join } from "node:path"
3: import { getDefaultDataHome, normalizeVector } from "./db.ts"
4: 
5: export const DEFAULT_EMBEDDING_MODEL_URI =
6:   "hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0"
7: 
8: export type EmbedBatchFn = (texts: readonly string[]) => Promise<Float32Array[]>
9: 
10: export interface Embedder {
11:   withScope<T>(fn: (embedBatch: EmbedBatchFn) => Promise<T>): Promise<T>
12:   readonly isActive: boolean
13: }
14: 
15: export interface DisposableResource {
16:   dispose(): Promise<void>
17: }
18: 
19: export interface ActiveEmbeddingSession {
20:   embed(text: string): Promise<Float32Array | readonly number[]>
21:   context: DisposableResource
22:   model: DisposableResource
23:   llama: DisposableResource
24: }
25: 
26: export interface ScopedEmbedderOptions {
27:   modelUri?: string
28:   modelDir?: string
29:   /** Optional custom session factory (used in tests to verify strict acquire/dispose lifecycle without downloading GGUF). */
30:   acquireSession?: () => Promise<ActiveEmbeddingSession>
31: }
32: 
33: export function getDefaultModelDir(): string {
34:   return join(getDefaultDataHome(), "opencode", "recall", "models")
35: }
36: 
37: export class ScopedEmbedder implements Embedder {
38:   readonly modelUri: string
39:   readonly modelDir: string
40:   private readonly customAcquire?: () => Promise<ActiveEmbeddingSession>
41: 
42:   private activeUsers = 0
43:   private initPromise: Promise<ActiveEmbeddingSession> | null = null
44:   private session: ActiveEmbeddingSession | null = null
45:   private disposePromise: Promise<void> | null = null
46: 
47:   constructor(options: ScopedEmbedderOptions = {}) {
48:     this.modelUri = options.modelUri ?? DEFAULT_EMBEDDING_MODEL_URI
49:     this.modelDir = options.modelDir ?? getDefaultModelDir()

... [省略中间 77 行输出，完整源码与引用契约见仓库及 doc/references/] ...

127:           model,
128:           llama,
129:         }
130:       } catch (error) {
131:         await model.dispose().catch(() => {})
132:         throw error
133:       }
134:     } catch (error) {
135:       await llama.dispose().catch(() => {})
136:       throw error
137:     }
138:   }
139: 
140:   private async embedAll(
141:     session: ActiveEmbeddingSession,
142:     texts: readonly string[],
143:   ): Promise<Float32Array[]> {
144:     const vectors: Float32Array[] = []
145:     for (const text of texts) {
146:       const raw = await session.embed(text)
147:       vectors.push(normalizeVector(raw))
148:     }
149:     return vectors
150:   }
151: }
```
</details>

### Tool Call: `read` (seq `12`, status: `completed`)

**Input:**
```json
{
  "path": "packages/opencode-recall/src/indexer.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file packages/opencode-recall/src/indexer.ts, lines 1-248
1: import type {
2:   RecallDatabase,
3:   ReconcileSummary,
4:   SearchResultItem,
5: } from "./db.ts"
6: import type { Embedder } from "./embedder.ts"
7: 
8: export const DEFAULT_IDLE_DEBOUNCE_MS = 30_000
9: 
10: export interface RecallIndexerOptions {
11:   db: RecallDatabase
12:   embedder: Embedder
13:   idleDebounceMs?: number
14: }
15: 
16: export interface SyncPendingResult {
17:   reconciled: ReconcileSummary
18:   embeddedCount: number
19:   durationMs: number
20: }
21: 
22: export interface SearchSessionsInput {
23:   query: string
24:   scope?: "project" | "all"
25:   projectID?: string
26:   directory?: string
27:   excludeSessionID?: string
28:   limit?: number
29: }
30: 
31: export interface SearchSessionsResult {
32:   items: SearchResultItem[]
33:   text: string
34:   syncedTurns: number
35:   durationMs: number
36: }
37: 
38: export function formatTurnForEmbedding(userText: string, assistantText: string): string {
39:   return `User: ${userText}\nAssistant: ${assistantText}`
40: }
41: 
42: export function formatTimestamp(ms: number): string {
43:   if (!Number.isFinite(ms) || ms <= 0) return "unknown"
44:   const d = new Date(ms)
45:   const pad = (n: number) => String(n).padStart(2, "0")
46:   return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
47: }
48: 
49: export function formatSearchResults(

... [省略中间 174 行输出，完整源码与引用契约见仓库及 doc/references/] ...

224:         scope: input.scope,
225:         projectID: input.projectID,
226:         directory: input.directory,
227:         excludeSessionID: input.excludeSessionID,
228:         limit: input.limit,
229:       })
230: 
231:       const durationMs = performance.now() - start
232:       const text = formatSearchResults(query, items, missing.length, durationMs)
233: 
234:       return {
235:         items,
236:         text,
237:         syncedTurns: missing.length,
238:         durationMs,
239:       }
240:     })
241:   }
242: 
243:   dispose(): void {
244:     this.disposed = true
245:     this.cancelIdleSync()
246:     this.db.close()
247:   }
248: }
```
</details>

### Tool Call: `read` (seq `12`, status: `completed`)

**Input:**
```json
{
  "path": "packages/opencode-recall/src/db.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file packages/opencode-recall/src/db.ts, lines 1-789
1: import { createHash } from "node:crypto"
2: import { mkdirSync } from "node:fs"
3: import { homedir } from "node:os"
4: import { dirname, join } from "node:path"
5: import { DatabaseSync } from "node:sqlite"
6: import { pathToFileURL } from "node:url"
7: 
8: export interface RecallDbOptions {
9:   /** Path to the plugin's own SQLite database (or ":memory:" for tests). */
10:   dbPath?: string
11:   /** Path to OpenCode's native SQLite database (`opencode.db`). */
12:   opencodeDbPath?: string
13: }
14: 
15: export interface ExtractedTurn {
16:   sessionID: string
17:   userMessageID: string
18:   assistantMessageID: string
19:   userSeq: number
20:   endSeq: number
21:   turnIndex: number
22:   userText: string
23:   assistantText: string
24:   contentHash: string
25: }
26: 
27: export interface MissingEmbeddingItem {
28:   contentHash: string
29:   userText: string
30:   assistantText: string
31: }
32: 
33: export interface ReconcileOptions {
34:   excludeSessionID?: string
35: }
36: 
37: export interface ReconcileSummary {
38:   deletedTurns: number
39:   upsertedTurns: number
40:   deletedEmbeddings: number
41:   missingEmbeddings: MissingEmbeddingItem[]
42: }
43: 
44: export interface SearchTurnsOptions {
45:   queryEmbedding: Float32Array | readonly number[]
46:   scope?: "project" | "all"
47:   projectID?: string
48:   directory?: string
49:   excludeSessionID?: string

... [省略中间 715 行输出，完整源码与引用契约见仓库及 doc/references/] ...

765:     }
766: 
767:     return results
768:   }
769: 
770:   getTurnCount(): number {
771:     const row = this.db.prepare("SELECT COUNT(*) AS count FROM main.session_turns").get() as { count: number }
772:     return Number(row.count)
773:   }
774: 
775:   getEmbeddingCount(): number {
776:     const row = this.db.prepare("SELECT COUNT(*) AS count FROM main.embeddings").get() as { count: number }
777:     return Number(row.count)
778:   }
779: 
780:   close(): void {
781:     if (this.closed) return
782:     this.closed = true
783:     try {
784:       this.db.close()
785:     } catch {
786:       // Ignore close errors
787:     }
788:   }
789: }
```
</details>

### Tool Call: `read` (seq `12`, status: `completed`)

**Input:**
```json
{
  "path": "packages/opencode-recall/test/recall.test.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file packages/opencode-recall/test/recall.test.ts, lines 1-936
1: import assert from "node:assert/strict"
2: import { mkdtempSync, rmSync } from "node:fs"
3: import { tmpdir } from "node:os"
4: import { join } from "node:path"
5: import { DatabaseSync } from "node:sqlite"
6: import test from "node:test"
7: import plugin, {
8:   RecallDatabase,
9:   RecallIndexer,
10:   ScopedEmbedder,
11:   computeContentHash,
12:   type ActiveEmbeddingSession,
13:   type ToolEditor,
14: } from "../src/index.ts"
15: 
16: /**
17:  * Creates a temporary OpenCode V2 native SQLite database (`opencode.db`)
18:  * with the exact `session_v2` and `session_message` schema.
19:  */
20: function createMockOpencodeDb() {
21:   const dir = mkdtempSync(join(tmpdir(), "opencode-recall-test-"))
22:   const opencodeDbPath = join(dir, "opencode.db")
23:   const recallDbPath = join(dir, "recall.sqlite")
24:   const ocDb = new DatabaseSync(opencodeDbPath)
25: 
26:   ocDb.exec(`
27:     CREATE TABLE session_v2 (
28:       id TEXT PRIMARY KEY,
29:       project_id TEXT NOT NULL,
30:       workspace_id TEXT,
31:       parent_id TEXT,
32:       fork_session_id TEXT,
33:       fork_boundary TEXT,
34:       slug TEXT NOT NULL,
35:       directory TEXT NOT NULL,
36:       title TEXT,
37:       version TEXT NOT NULL,
38:       revert TEXT,
39:       time_created INTEGER NOT NULL,
40:       time_updated INTEGER NOT NULL
41:     );
42: 
43:     CREATE TABLE session_message (
44:       id TEXT PRIMARY KEY,
45:       session_id TEXT NOT NULL,
46:       type TEXT NOT NULL,
47:       seq INTEGER NOT NULL,
48:       time_created INTEGER NOT NULL,
49:       time_updated INTEGER NOT NULL,

... [省略中间 862 行输出，完整源码与引用契约见仓库及 doc/references/] ...

912: 
913:     const p2 = tracked.embedder.withScope(async (embedBatch) => {
914:       assert.equal(tracked.embedder.activeUserCount, 2)
915:       const res = await embedBatch(["sqlite wal"])
916:       releaseFirst()
917:       return res
918:     })
919: 
920:     const [r1, r2] = await Promise.all([p1, p2])
921:     assert.equal(r1.length, 1)
922:     assert.equal(r2.length, 1)
923:     assert.equal(tracked.acquireCount, 1, "Concurrent withScope calls must share 1 acquire")
924:     assert.equal(tracked.disposeCount, 1, "Concurrent withScope calls must dispose once when activeUsers reaches 0")
925:     assert.equal(tracked.embedder.isActive, false)
926: 
927:     // 5. Idle debounce cancellation on busy/prompt
928:     indexer.scheduleIdleSync()
929:     assert.equal(indexer.hasPendingIdleTimer, true)
930:     indexer.cancelIdleSync()
931:     assert.equal(indexer.hasPendingIdleTimer, false)
932:   } finally {
933:     indexer.dispose()
934:     env.cleanup()
935:   }
936: })
```
</details>

### Tool Call: `webfetch` (seq `12`, status: `completed`)

**Input:**
```json
{
  "url": "https://opencode.ai/v2/docs/build/plugins"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
# Overview

Plugins modify OpenCode's behavior and add new features. A plugin is one package with a server part, a TUI part, a GUI
part, or any combination.

```ts title=".opencode/plugins/example/index.ts"
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.storage.set("loaded", true)
  },
})
```

Migrating an existing OpenCode 1 plugin? Follow the [V1 plugin migration guide](/build/plugins/migrate-v1).

## Parts

Each part is an export of the package. Every part's SDK comes from the one `@opencode/plugin` dependency.

```json title="package.json"
{
  "name": "opencode-acme-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
    "./gui-experimental": "./dist/gui-experimental.cjs",
    "./rpc": "./src/rpc.ts"
  },
  "files": ["src", "dist"],
  "dependencies": {
    "@opencode/plugin": "latest"
  }
}
```

- **Server** (`.` or `./server`) runs in the OpenCode server with `@opencode/plugin`. It adds tools, hooks,
  integrations, commands, and agents. See [Server](/build/plugins/server), or [Effect plugins](/build/plugins/effect)
  for the Effect API.
- **TUI** (`./tui`) runs in the terminal UI with `@opencode/plugin/tui`. See [TUI](/build/plugins/cli).
- **GUI** (`./gui-experimental`) runs its `setup` in every OpenCode Desktop window and its `main` in the desktop app's
  main process, with `@opencode/plugin/gui`. See [GUI](/build/plugins/gui).
- **RPC** (`./rpc`) is a typed contract that the server part implements and the other parts and clients call. See
  [RPC](/build/plugins/rpc).

The plugin's `id` comes from its server part's `Plugin.define`. A package with a GUI part and no server part takes its

... [省略中间 43 行输出，完整源码与引用契约见仓库及 doc/references/] ...

```bash
npm publish
```

- Export `./rpc` when other plugins and clients should import your [RPC contract](/build/plugins/rpc) without loading
  your implementation.
- Build the GUI bundle before you publish, and include it through `files`. See
  [Build the bundle](/build/plugins/gui#build-the-bundle).
- Use versions compatible with the OpenCode release you target, and test the installed package, not only a
  workspace-linked copy. Publish a compatible plugin update when you adopt a newer API contract.

<CardGroup cols={2}>
  <Card title="Server" href="/build/plugins/server">
    Add tools, hooks, integrations, commands, and agents in the OpenCode server.
  </Card>
  <Card title="TUI" href="/build/plugins/cli">
    Add commands, routes, slots, and Markdown renderers to the terminal UI.
  </Card>
  <Card title="GUI" href="/build/plugins/gui">
    Add panels, commands, settings pages, and native integrations to OpenCode Desktop.
  </Card>
  <Card title="RPC" href="/build/plugins/rpc">
    Expose typed methods and events from the server part to the other parts and to clients.
  </Card>
</CardGroup>
```
</details>

### Tool Call: `execute` (seq `12`, status: `completed`)

**Input:**
```json
{
  "code": "return await tools.context7[\"resolve-library-id\"]({libraryName:\"node-llama-cpp\",query:\"embedding context contextSize getEmbeddingFor token truncate Bun compatibility disposal Metal\"})"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Available Libraries:

- Title: Node Llama.cpp
- Context7-compatible library ID: /withcatai/node-llama-cpp
- Description: Run AI models locally on your machine with pre-built bindings and Metal, CUDA, and Vulkan support, offering a complete suite for LLM integration in your projects.
- Code Snippets: 919
- Source Reputation: Medium
- Benchmark Score: 77.47
----------
- Title: Node Llama Cpp (DeepWiki)
- Context7-compatible library ID: /websites/deepwiki_withcatai_node-llama-cpp
- Description: node-llama-cpp is a Node.js library that provides bindings to the llama.cpp C++ library, enabling developers to run large language models locally on their machine.
- Code Snippets: 569
- Source Reputation: Medium
----------
- Title: Llama Cpp Provider
- Context7-compatible library ID: /lgrammel/llama-cpp-provider
- Description: A llama.cpp provider for the Vercel AI SDK that enables local LLM inference in Node.js via native C++ bindings.
- Code Snippets: 382
- Source Reputation: High
```
</details>

### Tool Call: `read` (seq `43`, status: `completed`)

**Input:**
```json
{
  "path": "packages/opencode-recall/package.json"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file packages/opencode-recall/package.json, lines 1-34
1: {
2:   "name": "opencode-recall",
3:   "version": "0.1.0",
4:   "description": "OpenCode V2 semantic session history search (RAG) plugin powered by node-llama-cpp and SQLite.",
5:   "type": "module",
6:   "license": "GPL-3.0-or-later",
7:   "main": "./src/index.ts",
8:   "exports": {
9:     ".": "./src/index.ts",
10:     "./server": "./src/index.ts"
11:   },
12:   "files": [
13:     "src"
14:   ],
15:   "scripts": {
16:     "test": "node --experimental-strip-types --test test/*.test.ts"
17:   },
18:   "dependencies": {
19:     "node-llama-cpp": "^3.16.2"
20:   },
21:   "peerDependencies": {
22:     "@opencode/plugin": ">=2.0.0"
23:   },
24:   "keywords": [
25:     "opencode",
26:     "opencode-plugin",
27:     "session",
28:     "rag",
29:     "recall",
30:     "semantic-search",
31:     "sqlite",
32:     "node-llama-cpp"
33:   ]
34: }
```
</details>

### Tool Call: `glob` (seq `43`, status: `completed`)

**Input:**
```json
{
  "path": ".",
  "pattern": "**/node-llama-cpp*/**/LlamaEmbeddingContext.*",
  "limit": 20
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
No files found
```
</details>

### Tool Call: `execute` (seq `43`, status: `completed`)

**Input:**
```json
{
  "code": "return await tools.context7[\"query-docs\"]({libraryId:\"/withcatai/node-llama-cpp\",query:\"LlamaEmbeddingContext getEmbeddingFor contextSize tokens special BOS EOS _fitInputIntoContext truncate input\",language:\"TypeScript\"})"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
### Text prefix/suffix tokens resolved by tokenizer type

Source: https://github.com/withcatai/node-llama-cpp/blob/master/src/utils/tokenizerUtils.ts

Determines which special tokens get prepended/appended to embedding inputs (BOS based on tokenizer type/shouldPrependBosToken, and SEP/EOS/shouldAppendEosToken at the end). This is the logic that answers the "text prefixes" part of the query for getEmbeddingFor, mirrored from llama.cpp's llama_tokenize_internal.

```typescript
export function resolveBeginningTokenToPrepend(vocabularyType: LlamaVocabularyType, tokens: LlamaModelTokens) {
    if (vocabularyType === LlamaVocabularyType.rwkv)
        return null;

    if (vocabularyType === LlamaVocabularyType.wpm)
        return tokens.bos;


    if (vocabularyType === LlamaVocabularyType.ugm)
        return null;

    if (tokens.shouldPrependBosToken)
        return tokens.bos;

    return null;
}

export function resolveEndTokenToAppend(vocabularyType: LlamaVocabularyType, tokens: LlamaModelTokens) {
    if (vocabularyType === LlamaVocabularyType.rwkv)
        return null;

    if (vocabularyType === LlamaVocabularyType.wpm)
        return tokens.sep;

    if (vocabularyType === LlamaVocabularyType.ugm)
        return tokens.eos;

    if (tokens.shouldAppendEosToken)
        return tokens.eos;

    return null;
}
```

--------------------------------

### Create Embedding with getEmbeddingFor

Source: https://github.com/withcatai/node-llama-cpp/blob/master/docs/index.md

Loads a model and creates an embedding context to generate an embedding vector for a given text. Uses the model path 'my-model.gguf' and logs the embedding vector.

```TypeScript

... [省略中间 69 行输出，完整源码与引用契约见仓库及 doc/references/] ...

console.log("Text:", text);

const embedding = await context.getEmbeddingFor(text);
console.log("Embedding vector:", embedding.vector);
```

--------------------------------

### Tokenize special token with special tokens mode

Source: https://github.com/withcatai/node-llama-cpp/blob/master/docs/guide/tokens.md

Tokenizes the special token '<|begin_of_text|>' with special tokens mode enabled by passing 'true' as the second argument to the '.tokenize(...)' function. The output is a single token ID [128000].

```typescript
import {getLlama} from "node-llama-cpp";

const llama = await getLlama();
const model = await llama.loadModel({
    modelPath: "Meta-Llama-3-8B-Instruct.Q4_K_M.gguf"
});

const tokens = model.tokenize("<|begin_of_text|>", true);
console.log(tokens); // [128000]
```
```
</details>

### Tool Call: `webfetch` (seq `43`, status: `completed`)

**Input:**
```json
{
  "url": "https://opencode.ai/v2/docs/build/plugins/server"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
# Server

The server part of a plugin runs in the OpenCode server. It modifies OpenCode's behavior and adds features: tools,
hooks, integrations, commands, and agents. See the [Overview](/build/plugins) for how a plugin package is laid out,
loaded, and published.

```ts title=".opencode/plugins/example/index.ts"
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.storage.set("loaded", true)
  },
})
```

## Lifecycle

`setup` runs when the plugin loads. It may return a cleanup function that runs when the plugin unloads.

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  setup(ctx) {
    console.log(`loaded in OpenCode ${ctx.app.version}`)
    return () => console.log("unloaded")
  },
})
```

### Context

The plugin context is essentially an [OpenCode server client](/build/client).
Its read and action methods use the same inputs and responses as the client. It
adds plugin-only methods for transforms, runtime hooks, reloads, registrations,
and plugin options.

```ts
setup(ctx) {
  console.log(ctx.app.version)
}
```

`ctx.location` describes the location where this plugin instance is loaded. It
includes `directory`, optional `workspaceID`, and `project` metadata (`id`,
`directory`, and `canonical`). It is available in both Promise and Effect plugins.
This is the plugin instance's location, not the location of every session it can

... [省略中间 1409 行输出，完整源码与引用契约见仓库及 doc/references/] ...


- `maxTokens` is the semantic output-token limit.
- Gemini supports `topK`; OpenAI Responses does not expose it.

#### Model request

Modify model request settings and optionally scope the hook to one provider. The event carries the same `kind`
as the HTTP hooks below.

```ts
await ctx.session.hook(
  "model.request",
  (event) => {
    event.headers["x-plugin"] = "review"
  },
  { providerID: "anthropic" },
)
```

#### Native HTTP

Modify native provider requests or responses. Their bodies are one-shot streams; clone or replace a body before reading
it.

[showing lines 1-1483 of 1813; full output saved to ~/.local/share/opencode/tool-output/tool_example_f1520cb35882]
```
</details>

### Tool Call: `webfetch` (seq `43`, status: `completed`)

**Input:**
```json
{
  "url": "https://opencode.ai/v2/docs/plugins"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
# Plugins

Add published packages, versioned packages, scoped packages, or local plugin directories to `opencode.json(c)`.

## Configure

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-acme-plugin",
    "opencode-acme-plugin@1.2.0",
    "@acme/opencode-plugin",
    "./plugins/local",
    "../shared/plugin",
    "/absolute/path/plugin",
    "file://~/plugins/local",
    {
      "package": "@acme/opencode-plugin",
      "options": {
        "agent": "reviewer",
        "strict": true,
      },
    },
  ],
}
```

Relative paths resolve from the config file containing the entry.

Configured local paths must be directories. A path to a single file is skipped. See [Load](/build/plugins#load) for
how OpenCode finds each part in a directory.

Plugin arrays from applicable config files are applied from lowest to highest precedence instead of replacing one
another.

```text
~/.config/opencode/opencode.jsonc
./opencode.jsonc
./.opencode/opencode.jsonc
```

## Discover

OpenCode also loads direct `.ts` and `.js` files and immediate plugin package directories from every discovered
`.opencode/plugins/` directory.

```text
.opencode/
└── plugins/

... [省略中间 83 行输出，完整源码与引用契约见仓库及 doc/references/] ...

plugins from the server it runs, so configure the plugin in your global `opencode.json(c)` to use it in every window.

```jsonc title="~/.config/opencode/opencode.jsonc"
{
  "plugins": ["opencode-acme-plugin"],
}
```

**Settings > Extensions > Plugins** lists them when the app's own server is selected. A plugin's switch turns off only
its desktop UI, and **Reload** loads it again after a failure. To turn off the whole plugin, add `-` and its ID to
`plugins`, for example `"-acme"`.

## Terminal

TUI-only plugins are configured separately and remain active when connected to a remote server.

```json title="cli.json"
{
  "plugins": ["opencode-acme-cli"]
}
```

<Card title="Build a plugin" href="/build/plugins">
  Create plugins that add tools, hooks, integrations, commands, agents, and other behavior.
</Card>
```
</details>

### Tool Call: `read` (seq `43`, status: `completed`)

**Input:**
```json
{
  "path": "~/code"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read directory ~/code, entries 1-17
.claude/
.oneskill-cli/
apkg/
sample-corp/
debug/
dsh-plugin/
dsh-remote/
dsh-think-level/
imcp/
KamaClaude/
mini-lsm/
opencode-plugins/
opencode/
skills/
terminal-anki/
test/
.DS_Store
```
</details>

### Tool Call: `read` (seq `70`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read directory node_modules/node-llama-cpp, entries 1-7
bins/
dist/
llama/
templates/
LICENSE
package.json
README.md
```
</details>

### Tool Call: `read` (seq `70`, status: `error`)

**Input:**
```json
{
  "path": "packages/opencode-recall/node_modules/node-llama-cpp"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
{
  "type": "tool.execution",
  "message": "File not found: packages/opencode-recall/node_modules/node-llama-cpp\n\nThe folder packages/opencode-recall/node_modules does not exist. The nearest folder that does is packages/opencode-recall."
}
```
</details>

### Tool Call: `grep` (seq `70`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>",
  "pattern": "(import.*timestamp|cacheBust|cache.bust|plugin.*watch|watch.*plugin)",
  "include": "*.ts",
  "limit": 40
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Found 13 matches
<opencode-repo>/packages/tui/src/plugin/watch.ts:
  Line 6: // Watch plugin sources for changes. Files are watched through their parent

  Line 11: // Directory targets are watched at their root only; the plugin source loader


<opencode-repo>/packages/core/test/database-migration.test.ts:
  Line 99:   test("imports unnamed legacy Drizzle journal entries by their actual migration timestamps", async () => {


<opencode-repo>/packages/core/src/plugin/internal.ts:
  Line 23: import { ConfigLocationWatcherPlugin } from "../config/plugin/location-watcher.js"


<opencode-repo>/packages/tui/test/plugin-source.test.ts:
  Line 9: import { createSourceWatcher } from "../src/plugin/watch"

  Line 237:   expect(watched.some((item) => item.replaceAll("\\", "/").endsWith("/node_modules/@opencode/plugin"))).toBe(false)


<opencode-repo>/packages/core/src/config/plugin/source.ts:
  Line 67:             Effect.logError("configured plugin watch failed", { target: operation.target, cause }),


<opencode-repo>/packages/core/src/plugin/module.ts:
  Line 136:   // A local plugin's `./gui-experimental` bundle is outside the server entry's import graph: watch it, and let its


<opencode-repo>/packages/core/test/filesystem/watcher.test.ts:
  Line 7: import { ConfigLocationWatcherPlugin } from "@opencode/core/config/plugin/location-watcher"

  Line 485:       name: "test/watcher-plugins",

  Line 501:       { vcs: "git", watcher, plugins: PluginSupervisor.node.replace(plugins) },


<opencode-repo>/packages/cli/script/service-smoke.ts:
  Line 187:     if (++attempt % 10 === 0) await fs.writeFile(plugin, `${pluginSource()}// watcher retry ${attempt}\n`)


<opencode-repo>/packages/desktop/src/main/plugin/host.ts:
  Line 415:     void watchPlugins().catch((cause: unknown) => input.log("plugin watch failed", { cause: String(cause) }))

```
</details>

### Tool Call: `execute` (seq `70`, status: `completed`)

**Input:**
```json
{
  "code": "return await tools.context7[\"query-docs\"]({libraryId:\"/withcatai/node-llama-cpp\",query:\"Bun support native bindings hangs crashes Metal concurrent contexts threads getLlama disposal\",language:\"TypeScript\"})"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
### Manual disposal of a model and its contexts

Source: https://github.com/withcatai/node-llama-cpp/blob/master/docs/guide/objects-lifecycle.md

Shows how to manually dispose a model, which automatically disposes its contexts. After disposal, the context's `disposed` property is `true`. Attempting to use a disposed object throws a `DisposedError`.

```typescript
import {fileURLToPath} from "url";
import path from "path";
import {getLlama, LlamaChatSession} from "node-llama-cpp";

const __dirname = path.dirname(
    fileURLToPath(import.meta.url)
);
const modelPath = path.join(__dirname, "my-model.gguf");

// ---cut---
const llama = await getLlama();
const model = await llama.loadModel({modelPath});
const context = await model.createContext();

await model.dispose();
console.log("Context disposed:", context.disposed); // true
```

--------------------------------

### Automatic disposal with `await using`

Source: https://github.com/withcatai/node-llama-cpp/blob/master/docs/guide/objects-lifecycle.md

Demonstrates using TypeScript's `await using` to automatically dispose a model when it goes out of scope, which also disposes its contexts. Requires TypeScript 5.2 or later.

```typescript
import {fileURLToPath} from "url";
import path from "path";
import {getLlama, LlamaChatSession, LlamaContext} from "node-llama-cpp";

const __dirname = path.dirname(
    fileURLToPath(import.meta.url)
);
const modelPath = path.join(__dirname, "my-model.gguf");

// ---cut---
const llama = await getLlama();
let context: LlamaContext | undefined;

async function doThings() {
    await using model = await llama.loadModel({modelPath});
    context = await model.createContext();

... [省略中间 23 行输出，完整源码与引用契约见仓库及 doc/references/] ...


If you'd like to make sure Vulkan isn't used in your project, you can do this:

--------------------------------

### Get native crash stack trace on macOS with lldb

Source: https://github.com/withcatai/node-llama-cpp/blob/master/docs/guide/development.md

Run node with lldb to get a stack trace for crashes in llama.cpp or bindings. After loading, type `run` (or `process launch`) to start.

```shell
lldb node -- ./node_modules/.bin/vite-node ./src/cli/cli.ts chat <path-to-a-model-file-on-your-computer>
```

--------------------------------

### Development > Debugging > Finding Process Crash Stack Trace for Native Code (macOS)

Source: https://github.com/withcatai/node-llama-cpp/blob/master/docs/guide/development.md

To get the stack trace of a crash stemming in `llama.cpp` or the bindings, run `node` with `lldb`:

After it finishes loading, type `run` (or `process launch` if `run` fails) and press Enter for the execution of `node` to start.
When the process crashes, you'll get a stack trace in the terminal.
```
</details>

### Tool Call: `webfetch` (seq `70`, status: `completed`)

**Input:**
```json
{
  "url": "https://raw.githubusercontent.com/withcatai/node-llama-cpp/v3.16.2/src/evaluator/LlamaEmbeddingContext.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
import {AsyncDisposeAggregator, EventRelay, withLock} from "lifecycle-utils";
import {Token} from "../types.js";
import {LlamaText} from "../utils/LlamaText.js";
import {tokenizeInput} from "../utils/tokenizeInput.js";
import {resolveBeginningTokenToPrepend, resolveEndTokenToAppend} from "../utils/tokenizerUtils.js";
import {LlamaEmbedding} from "./LlamaEmbedding.js";
import type {LlamaModel} from "./LlamaModel/LlamaModel.js";
import type {LlamaContext, LlamaContextSequence} from "./LlamaContext/LlamaContext.js";

export type LlamaEmbeddingContextOptions = {
    /**
     * The number of tokens the model can see at once.
     * - **`"auto"`** - adapt to the current VRAM state and attemp to set the context size as high as possible up to the size
     * the model was trained on.
     * - **`number`** - set the context size to a specific number of tokens.
     * If there's not enough VRAM, an error will be thrown.
     * Use with caution.
     * - **`{min?: number, max?: number}`** - adapt to the current VRAM state and attemp to set the context size as high as possible
     * up to the size the model was trained on, but at least `min` and at most `max`.
     *
     * Defaults to `"auto"`.
     */
    contextSize?: "auto" | number | {
        min?: number,
        max?: number
    },

    /** prompt processing batch size */
    batchSize?: number,

    /**
     * number of threads to use to evaluate tokens.
     * set to 0 to use the maximum threads supported by the current machine hardware
     */
    threads?: number,

    /** An abort signal to abort the context creation */
    createSignal?: AbortSignal,

    /**
     * Ignore insufficient memory errors and continue with the context creation.
     * Can cause the process to crash if there's not enough VRAM for the new context.
     *
     * Defaults to `false`.
     */
    ignoreMemorySafetyChecks?: boolean
};

/**
 * @see [Using Embedding](https://node-llama-cpp.withcat.ai/guide/embedding) tutorial

... [省略中间 91 行输出，完整源码与引用契约见仓库及 doc/references/] ...

    }, {
        contextSize,
        batchSize,
        threads = 6,
        createSignal,
        ignoreMemorySafetyChecks
    }: LlamaEmbeddingContextOptions) {
        if (_model.fileInsights.hasEncoder && _model.fileInsights.hasDecoder)
            throw new Error("Computing embeddings is not supported for encoder-decoder models.");

        const llamaContext = await _model.createContext({
            contextSize,
            batchSize,
            threads,
            createSignal,
            ignoreMemorySafetyChecks,
            _embeddings: true
        });

        return new LlamaEmbeddingContext({
            _llamaContext: llamaContext
        });
    }
}

```
</details>

### Assistant Response (seq `95`, id `msg_example_b55c739e7280`, agent: `general`, model: `example-provider/chat-model#default`)

Two important gaps stand out: `searchSessions()` also embeds the entire backlog, so background preemption alone will not make search responsive; and `dispose()` currently closes SQLite while queued or in-flight work can still use it. The Metal stacks identify where execution is blocked, but do not establish the underlying driver/runtime cause.

### Tool Call: `read` (seq `95`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file node_modules/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js, lines 1-96
1: import { AsyncDisposeAggregator, EventRelay, withLock } from "lifecycle-utils";
2: import { tokenizeInput } from "../utils/tokenizeInput.js";
3: import { resolveBeginningTokenToPrepend, resolveEndTokenToAppend } from "../utils/tokenizerUtils.js";
4: import { LlamaEmbedding } from "./LlamaEmbedding.js";
5: /**
6:  * @see [Using Embedding](https://node-llama-cpp.withcat.ai/guide/embedding) tutorial
7:  */
8: export class LlamaEmbeddingContext {
9:     /** @internal */ _llamaContext;
10:     /** @internal */ _sequence;
11:     /** @internal */ _disposeAggregator = new AsyncDisposeAggregator();
12:     onDispose = new EventRelay();
13:     constructor({ _llamaContext }) {
14:         this._llamaContext = _llamaContext;
15:         this._sequence = this._llamaContext.getSequence();
16:         this._disposeAggregator.add(this._llamaContext.onDispose.createListener(() => {
17:             void this._disposeAggregator.dispose();
18:         }));
19:         this._disposeAggregator.add(this.onDispose.dispatchEvent);
20:         this._disposeAggregator.add(async () => {
21:             await this._llamaContext.dispose();
22:         });
23:     }
24:     async getEmbeddingFor(input) {
25:         const resolvedInput = tokenizeInput(input, this._llamaContext.model.tokenizer, undefined, true);
26:         if (resolvedInput.length === 0)
27:             return new LlamaEmbedding({
28:                 vector: []
29:             });
30:         this._prepareInput(resolvedInput);
31:         if (resolvedInput.length >= this._llamaContext.contextSize)
32:             throw new Error("Input is longer than the usable context size. " +
33:                 "Try to increase the context size or use another model that supports longer contexts.");
34:         return await withLock([this, "evaluate"], async () => {
35:             await this._sequence.eraseContextTokenRanges([{
36:                     start: 0,
37:                     end: this._sequence.nextTokenIndex
38:                 }]);
39:             const iterator = this._sequence.evaluate(resolvedInput, { _noSampling: true });
40:             // eslint-disable-next-line @typescript-eslint/no-unused-vars
41:             for await (const token of iterator) {
42:                 break; // only generate one token to get embeddings
43:             }
44:             const embedding = this._llamaContext._ctx.getEmbedding(resolvedInput.length);
45:             const embeddingVector = Array.from(embedding);
46:             return new LlamaEmbedding({
47:                 vector: embeddingVector
48:             });
49:         });

... [省略中间 22 行输出，完整源码与引用契约见仓库及 doc/references/] ...

72:         const beginningToken = resolveBeginningTokenToPrepend(this.model.vocabularyType, this.model.tokens);
73:         if (beginningToken != null && resolvedInput[0] !== beginningToken)
74:             resolvedInput.unshift(beginningToken);
75:         const endToken = resolveEndTokenToAppend(this.model.vocabularyType, this.model.tokens);
76:         if (endToken != null && resolvedInput.at(-1) !== endToken)
77:             resolvedInput.push(endToken);
78:     }
79:     /** @internal */
80:     static async _create({ _model }, { contextSize, batchSize, threads, createSignal, ignoreMemorySafetyChecks }) {
81:         if (_model.fileInsights.hasEncoder && _model.fileInsights.hasDecoder)
82:             throw new Error("Computing embeddings is not supported for encoder-decoder models.");
83:         const llamaContext = await _model.createContext({
84:             contextSize,
85:             batchSize,
86:             threads,
87:             createSignal,
88:             ignoreMemorySafetyChecks,
89:             _embeddings: true
90:         });
91:         return new LlamaEmbeddingContext({
92:             _llamaContext: llamaContext
93:         });
94:     }
95: }
96: //# sourceMappingURL=LlamaEmbeddingContext.js.map
```
</details>

### Tool Call: `read` (seq `95`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist/bindings/getLlama.js",
  "limit": 220
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file node_modules/node-llama-cpp/dist/bindings/getLlama.js, lines 1-220
1: import process from "process";
2: import path from "path";
3: import console from "console";
4: import { createRequire } from "module";
5: import { builtinLlamaCppGitHubRepo, defaultLlamaCppLogLevel, defaultLlamaCppGitHubRepo, defaultLlamaCppGpuSupport, defaultSkipDownload, llamaLocalBuildBinsDirectory, recommendedBaseDockerImage, defaultLlamaCppDebugMode } from "../config.js";
6: import { getConsoleLogPrefix } from "../utils/getConsoleLogPrefix.js";
7: import { waitForLockfileRelease } from "../utils/waitForLockfileRelease.js";
8: import { isGithubReleaseNeedsResolving, resolveGithubRelease } from "../utils/resolveGithubRelease.js";
9: import { runningInsideAsar, runningInElectron } from "../utils/runtime.js";
10: import { compileLlamaCpp, getLocalBuildBinaryBuildMetadata, getLocalBuildBinaryPath, getPrebuiltBinaryBuildMetadata, getPrebuiltBinaryPath } from "./utils/compileLLamaCpp.js";
11: import { getLastBuildInfo } from "./utils/lastBuildInfo.js";
12: import { getClonedLlamaCppRepoReleaseInfo, isLlamaCppRepoCloned } from "./utils/cloneLlamaCppRepo.js";
13: import { getPlatform } from "./utils/getPlatform.js";
14: import { getBuildFolderNameForBuildOptions } from "./utils/getBuildFolderNameForBuildOptions.js";
15: import { resolveCustomCmakeOptions } from "./utils/resolveCustomCmakeOptions.js";
16: import { getCanUsePrebuiltBinaries } from "./utils/getCanUsePrebuiltBinaries.js";
17: import { NoBinaryFoundError } from "./utils/NoBinaryFoundError.js";
18: import { Llama } from "./Llama.js";
19: import { getGpuTypesToUseForOption } from "./utils/getGpuTypesToUseForOption.js";
20: import { getPrettyBuildGpuName } from "./consts.js";
21: import { detectGlibc } from "./utils/detectGlibc.js";
22: import { getLinuxDistroInfo, isDistroAlpineLinux } from "./utils/getLinuxDistroInfo.js";
23: import { testBindingBinary } from "./utils/testBindingBinary.js";
24: import { getPlatformInfo } from "./utils/getPlatformInfo.js";
25: import { hasBuildingFromSourceDependenciesInstalled } from "./utils/hasBuildingFromSourceDependenciesInstalled.js";
26: import { resolveActualBindingBinaryPath } from "./utils/resolveActualBindingBinaryPath.js";
27: import { defaultLlamaCppRelease, builtinLlamaCppRelease } from "./utils/binariesGithubRelease.js";
28: const require = createRequire(import.meta.url);
29: export const getLlamaFunctionName = "getLlama";
30: export const defaultLlamaVramPadding = (totalVram) => Math.floor(Math.min(totalVram * 0.08, 1.6 * Math.pow(1024, 3)));
31: export const defaultLlamaRamPadding = (totalRam) => {
32:     const platform = getPlatform();
33:     if (platform === "linux")
34:         return Math.floor(Math.min(totalRam * 0.25, 1024 * 1024 * 1024));
35:     return Math.floor(Math.min(totalRam * 0.25, 1024 * 1024 * 1024 * 6));
36: };
37: const defaultBuildOption = runningInElectron
38:     ? "never"
39:     : "auto";
40: const defaultTempDir = false;
41: export async function getLlama(options, lastBuildOptions) {
42:     if (options === "lastBuild") {
43:         const lastBuildInfo = await getLastBuildInfo();
44:         const dryRun = lastBuildOptions?.dryRun ?? false;
45:         const getLlamaOptions = {
46:             logLevel: lastBuildOptions?.logLevel ?? defaultLlamaCppLogLevel,
47:             logger: lastBuildOptions?.logger ?? Llama.defaultConsoleLogger,
48:             usePrebuiltBinaries: lastBuildOptions?.usePrebuiltBinaries ?? true,
49:             progressLogs: lastBuildOptions?.progressLogs ?? "stderr",

... [省略中间 147 行输出，完整源码与引用契约见仓库及 doc/references/] ...

197:         }
198:         else
199:             build = "auto";
200:     }
201:     if (build === "auto" || build === "autoAttempt" || build === "never") {
202:         for (let i = 0; i < buildGpusToTry.length; i++) {
203:             const gpu = buildGpusToTry[i];
204:             const isLastItem = i === buildGpusToTry.length - 1;
205:             if (gpu == null)
206:                 continue;
207:             const buildOptions = {
208:                 customCmakeOptions: resolveCustomCmakeOptions(cmakeOptions),
209:                 progressLogs,
210:                 platform,
211:                 platformInfo,
212:                 arch,
213:                 gpu,
214:                 llamaCpp: llamaCppInfo
215:             };
216:             const llama = await loadExistingLlamaBinary({
217:                 buildOptions,
218:                 canUsePrebuiltBinaries,
219:                 logLevel,
220:                 logger,
[Output truncated. Continue reading with offset: 221]
```
</details>

### Tool Call: `grep` (seq `95`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp",
  "pattern": "Bun|bun|version",
  "include": "package.json",
  "limit": 12
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Found 3 matches
node_modules/node-llama-cpp/package.json:
  Line 3:   "version": "3.22.2",

  Line 47:     "postversion": "vite-node scripts/postVersion.ts",


node_modules/node-llama-cpp/llama/package.json:
  Line 3:     "napi_versions": [7]

```
</details>

### Tool Call: `read` (seq `95`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>/packages/core/src/plugin/module.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file <opencode-repo>/packages/core/src/plugin/module.ts, lines 1-193
1: export * as PluginModule from "./module.js"
2: 
3: import type { Plugin } from "@opencode/plugin/effect/plugin"
4: import { Host } from "@opencode/plugin/host"
5: import { GuiBundle } from "@opencode/schema/plugin"
6: import { createPluginSources } from "@opencode/plugin/source"
7: import { Hash } from "@opencode/util/hash"
8: import { Npm } from "@opencode/util/npm"
9: import { Deferred, Effect, FiberSet, PubSub, Schema, Stream } from "effect"
10: import path from "path"
11: import { readFile, stat } from "node:fs/promises"
12: import { fileURLToPath, pathToFileURL } from "url"
13: import type { ConfigPluginSource } from "../config/plugin/source.js"
14: import type { Generation } from "../plugin.js"
15: import { PluginPromise } from "./promise.js"
16: import { Config } from "../config.js"
17: import { ManagedPolicy } from "../managed-policy.js"
18: import { Watcher } from "../filesystem/watcher.js"
19: 
20: export const make = Effect.fn("PluginModule.make")(function* () {
21:   const config = yield* Config.Service
22:   const watcher = yield* Watcher.Service
23:   const scope = yield* Effect.scope
24:   const runPromise = yield* FiberSet.makeRuntimePromise()
25:   const changes = yield* PubSub.unbounded<void>()
26:   const watched = new Set<string>()
27:   const watch = Effect.fn("PluginModule.watch")(function* (file: string) {
28:     if (watched.has(file)) return
29:     watched.add(file)
30:     const ready = yield* Deferred.make<void>()
31:     const target = yield* Effect.promise(() => watchTarget(file))
32:     const updates = yield* watcher.subscribe(target, Deferred.succeed(ready, undefined))
33:     yield* updates.pipe(
34:       Stream.runForEach(() => PubSub.publish(changes, undefined)),
35:       Effect.ensuring(Deferred.succeed(ready, undefined)),
36:       Effect.forkIn(scope, { startImmediately: true }),
37:     )
38:     yield* Deferred.await(ready)
39:   })
40:   const sources = yield* Effect.acquireRelease(
41:     Effect.sync(() => createPluginSources((file) => runPromise(watch(file)))),
42:     (sources) => Effect.sync(() => sources.dispose()),
43:   )
44:   return {
45:     load: (
46:       operation: Extract<ConfigPluginSource.Operation, { type: "add" }>,
47:       options?: { readonly install?: boolean },
48:     ) =>
49:       Effect.gen(function* () {

... [省略中间 119 行输出，完整源码与引用契约见仓库及 doc/references/] ...

169:           ...(installed?.version ? { version: installed.version } : {}),
170:         },
171:     effect: (host) => plugin.effect({ ...host, options: operation.options }),
172:   } satisfies Generation
173: })
174: 
175: const loadServer = Effect.fn("PluginModule.loadServer")(function* (
176:   entrypoint: string,
177:   sources: ReturnType<typeof createPluginSources> | undefined,
178:   revision: string | undefined,
179: ) {
180:   const loaded = yield* Effect.promise(() =>
181:     sources ? sources.read(entrypoint) : Host.load(entrypoint).then((module) => ({ module, version: revision })),
182:   )
183:   const value = (yield* Schema.decodeUnknownEffect(Module)(loaded.module).pipe(
184:     Effect.mapError(
185:       (cause) =>
186:         new LoadError({
187:           message: "Plugin must export a default definition with an id and an effect or setup function.",
188:           cause,
189:         }),
190:     ),
191:   )).default
192:   return { plugin: "effect" in value ? value : PluginPromise.fromPromise(value), version: loaded.version }
193: })
```
</details>

### Tool Call: `read` (seq `95`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>/packages/core/src/config/plugin/source.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file <opencode-repo>/packages/core/src/config/plugin/source.ts, lines 1-199
1: export * as ConfigPluginSource from "./source.js"
2: 
3: import { Directory, Document, type Entry } from "@opencode/schema/config"
4: import { ConfigPlugin } from "@opencode/schema/config/plugin"
5: import { FSUtil } from "@opencode/util/fs-util"
6: import { Host } from "@opencode/plugin/host"
7: import { makeLocationNode } from "@opencode/util/effect/app-node"
8: import { Context, Effect, Layer, Option, PubSub, Scope, Stream } from "effect"
9: import path from "path"
10: import { fileURLToPath, pathToFileURL } from "url"
11: import { Config } from "../../config.js"
12: import { Watcher } from "../../filesystem/watcher.js"
13: import { Location } from "../../location.js"
14: import { PluginSourceDirectory } from "../../plugin/source-directory.js"
15: 
16: export type Operation =
17:   | {
18:       readonly type: "add"
19:       readonly target: string
20:       readonly options: Record<string, unknown>
21:       readonly mtime?: number
22:     }
23:   | {
24:       readonly type: "remove"
25:       readonly target: string
26:     }
27: 
28: export interface Interface {
29:   readonly operations: () => Effect.Effect<readonly Operation[], never, Scope.Scope>
30:   readonly changes: () => Stream.Stream<void>
31: }
32: 
33: export class Service extends Context.Service<Service, Interface>()("@opencode/ConfigPluginSource") {}
34: 
35: export const layer = Layer.effect(
36:   Service,
37:   Effect.gen(function* () {
38:     const config = yield* Config.Service
39:     const watcher = yield* Watcher.Service
40:     const fs = yield* FSUtil.Service
41:     const location = yield* Location.Service
42:     const configuredChanges = yield* PubSub.unbounded<void>()
43:     const watched = new Set<string>()
44: 
45:     // Configured local plugins can live outside config roots, where the
46:     // config change feed cannot see them; watch those targets directly.
47:     // Watches start on first sighting and are never torn down individually:
48:     // a stale watch after a config edit costs one deduped fs handle and a
49:     // no-op activation, and every watch dies with this layer's scope.

... [省略中间 125 行输出，完整源码与引用契约见仓库及 doc/references/] ...

175:       const times = yield* Effect.forEach(
176:         [
177:           ...Object.values(entrypoints)
178:             .filter((entry) => entry !== undefined)
179:             .map((entry) => fileURLToPath(entry)),
180:           path.join(directory ? operation.target : path.dirname(operation.target), "package.json"),
181:         ],
182:         (entry) =>
183:           fs.stat(entry).pipe(
184:             Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
185:             Effect.orElseSucceed(() => 0),
186:           ),
187:       )
188:       return [{ ...operation, mtime: Math.max(...times) }]
189:     }),
190:   ).pipe(Effect.map((operations) => operations.flat()))
191: })
192: 
193: function isPluginSource(entries: readonly Entry[], file: string) {
194:   return entries.some(
195:     (entry) =>
196:       entry.type === "directory" &&
197:       PluginSourceDirectory.names.some((directory) => FSUtil.contains(path.join(entry.path, directory), file)),
198:   )
199: }
```
</details>

### Tool Call: `webfetch` (seq `95`, status: `error`)

**Input:**
```json
{
  "url": "https://node-llama-cpp.withcat.ai/guide/Bun"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
{
  "type": "unknown",
  "message": "StatusCode: non 2xx status code (404 GET https://node-llama-cpp.withcat.ai/guide/Bun)"
}
```
</details>

### Tool Call: `read` (seq `126`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>/packages/plugin/src/source.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file <opencode-repo>/packages/plugin/src/source.ts, lines 1-66
1: import { readFileSync, readdirSync } from "node:fs"
2: import { fileURLToPath, pathToFileURL } from "node:url"
3: import path from "node:path"
4: import { Hash } from "@opencode/util/hash"
5: 
6: // Keep source fingerprints and import attempts together. Filesystem events
7: // should reload changed local graphs, not repeat unchanged evaluations.
8: export function createPluginSources(watch: (file: string) => Promise<void>) {
9:   const sources = new Map<string, Source>()
10:   const cleanups: Array<() => void> = []
11:   const watching = new Set<Promise<void>>()
12:   return {
13:     read: async (entrypoint: string) => {
14:       await Promise.all(watching)
15:       const previous = sources.get(entrypoint)
16:       if (previous && [...previous.files].every(([file, item]) => item.digest === digest(file, item.directory)))
17:         return previous.loaded
18: 
19:       const files: Source["files"] = new Map()
20:       const track = (file: string, directory = false) => {
21:         if (files.has(file)) return
22:         files.set(file, { digest: digest(file, directory), directory })
23:         const pending = watch(file).finally(() => watching.delete(pending))
24:         watching.add(pending)
25:         // Watch setup can be interrupted while module evaluation is still pending.
26:         void pending.catch(() => {})
27:       }
28:       track(fileURLToPath(entrypoint))
29:       const { prepareSource } = await import("#plugin-source")
30:       const prepared: { version: string; load: () => Promise<unknown>; dispose?: () => void } = await prepareSource(
31:         entrypoint,
32:         track,
33:       )
34:       if (prepared.dispose) cleanups.push(prepared.dispose)
35:       // Cache the attempt before evaluating it: unchanged failing modules must
36:       // not repeat import-time effects on every filesystem notification.
37:       const loaded = prepared.load().then((module) => ({ version: prepared.version, module }))
38:       sources.set(entrypoint, { loaded, files })
39:       return loaded.finally(() => Promise.all(watching))
40:     },
41:     dispose: () => {
42:       for (const cleanup of cleanups.splice(0)) cleanup()
43:       sources.clear()
44:     },
45:   }
46: }
47: 
48: type Source = {
49:   loaded: Promise<{ version: string; module: unknown }>
50:   files: Map<string, { digest: string; directory: boolean }>
51: }
52: 
53: function digest(file: string, directory: boolean) {
54:   try {
55:     return Hash.sha256(directory ? JSON.stringify(readdirSync(file).sort()) : readFileSync(file))
56:   } catch {
57:     return "missing"
58:   }
59: }
60: 
61: export function localSource(spec: string, directory: string) {
62:   if (spec.startsWith("file://")) return new URL(spec)
63:   if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec))
64:     return pathToFileURL(path.resolve(directory, spec))
65:   return undefined
66: }
```
</details>

### Tool Call: `websearch` (seq `126`, status: `completed`)

**Input:**
```json
{
  "query": "site.node-llama-cpp.withcat.ai Bun node-llama-cpp support"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
## [Releases · withcatai/node-llama-cpp · GitHub](https://github.com/withcatai/node-llama-cpp/releases)

Verified

Learn about vigilant mode.

## 3.18.1 (2026-03-17)

### Features

 customize `postinstall` behavior (#582) (57bea3d) (documentation: Customizing `postinstall` Behavior)
 experimental support for context KV cache type configurations (#582) (57bea3d) (documentation: [`LlamaContextOptions["experimentalKvCacheKeyType"]`](
 support `NVFP4` quants (#582) (57bea3d)

Shipped with `llama.cpp` release `b8390` [...] # 3.20.0 (2026-08-11)

### Features

 Muse Glimmer support (#639) (adb92f2)
 improve thought segments syntax extraction (#636) (3f686d7)
 expose download speed and ETA for a model downloader (#636) (3f686d7)
 expose the model's architecture directly on the model instance (#636) (3f686d7)
 `inspect gpu` command: print model parameters count (#639) (adb92f2)

### Bug Fixes [...] # 3.18.0 (2026-03-15)

### Features

 automatic checkpoints for models that need it (#573) (c641959)
 `QwenChatWrapper`: Qwen 3.5 support (#573) (c641959)
 `inspect gpu` command: detect and report missing prebuilt binary modules and custom npm registry (#573) (c641959)

### Bug Fixes

## [node-llama-cpp | Run AI models locally on your machine](https://node-llama-cpp.withcat.ai)

Skip to content

Structured Decisions with any model

# node-llama-cppRun AI models locally on your machine

node.js bindings for llama.cpp, and much more

Get Started

API Reference

Structured Decisions with any model


... [省略中间 365 行输出，完整源码与引用契约见仓库及 doc/references/] ...

npm

Sign UpSign In

# @node-llama-cpp/win-x64

3.22.2 • Public • Published

 Readme
 Code Beta
 0 Dependencies
 0 Dependents
 54 Versions

# `node-llama-cpp`

This is a prebuilt binary package for `node-llama-cpp` for Windows x64.

Do not install this package directly.

## Readme

### Keywords

none
```
</details>

### Tool Call: `websearch` (seq `126`, status: `completed`)

**Input:**
```json
{
  "query": "site:github.com/withcatai/node-llama-cpp Bun Metal hang deadlock"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
## [Metal: embed() hangs sporadically on Apple M5 Max (~10- ...](https://github.com/withcatai/node-llama-cpp/issues/595)

Apr 13, 2026 — Bug embed() hangs sporadically on Apple M5 Max with Metal backend. Expect 1-3 hangs per 10 runs. embed() calls guarantee deadlock (separate

## [Issues · withcatai/node-llama-cpp · GitHub](https://github.com/withcatai/node-llama-cpp/issues)

Bug

  withcatai/node-llama-cpp#599 · opened on Apr 25, 2026

  1
 ### Metal: embed() hangs sporadically on Apple M5 Max (~10-30% of calls)

  withcatai/node-llama-cpp#595 · opened on Apr 14, 2026

  4
 ### Segmentation fault during embedBatch on ARM64 Linux (aarch64)

  withcatai/node-llama-cpp#590 · opened on Apr 3, 2026

  3
 ### feat: function calling across models

  Feature

  withcatai/node-llama-cpp#589 · opened on Apr 2, 2026 [...] withcatai/node-llama-cpp#638 · opened on Aug 7, 2026

  1
 ### bug: gemma4 infinitely repeating a token randomly...

  Bug

  withcatai/node-llama-cpp#627 · opened on Jul 7, 2026

  4
 ### Gemma wrapper silently drops systemPrompt — system instructions never reach the model

  withcatai/node-llama-cpp#624 · opened on Jul 2, 2026

  2
 ### bug: loadBackends(backendsPath) skipped when buildGpu === false, silently drops custom GPU backends compiled via NODE\_LLAMA\_CPP\_CMAKE\_OPTION\_\

  Bug [...] withcatai/node-llama-cpp#652 · opened on Sep 18, 2026
 ### Add a linux-arm64-cuda prebuilt (NVIDIA Grace-class: DGX Spark GB10, GH200, Jetson Thor)

  withcatai/node-llama-cpp#651 · opened on Sep 18, 2026

  5
 ### feat: MTP support


... [省略中间 159 行输出，完整源码与引用契约见仓库及 doc/references/] ...

   @eugeniosegala

   eugeniosegala

   on Dec 6, 2024

   Author

   More actions

   Exact same logic in Python:

## [feat: React Native support · Issue #287 · withcatai/node-llama-cpp · GitHub](https://github.com/withcatai/node-llama-cpp/issues/287)

More actions

   The focus of this library is mainly on running on node and node-based environments (like Electron, Bun, etc.), but I don't rule out supporting React-native if it doesn't require significant changes and is not a great maintenance burden.  
    I haven't used React native for a long time now, so I'm not proficient with its latest features, but from what I've seen, it doesn't use a node runtime and instead has its own kind of runtime that's implemented differently. [...] On Android it gives error: `The package at "node_modules/node-llama-cpp/dist/evaluator/LlamaModel/LlamaModel.js" attempted to import the Node standard library module "process". It failed because the native React runtime does not include the Node standard library.`

On React Native web (using expo) it gives the following error  
 `The resource from “ was blocked due to MIME type (“application/json”) mismatch`  
 which comes from a >

### The Solution [...] If the `process` module is the only remaining obstacle, I can refactor the code to use a custom implementation that uses a different abstraction layer when running in React native, but I think the usage of `node-addon-api` is the main issue.
3. ### raymon-iocommentedon Aug 4, 2024
```
</details>

### Tool Call: `read` (seq `126`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist/utils/tokenizeInput.js"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file node_modules/node-llama-cpp/dist/utils/tokenizeInput.js, lines 1-14
1: import { isLlamaText } from "./LlamaText.js";
2: import { isToken } from "./isToken.js";
3: export function tokenizeInput(input, tokenizer, options, clone = false) {
4:     if (typeof input === "string")
5:         return tokenizer(input, false, options);
6:     else if (isLlamaText(input))
7:         return input.tokenize(tokenizer, options);
8:     else if (isToken(input))
9:         return [input];
10:     if (clone)
11:         return input.slice();
12:     return input;
13: }
14: //# sourceMappingURL=tokenizeInput.js.map
```
</details>

### Tool Call: `grep` (seq `126`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist",
  "pattern": "batchSize.*\\?\\?|batchSize =|contextSize.*4096",
  "include": "LlamaContext.js",
  "limit": 20
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Found 2 matches
node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js:
  Line 152:         this._batchSize = Math.max(batchSize, this._totalSequences);

  Line 741:             const batchSize = options.batchSize ?? getDefaultContextBatchSize({ contextSize, sequences });

```
</details>

### Tool Call: `execute` (seq `126`, status: `completed`)

**Input:**
```json
{
  "code": "return await tools.context7[\"resolve-library-id\"]({libraryName:\"SQLite\",query:\"PRAGMA busy_timeout BEGIN IMMEDIATE WAL writers synchronous connection attached read only\"})"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Available Libraries:

- Title: SQLite
- Context7-compatible library ID: /websites/sqlite_docs
- Description: SQLite is a small, fast, and reliable SQL database engine. It's a self-contained, serverless, zero-configuration, transactional SQL database, widely used for embedded applications.
- Code Snippets: 9384
- Source Reputation: High
- Benchmark Score: 75.9
----------
- Title: SQLite
- Context7-compatible library ID: /sqlite/sqlite
- Description: SQLite is a C-language library that provides a lightweight, self-contained, serverless, transactional, and fully featured SQL database engine.
- Code Snippets: 1375
- Source Reputation: Low
- Benchmark Score: 61.95
- Versions: version-3.53.1
----------
- Title: Modernc SQLite
- Context7-compatible library ID: /gitlab_cznic/sqlite
- Description: A pure Go implementation of SQLite that provides database/sql driver compatibility and high-performance SQLite support for Go applications.
- Code Snippets: 4486
- Source Reputation: High
- Benchmark Score: 82.15
----------
- Title: SQLite Wasm
- Context7-compatible library ID: /sqlite/sqlite-wasm
- Description: SQLite Wasm is conveniently wrapped as an ES Module, offering multiple usage patterns and support for the Origin Private File System (OPFS).
- Code Snippets: 489
- Source Reputation: Medium
- Benchmark Score: 75.47
----------
- Title: SQLite-net
- Context7-compatible library ID: /praeclarum/sqlite-net
- Description: SQLite-net is a minimal, open-source .NET library that enables .NET, .NET Core, and Mono applications to efficiently store and manage data within SQLite 3 databases across various platforms.
- Code Snippets: 596
- Source Reputation: High
- Benchmark Score: 65.43
```
</details>

### Tool Call: `glob` (seq `155`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>/packages/plugin/src",
  "pattern": "*source*"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
<opencode-repo>/packages/plugin/src/source.node.ts
<opencode-repo>/packages/plugin/src/source.package.ts
<opencode-repo>/packages/plugin/src/source.bun.ts
<opencode-repo>/packages/plugin/src/source.ts
```
</details>

### Tool Call: `webfetch` (seq `155`, status: `completed`)

**Input:**
```json
{
  "url": "https://api.github.com/repos/withcatai/node-llama-cpp/issues/595",
  "format": "text"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595","repository_url":"https://api.github.com/repos/withcatai/node-llama-cpp","labels_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595/labels{/name}","comments_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595/comments","events_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595/events","html_url":"https://github.com/withcatai/node-llama-cpp/issues/595","id":4259482273,"node_id":"I_kwDOKGciF8794oqh","number":595,"title":"Metal: embed() hangs sporadically on Apple M5 Max (~10-30% of calls)","user":{"login":"jowitte","id":8180200,"node_id":"MDQ6VXNlcjgxODAyMDA=","avatar_url":"https://avatars.githubusercontent.com/u/8180200?v=4","gravatar_id":"","url":"https://api.github.com/users/jowitte","html_url":"https://github.com/jowitte","followers_url":"https://api.github.com/users/jowitte/followers","following_url":"https://api.github.com/users/jowitte/following{/other_user}","gists_url":"https://api.github.com/users/jowitte/gists{/gist_id}","starred_url":"https://api.github.com/users/jowitte/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/jowitte/subscriptions","organizations_url":"https://api.github.com/users/jowitte/orgs","repos_url":"https://api.github.com/users/jowitte/repos","events_url":"https://api.github.com/users/jowitte/events{/privacy}","received_events_url":"https://api.github.com/users/jowitte/received_events","type":"User","user_view_type":"public","site_admin":false},"labels":[],"state":"open","locked":false,"assignees":[],"milestone":null,"comments":4,"created_at":"2026-04-14T04:24:52Z","updated_at":"2026-09-14T10:25:51Z","closed_at":null,"assignee":null,"author_association":"NONE","issue_field_values":[],"type":null,"active_lock_reason":null,"sub_issues_summary":{"total":0,"completed":0,"percent_completed":0},"issue_dependencies_summary":{"blocked_by":0,"total_blocked_by":0,"blocking":0,"total_blocking":0},"body":"## Bug\n\n`embed()` hangs sporadically on Apple M5 Max with Metal backend. The same query succeeds in ~0.7s on one call and hangs indefinitely (99% CPU on one core) on the next. The behavior is **not query-dependent** — identical inputs produce different outcomes. CPU-only mode (`gpu: false`) is 100% stable but ~50x slower.\n\n## Reproduction\n\nMinimal test: run the same embedding call 10 times sequentially. Expect 1-3 hangs per 10 runs.\n\n```js\nimport { getLlama } from \"node-llama-cpp\";\n\nconst llama = await getLlama(); // Metal auto-detected\nconst model = await llama.loadModel({\n  modelPath: \"nomic-embed-text-v2-moe.Q8_0.gguf\"  // 488 MB MoE embedding model\n});\nconst ctx = await model.createEmbeddingContext();\n\nfor (let i = 0; i < 10; i++) {\n  console.time(`run ${i}`);\n  const vec = await ctx.getEmbeddingFor(\"test query about delegation\");\n  console.timeEnd(`run ${i}`);  // ~0.7s when it works, never completes when it hangs\n}\n```\n\nIn practice, observed via [qmd](https://github.com/tobi/qmd) CLI which calls `embed()` for vector search:\n\n```bash\n# Run 10 sequential vsearch calls, 8s timeout each:\nexport GGML_METAL_NO_RESIDENCY=1\nfor i in $(seq 1 10); do\n  bun dist/cli/qmd.js vsearch \"Delegieren\" -n 3 &\n  pid=$!; sleep 8\n  kill -0 $pid 2>/dev/null && { kill $pid; echo \"Run $i: HANG\"; } || echo \"Run $i: OK\"\ndone\n\n# Typical result: 9 OK, 1 HANG (without GGML_METAL_NO_RESIDENCY: 5-7 OK, 3-5 HANG)\n```\n\n## Workaround\n\n`GGML_METAL_NO_RESIDENCY=1` reduces hang rate from ~30-50% to ~10% but does not eliminate it. This env var disables Metal residency sets for buffer allocation (related to llama.cpp autorelease/buffer management, see ggml-org/llama.cpp#18568).\n\n## What doesn't help\n\n- **Upgrading llama.cpp**: Rebuilt with b8783 (from b8390 in 3.18.1) — hang rate actually *increased* to ~40%\n- **`GGML_METAL_TENSOR_DISABLE=1`**: No improvement, possibly worse\n- **Both flags combined**: Worse than `GGML_METAL_NO_RESIDENCY` alone\n- **AbortSignal**: `signal` parameter on `prompt()` is not respected during native Metal compute — the call blocks the event loop\n\n## Observations\n\n- The hang occurs in the native Metal compute pipeline, not in JS\n- Process shows 99-100% CPU on one core during hang\n- No crash, no error, no output — just infinite computation\n- The model (nomic-embed-text-v2-moe) is a Mixture-of-Experts architecture — MoE routing may trigger different Metal kernel paths\n- First call after process start seems slightly more likely to hang (cold start)\n- Concurrent `embed()` calls guarantee deadlock (separate known issue)\n\n## Related issues\n\n- #552 — Similar hang on M4, fixed by rebuild (different root cause — prebuilt binary mismatch)\n- ggml-org/llama.cpp#18568 — SIGBUS after many embeddings on Metal (autorelease/residency)\n- ollama/ollama#13867 — M5-specific Metal4 shader regression\n\n## Environment\n\n- **node-llama-cpp**: 3.18.1\n- **llama.cpp**: b8390 (prebuilt)\n- **Hardware**: Apple M5 Max, 128 GB RAM\n- **OS**: macOS 26.4.1 (Tahoe)\n- **Runtime**: Bun 1.3.12 (also tested with Node 25.9.0 — same behavior)\n- **Model**: nomic-embed-text-v2-moe Q8_0 (488 MB, 768 dimensions, MoE)","closed_by":null,"reactions":{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595/reactions","total_count":0,"+1":0,"-1":0,"laugh":0,"hooray":0,"confused":0,"heart":0,"rocket":0,"eyes":0},"timeline_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595/timeline","performed_via_github_app":null,"state_reason":null,"pinned_comment":null}
```
</details>

### Tool Call: `webfetch` (seq `155`, status: `completed`)

**Input:**
```json
{
  "url": "https://api.github.com/repos/withcatai/node-llama-cpp/issues/595/comments",
  "format": "text"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
[{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/4718408775","html_url":"https://github.com/withcatai/node-llama-cpp/issues/595#issuecomment-4718408775","issue_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595","id":4718408775,"node_id":"IC_kwDOKGciF88AAAABGT00Rw","user":{"login":"LeoLin990405","id":101193087,"node_id":"U_kgDOBggVfw","avatar_url":"https://avatars.githubusercontent.com/u/101193087?v=4","gravatar_id":"","url":"https://api.github.com/users/LeoLin990405","html_url":"https://github.com/LeoLin990405","followers_url":"https://api.github.com/users/LeoLin990405/followers","following_url":"https://api.github.com/users/LeoLin990405/following{/other_user}","gists_url":"https://api.github.com/users/LeoLin990405/gists{/gist_id}","starred_url":"https://api.github.com/users/LeoLin990405/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/LeoLin990405/subscriptions","organizations_url":"https://api.github.com/users/LeoLin990405/orgs","repos_url":"https://api.github.com/users/LeoLin990405/repos","events_url":"https://api.github.com/users/LeoLin990405/events{/privacy}","received_events_url":"https://api.github.com/users/LeoLin990405/received_events","type":"User","user_view_type":"public","site_admin":false},"created_at":"2026-06-16T11:50:46Z","updated_at":"2026-06-16T11:50:46Z","body":"**Confirming on M5 Max — plus a worse failure mode and a dead-end on the upgrade path**\n\nSame setup here: Apple **M5 Max (Mac17,7), macOS 26.4**, node-llama-cpp **3.18.1** (bundled llama.cpp **b8390**), Qwen3-Embedding-0.6B, observed via [qmd](https://github.com/tobi/qmd). Most `embed()` calls under sustained load hang exactly as you describe (one core pegged, never completes, `gpu: false` is 100% stable but ~50x slower).\n\n**One data point worse than the hang:** on this machine a subset of embedding runs don't just hang — the Metal path takes the **whole box down with a watchdog hard reset (no kernel panic log written)**. AC power, zero thermal warnings, so it's neither a power nor a thermal event. A hang you can `Ctrl-C`; a hard reset you can't, and it can lose unsaved work elsewhere. The smoking gun in the embed log right before it goes down:\n\n    ggml_metal_library_init_from_source: error compiling source\n\ni.e. the root cause looks like the **ggml-metal shader JIT failing to compile on brand-new M5 silicon**, after which the GPU path is left in a bad state and sustained compute load hangs the GPU / trips the SoC watchdog. This is upstream in llama.cpp's Metal backend, not in the binding — closely related to ggml-org/llama.cpp#18568 (Metal + embedding crashes on Apple Silicon, confirmed across independent bindings → in llama.cpp's Metal impl).\n\n**Extending your \"upgrading llama.cpp doesn't help\" section** — the upgrade path is currently a hard dead-end from the node side:\n\n- 3.18.1 pins llama.cpp **b8390** (the crashing version). Local rebuild of b8390 (`source download --gpu metal`) → same Metal compile error.\n- You hit b8783 → hang rate *up* to ~40%. I went further and tried the current **b9663** (M5-era): the **addon fails to compile** against 3.18.1's bindings — `error: use of undeclared identifier 'cpu_get_num_math'` (removed in newer llama.cpp) plus a `std::atomic_bool` deleted-ctor error. So 3.18.1's C++ bindings no longer match the newer llama.cpp API.\n\n**Net:** the GPU/Metal path on M5 can't be fixed locally by bumping llama.cpp — it needs a node-llama-cpp release that ships a **newer llama.cpp *with matching bindings*** (and ideally only once the upstream M5 ggml-metal shader-compile issue is resolved). Until then, CPU-only is the only safe path on M5 — and worth flagging in docs, since the GPU default can hard-reset the machine, not just hang.\n","author_association":"NONE","pin":null,"reactions":{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/4718408775/reactions","total_count":0,"+1":0,"-1":0,"laugh":0,"hooray":0,"confused":0,"heart":0,"rocket":0,"eyes":0},"performed_via_github_app":null,"minimized":null},{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/4718470143","html_url":"https://github.com/withcatai/node-llama-cpp/issues/595#issuecomment-4718470143","issue_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595","id":4718470143,"node_id":"IC_kwDOKGciF88AAAABGT4j_w","user":{"login":"LeoLin990405","id":101193087,"node_id":"U_kgDOBggVfw","avatar_url":"https://avatars.githubusercontent.com/u/101193087?v=4","gravatar_id":"","url":"https://api.github.com/users/LeoLin990405","html_url":"https://github.com/LeoLin990405","followers_url":"https://api.github.com/users/LeoLin990405/followers","following_url":"https://api.github.com/users/LeoLin990405/following{/other_user}","gists_url":"https://api.github.com/users/LeoLin990405/gists{/gist_id}","starred_url":"https://api.github.com/users/LeoLin990405/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/LeoLin990405/subscriptions","organizations_url":"https://api.github.com/users/LeoLin990405/orgs","repos_url":"https://api.github.com/users/LeoLin990405/repos","events_url":"https://api.github.com/users/LeoLin990405/events{/privacy}","received_events_url":"https://api.github.com/users/LeoLin990405/received_events","type":"User","user_view_type":"public","site_admin":false},"created_at":"2026-06-16T11:58:46Z","updated_at":"2026-06-16T11:58:46Z","body":"**Follow-up / correction on the binding-compat point**\n\nUpdating my note above so it's accurate: the `cpu_get_num_math` build break I hit against newer llama.cpp is already addressed on `main` — #603 (`cpu_get_num_math` → `common_cpu_get_num_math`) and #597 (build compatibility with llama.cpp b8390+), both merged 2026-05-24. So the bindings *do* track the newer llama.cpp API now; it's just that the latest published release is still v3.18.1 (2026-03-17, pinned to b8390), so none of that has reached installed users yet.\n\nThat leaves the actual M5 hang/hard-reset squarely upstream in llama.cpp's ggml-metal (shader JIT on M5), which a llama.cpp bump alone may not fix — you saw b8783 make the hang *worse*.\n\nGiven that, would you be open to a small **defensive guard at the binding layer**: when the Metal library/shader init fails (`ggml_metal_library_init_from_source: error compiling source`), fail fast with a typed error or auto-fall back to CPU, instead of silently proceeding into an unstable GPU state? On M5 that bad state can take the whole machine down (watchdog hard reset, no panic log), so failing fast there is strictly safer than hanging. Happy to send a PR if the approach sounds right *and* if that native init failure is observable from the binding side — wanted to check direction before writing anything.\n","author_association":"NONE","pin":null,"reactions":{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/4718470143/reactions","total_count":0,"+1":0,"-1":0,"laugh":0,"hooray":0,"confused":0,"heart":0,"rocket":0,"eyes":0},"performed_via_github_app":null,"minimized":null},{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/5654544885","html_url":"https://github.com/withcatai/node-llama-cpp/issues/595#issuecomment-5654544885","issue_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595","id":5654544885,"node_id":"IC_kwDOKGciF88AAAABUQmB9Q","user":{"login":"giladgd","id":7817232,"node_id":"MDQ6VXNlcjc4MTcyMzI=","avatar_url":"https://avatars.githubusercontent.com/u/7817232?v=4","gravatar_id":"","url":"https://api.github.com/users/giladgd","html_url":"https://github.com/giladgd","followers_url":"https://api.github.com/users/giladgd/followers","following_url":"https://api.github.com/users/giladgd/following{/other_user}","gists_url":"https://api.github.com/users/giladgd/gists{/gist_id}","starred_url":"https://api.github.com/users/giladgd/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/giladgd/subscriptions","organizations_url":"https://api.github.com/users/giladgd/orgs","repos_url":"https://api.github.com/users/giladgd/repos","events_url":"https://api.github.com/users/giladgd/events{/privacy}","received_events_url":"https://api.github.com/users/giladgd/received_events","type":"User","user_view_type":"public","site_admin":false},"created_at":"2026-09-13T16:30:53Z","updated_at":"2026-09-13T16:31:04Z","body":"I couldn't reproduce this issue on my machine, but in #645 I also fixed some rare edge cases that I suspect could have caused this issue.\nCould you please try again with `node-llama-cpp` version `3.21.1` and let me know whether it fixed the issue for you?","author_association":"MEMBER","pin":null,"reactions":{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/5654544885/reactions","total_count":0,"+1":0,"-1":0,"laugh":0,"hooray":0,"confused":0,"heart":0,"rocket":0,"eyes":0},"performed_via_github_app":null,"minimized":null},{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/5662529716","html_url":"https://github.com/withcatai/node-llama-cpp/issues/595#issuecomment-5662529716","issue_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595","id":5662529716,"node_id":"IC_kwDOKGciF88AAAABUYNYtA","user":{"login":"jowitte","id":8180200,"node_id":"MDQ6VXNlcjgxODAyMDA=","avatar_url":"https://avatars.githubusercontent.com/u/8180200?v=4","gravatar_id":"","url":"https://api.github.com/users/jowitte","html_url":"https://github.com/jowitte","followers_url":"https://api.github.com/users/jowitte/followers","following_url":"https://api.github.com/users/jowitte/following{/other_user}","gists_url":"https://api.github.com/users/jowitte/gists{/gist_id}","starred_url":"https://api.github.com/users/jowitte/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/jowitte/subscriptions","organizations_url":"https://api.github.com/users/jowitte/orgs","repos_url":"https://api.github.com/users/jowitte/repos","events_url":"https://api.github.com/users/jowitte/events{/privacy}","received_events_url":"https://api.github.com/users/jowitte/received_events","type":"User","user_view_type":"public","site_admin":false},"created_at":"2026-09-14T10:25:51Z","updated_at":"2026-09-14T10:25:51Z","body":"Thanks! I re-tested on the same machine (M5 Max, now macOS 26.6.2, Node 26.8.2) with nomic-embed-text-v2-moe and embeddinggemma-300M: 3.21.1, 3.20.0 and also the originally reported 3.18.1 all ran without a single hang: 25–65 cold-start runs plus 2,000 sequential embeddings in one process per version, with and without `GGML_METAL_NO_RESIDENCY`.\n\nSince 3.18.1 no longer reproduces either, I can't attribute the fix to 3.21.1. It most likely went away with a macOS update (26.4.1 → 26.6.2) or with installing full Xcode in the meantime. Fine to close from my side; I'll reopen if it shows up again.\n","author_association":"NONE","pin":null,"reactions":{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/5662529716/reactions","total_count":0,"+1":0,"-1":0,"laugh":0,"hooray":0,"confused":0,"heart":0,"rocket":0,"eyes":0},"performed_via_github_app":null,"minimized":null}]

... [省略中间 -74 行输出，完整源码与引用契约见仓库及 doc/references/] ...

[{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/4718408775","html_url":"https://github.com/withcatai/node-llama-cpp/issues/595#issuecomment-4718408775","issue_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595","id":4718408775,"node_id":"IC_kwDOKGciF88AAAABGT00Rw","user":{"login":"LeoLin990405","id":101193087,"node_id":"U_kgDOBggVfw","avatar_url":"https://avatars.githubusercontent.com/u/101193087?v=4","gravatar_id":"","url":"https://api.github.com/users/LeoLin990405","html_url":"https://github.com/LeoLin990405","followers_url":"https://api.github.com/users/LeoLin990405/followers","following_url":"https://api.github.com/users/LeoLin990405/following{/other_user}","gists_url":"https://api.github.com/users/LeoLin990405/gists{/gist_id}","starred_url":"https://api.github.com/users/LeoLin990405/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/LeoLin990405/subscriptions","organizations_url":"https://api.github.com/users/LeoLin990405/orgs","repos_url":"https://api.github.com/users/LeoLin990405/repos","events_url":"https://api.github.com/users/LeoLin990405/events{/privacy}","received_events_url":"https://api.github.com/users/LeoLin990405/received_events","type":"User","user_view_type":"public","site_admin":false},"created_at":"2026-06-16T11:50:46Z","updated_at":"2026-06-16T11:50:46Z","body":"**Confirming on M5 Max — plus a worse failure mode and a dead-end on the upgrade path**\n\nSame setup here: Apple **M5 Max (Mac17,7), macOS 26.4**, node-llama-cpp **3.18.1** (bundled llama.cpp **b8390**), Qwen3-Embedding-0.6B, observed via [qmd](https://github.com/tobi/qmd). Most `embed()` calls under sustained load hang exactly as you describe (one core pegged, never completes, `gpu: false` is 100% stable but ~50x slower).\n\n**One data point worse than the hang:** on this machine a subset of embedding runs don't just hang — the Metal path takes the **whole box down with a watchdog hard reset (no kernel panic log written)**. AC power, zero thermal warnings, so it's neither a power nor a thermal event. A hang you can `Ctrl-C`; a hard reset you can't, and it can lose unsaved work elsewhere. The smoking gun in the embed log right before it goes down:\n\n    ggml_metal_library_init_from_source: error compiling source\n\ni.e. the root cause looks like the **ggml-metal shader JIT failing to compile on brand-new M5 silicon**, after which the GPU path is left in a bad state and sustained compute load hangs the GPU / trips the SoC watchdog. This is upstream in llama.cpp's Metal backend, not in the binding — closely related to ggml-org/llama.cpp#18568 (Metal + embedding crashes on Apple Silicon, confirmed across independent bindings → in llama.cpp's Metal impl).\n\n**Extending your \"upgrading llama.cpp doesn't help\" section** — the upgrade path is currently a hard dead-end from the node side:\n\n- 3.18.1 pins llama.cpp **b8390** (the crashing version). Local rebuild of b8390 (`source download --gpu metal`) → same Metal compile error.\n- You hit b8783 → hang rate *up* to ~40%. I went further and tried the current **b9663** (M5-era): the **addon fails to compile** against 3.18.1's bindings — `error: use of undeclared identifier 'cpu_get_num_math'` (removed in newer llama.cpp) plus a `std::atomic_bool` deleted-ctor error. So 3.18.1's C++ bindings no longer match the newer llama.cpp API.\n\n**Net:** the GPU/Metal path on M5 can't be fixed locally by bumping llama.cpp — it needs a node-llama-cpp release that ships a **newer llama.cpp *with matching bindings*** (and ideally only once the upstream M5 ggml-metal shader-compile issue is resolved). Until then, CPU-only is the only safe path on M5 — and worth flagging in docs, since the GPU default can hard-reset the machine, not just hang.\n","author_association":"NONE","pin":null,"reactions":{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/4718408775/reactions","total_count":0,"+1":0,"-1":0,"laugh":0,"hooray":0,"confused":0,"heart":0,"rocket":0,"eyes":0},"performed_via_github_app":null,"minimized":null},{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/4718470143","html_url":"https://github.com/withcatai/node-llama-cpp/issues/595#issuecomment-4718470143","issue_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595","id":4718470143,"node_id":"IC_kwDOKGciF88AAAABGT4j_w","user":{"login":"LeoLin990405","id":101193087,"node_id":"U_kgDOBggVfw","avatar_url":"https://avatars.githubusercontent.com/u/101193087?v=4","gravatar_id":"","url":"https://api.github.com/users/LeoLin990405","html_url":"https://github.com/LeoLin990405","followers_url":"https://api.github.com/users/LeoLin990405/followers","following_url":"https://api.github.com/users/LeoLin990405/following{/other_user}","gists_url":"https://api.github.com/users/LeoLin990405/gists{/gist_id}","starred_url":"https://api.github.com/users/LeoLin990405/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/LeoLin990405/subscriptions","organizations_url":"https://api.github.com/users/LeoLin990405/orgs","repos_url":"https://api.github.com/users/LeoLin990405/repos","events_url":"https://api.github.com/users/LeoLin990405/events{/privacy}","received_events_url":"https://api.github.com/users/LeoLin990405/received_events","type":"User","user_view_type":"public","site_admin":false},"created_at":"2026-06-16T11:58:46Z","updated_at":"2026-06-16T11:58:46Z","body":"**Follow-up / correction on the binding-compat point**\n\nUpdating my note above so it's accurate: the `cpu_get_num_math` build break I hit against newer llama.cpp is already addressed on `main` — #603 (`cpu_get_num_math` → `common_cpu_get_num_math`) and #597 (build compatibility with llama.cpp b8390+), both merged 2026-05-24. So the bindings *do* track the newer llama.cpp API now; it's just that the latest published release is still v3.18.1 (2026-03-17, pinned to b8390), so none of that has reached installed users yet.\n\nThat leaves the actual M5 hang/hard-reset squarely upstream in llama.cpp's ggml-metal (shader JIT on M5), which a llama.cpp bump alone may not fix — you saw b8783 make the hang *worse*.\n\nGiven that, would you be open to a small **defensive guard at the binding layer**: when the Metal library/shader init fails (`ggml_metal_library_init_from_source: error compiling source`), fail fast with a typed error or auto-fall back to CPU, instead of silently proceeding into an unstable GPU state? On M5 that bad state can take the whole machine down (watchdog hard reset, no panic log), so failing fast there is strictly safer than hanging. Happy to send a PR if the approach sounds right *and* if that native init failure is observable from the binding side — wanted to check direction before writing anything.\n","author_association":"NONE","pin":null,"reactions":{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/4718470143/reactions","total_count":0,"+1":0,"-1":0,"laugh":0,"hooray":0,"confused":0,"heart":0,"rocket":0,"eyes":0},"performed_via_github_app":null,"minimized":null},{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/5654544885","html_url":"https://github.com/withcatai/node-llama-cpp/issues/595#issuecomment-5654544885","issue_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595","id":5654544885,"node_id":"IC_kwDOKGciF88AAAABUQmB9Q","user":{"login":"giladgd","id":7817232,"node_id":"MDQ6VXNlcjc4MTcyMzI=","avatar_url":"https://avatars.githubusercontent.com/u/7817232?v=4","gravatar_id":"","url":"https://api.github.com/users/giladgd","html_url":"https://github.com/giladgd","followers_url":"https://api.github.com/users/giladgd/followers","following_url":"https://api.github.com/users/giladgd/following{/other_user}","gists_url":"https://api.github.com/users/giladgd/gists{/gist_id}","starred_url":"https://api.github.com/users/giladgd/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/giladgd/subscriptions","organizations_url":"https://api.github.com/users/giladgd/orgs","repos_url":"https://api.github.com/users/giladgd/repos","events_url":"https://api.github.com/users/giladgd/events{/privacy}","received_events_url":"https://api.github.com/users/giladgd/received_events","type":"User","user_view_type":"public","site_admin":false},"created_at":"2026-09-13T16:30:53Z","updated_at":"2026-09-13T16:31:04Z","body":"I couldn't reproduce this issue on my machine, but in #645 I also fixed some rare edge cases that I suspect could have caused this issue.\nCould you please try again with `node-llama-cpp` version `3.21.1` and let me know whether it fixed the issue for you?","author_association":"MEMBER","pin":null,"reactions":{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/5654544885/reactions","total_count":0,"+1":0,"-1":0,"laugh":0,"hooray":0,"confused":0,"heart":0,"rocket":0,"eyes":0},"performed_via_github_app":null,"minimized":null},{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/5662529716","html_url":"https://github.com/withcatai/node-llama-cpp/issues/595#issuecomment-5662529716","issue_url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/595","id":5662529716,"node_id":"IC_kwDOKGciF88AAAABUYNYtA","user":{"login":"jowitte","id":8180200,"node_id":"MDQ6VXNlcjgxODAyMDA=","avatar_url":"https://avatars.githubusercontent.com/u/8180200?v=4","gravatar_id":"","url":"https://api.github.com/users/jowitte","html_url":"https://github.com/jowitte","followers_url":"https://api.github.com/users/jowitte/followers","following_url":"https://api.github.com/users/jowitte/following{/other_user}","gists_url":"https://api.github.com/users/jowitte/gists{/gist_id}","starred_url":"https://api.github.com/users/jowitte/starred{/owner}{/repo}","subscriptions_url":"https://api.github.com/users/jowitte/subscriptions","organizations_url":"https://api.github.com/users/jowitte/orgs","repos_url":"https://api.github.com/users/jowitte/repos","events_url":"https://api.github.com/users/jowitte/events{/privacy}","received_events_url":"https://api.github.com/users/jowitte/received_events","type":"User","user_view_type":"public","site_admin":false},"created_at":"2026-09-14T10:25:51Z","updated_at":"2026-09-14T10:25:51Z","body":"Thanks! I re-tested on the same machine (M5 Max, now macOS 26.6.2, Node 26.8.2) with nomic-embed-text-v2-moe and embeddinggemma-300M: 3.21.1, 3.20.0 and also the originally reported 3.18.1 all ran without a single hang: 25–65 cold-start runs plus 2,000 sequential embeddings in one process per version, with and without `GGML_METAL_NO_RESIDENCY`.\n\nSince 3.18.1 no longer reproduces either, I can't attribute the fix to 3.21.1. It most likely went away with a macOS update (26.4.1 → 26.6.2) or with installing full Xcode in the meantime. Fine to close from my side; I'll reopen if it shows up again.\n","author_association":"NONE","pin":null,"reactions":{"url":"https://api.github.com/repos/withcatai/node-llama-cpp/issues/comments/5662529716/reactions","total_count":0,"+1":0,"-1":0,"laugh":0,"hooray":0,"confused":0,"heart":0,"rocket":0,"eyes":0},"performed_via_github_app":null,"minimized":null}]
```
</details>

### Tool Call: `execute` (seq `155`, status: `completed`)

**Input:**
```json
{
  "code": "return await tools.context7[\"query-docs\"]({libraryId:\"/websites/sqlite_docs\",query:\"PRAGMA busy_timeout BEGIN IMMEDIATE WAL only one writer attached read-only database transaction SQLITE_BUSY\"})"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
### 6. Result Code Meanings

Source: https://www.sqlite.org/rescode.html

### (5) SQLITE_BUSY
The SQLITE_BUSY result code indicates that the database file could not be written (or in some cases read) because of concurrent activity by some other database connection, usually a database connection in a separate process. 
For example, if process A is in the middle of a large write transaction and at the same time process B attempts to start a new write transaction, process B will get back an SQLITE_BUSY result because SQLite only supports one writer at a time. Process B will need to wait for process A to finish its transaction before starting a new transaction. The sqlite3_busy_timeout() and sqlite3_busy_handler() interfaces and the busy_timeout pragma are available to process B to help it deal with SQLITE_BUSY errors. 
An SQLITE_BUSY error can occur at any point in a transaction: when the transaction is first started, during any write or update operations, or when the transaction commits. To avoid encountering SQLITE_BUSY errors in the middle of a transaction, the application can use BEGIN IMMEDIATE instead of just BEGIN to start a transaction. The BEGIN IMMEDIATE command might itself return SQLITE_BUSY, but if it succeeds, then SQLite guarantees that no subsequent operations on the same database through the next COMMIT will return SQLITE_BUSY. 
See also: SQLITE_BUSY_RECOVERY and SQLITE_BUSY_SNAPSHOT. 
The SQLITE_BUSY result code differs from SQLITE_LOCKED in that SQLITE_BUSY indicates a conflict with a separate database connection, probably in a separate process, whereas SQLITE_LOCKED indicates a conflict within the same database connection (or sometimes a database connection with a shared cache). 

--------------------------------

### 2.2. DEFERRED, IMMEDIATE, and EXCLUSIVE transactions

Source: https://www.sqlite.org/lang_transaction.html

## 2.2. DEFERRED, IMMEDIATE, and EXCLUSIVE transactions
Transactions can be DEFERRED, IMMEDIATE, or EXCLUSIVE. The default transaction behavior is DEFERRED. 
DEFERRED means that the transaction does not actually start until the database is first accessed. Internally, the BEGIN DEFERRED statement merely sets a flag on the database connection that turns off the automatic commit that would normally occur when the last statement finishes. This causes the transaction that is automatically started to persist until an explicit COMMIT or ROLLBACK or until a rollback is provoked by an error or an ON CONFLICT ROLLBACK clause. If the first statement after BEGIN DEFERRED is a SELECT, then a read transaction is started. Subsequent write statements will upgrade the transaction to a write transaction if possible, or return SQLITE_BUSY. If the first statement after BEGIN DEFERRED is a write statement, then a write transaction is started. 
IMMEDIATE causes the database connection to start a new write immediately, without waiting for a write statement. The BEGIN IMMEDIATE might fail with SQLITE_BUSY if another write transaction is already active on another database connection. 
EXCLUSIVE is similar to IMMEDIATE in that a write transaction is started immediately. EXCLUSIVE and IMMEDIATE are the same in WAL mode, but in other journaling modes, EXCLUSIVE prevents other database connections from reading the database while the transaction is underway.

--------------------------------

### Isolation And Concurrency

Source: https://www.sqlite.org/isolation.html

If X starts a transaction that will initially only read but X knows it will eventually want to write and does not want to be troubled with possible SQLITE_BUSY_SNAPSHOT errors that arise because another connection jumped ahead of it in line, then X can issue BEGIN IMMEDIATE to start its transaction instead of just an ordinary BEGIN. The BEGIN IMMEDIATE command goes ahead and starts a write transaction, and thus blocks all other writers. If the BEGIN IMMEDIATE operation succeeds, then no subsequent operations in that transaction will ever fail with an SQLITE_BUSY error.

--------------------------------

### sqlite3_busy_timeout(sqlite3*, int ms)

Source: https://www.sqlite.org/c3ref/busy_timeout.html

Sets a busy handler that sleeps for a specified amount of time when a table is locked. The handler will sleep multiple times until at least 'ms' milliseconds of sleeping have accumulated. After that, it returns 0, causing sqlite3_step() to return SQLITE_BUSY. Calling with an argument less than or equal to zero turns off all busy handlers. There can only be a single busy handler for a particular database connection at any given moment; if another busy handler was defined using sqlite3_busy_handler(), that other handler is cleared.

```APIDOC
## sqlite3_busy_timeout(sqlite3*, int ms)

### Description
Sets a busy handler that sleeps for a specified amount of time when a table is locked. The handler will sleep multiple times until at least 'ms' milliseconds of sleeping have accumulated. After that, it returns 0, causing sqlite3_step() to return SQLITE_BUSY. Calling with an argument less than or equal to zero turns off all busy handlers. There can only be a single busy handler for a particular database connection at any given moment; if another busy handler was defined using sqlite3_busy_handler(), that other handler is cleared.

### Function Signature
```c
int sqlite3_busy_timeout(sqlite3*, int ms);
```


... [省略中间 47 行输出，完整源码与引用契约见仓库及 doc/references/] ...

### Return Value
The callback should return:
- **0**: No additional attempts are made to access the database, and SQLITE_BUSY is returned to the application.
- **Non-zero**: Another attempt is made to access the database, and the cycle repeats.

### Behavior
- The default busy callback is NULL.
- There can only be a single busy handler defined for each database connection. Setting a new busy handler clears any previously set handler.
- Calling sqlite3_busy_timeout() or evaluating PRAGMA busy_timeout=N will change the busy handler and thus clear any previously set busy handler.
- The presence of a busy handler does not guarantee that it will be invoked when there is lock contention. If SQLite determines that invoking the busy handler could result in a deadlock, it will return SQLITE_BUSY to the application instead of invoking the busy handler.
- The busy callback should not take any actions which modify the database connection that invoked the busy handler. The busy handler is not reentrant. Any such actions result in undefined behavior.
- A busy handler must not close the database connection or prepared statement that invoked the busy handler.

### Example
```c
int busy_callback(void *data, int count) {
    // Return non-zero to retry, 0 to give up
    return count < 5;
}

sqlite3 *db;
// ... open database ...
sqlite3_busy_handler(db, busy_callback, NULL);
```
```
```
</details>

### Tool Call: `grep` (seq `155`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist",
  "pattern": "function getDefaultContextBatchSize",
  "limit": 10
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Found 2 matches
node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.d.ts:
  Line 351: export declare function getDefaultContextBatchSize({ contextSize, sequences }: {


node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js:
  Line 2100: export function getDefaultContextBatchSize({ contextSize, sequences }) {

```
</details>

### Tool Call: `grep` (seq `155`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/llama",
  "pattern": "AddonContextDecodeBatchWorker::Execute|class AddonContextDecodeBatchWorker",
  "limit": 10
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Found 1 matches
node_modules/node-llama-cpp/llama/addon/AddonContext.cpp:
  Line 48: class AddonContextDecodeBatchWorker : public Napi::AsyncWorker {

```
</details>

### Tool Call: `read` (seq `184`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>/packages/plugin/src/source.bun.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file <opencode-repo>/packages/plugin/src/source.bun.ts, lines 1-71
1: import { createRequire } from "node:module"
2: import { readFileSync } from "node:fs"
3: import path from "node:path"
4: import { fileURLToPath, pathToFileURL } from "node:url"
5: import { Host } from "./host.js"
6: import { provides } from "./runtime.js"
7: import { localSource } from "./source.js"
8: import { missingPackageTarget } from "./source.package.js"
9: 
10: let generation = Date.now()
11: 
12: export async function prepareSource(entrypoint: string, track: (file: string, directory?: boolean) => void) {
13:   const root = fileURLToPath(entrypoint)
14:   const files = new Set<string>()
15:   const visit = (file: string, search = "") => {
16:     if (file !== root && file.split(path.sep).includes("node_modules")) return
17:     if (search) delete require.cache[file + search]
18:     if (files.has(file)) return
19:     files.add(file)
20:     // Bun exposes ESM here too. Delete known keys even when absent: rejected
21:     // evaluations are not enumerable, but deletion still invalidates them.
22:     delete require.cache[file]
23:     track(file)
24:     if (!/\.[cm]?[jt]sx?$/.test(file)) return
25:     // Scan dependencies only; the normal runtime loader still owns compilation,
26:     // package resolution, import attributes, and error reporting.
27:     const imports = (() => {
28:       try {
29:         return new Bun.Transpiler({
30:           loader: file.endsWith("tsx") ? "tsx" : file.endsWith("jsx") ? "jsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js",
31:           target: "bun",
32:         }).scan(readFileSync(file, "utf8")).imports
33:       } catch {
34:         return []
35:       }
36:     })()
37:     for (const item of imports) {
38:       const local =
39:         item.path.startsWith("./") || item.path.startsWith("../")
40:           ? new URL(item.path, pathToFileURL(file))
41:           : localSource(item.path, path.dirname(file))
42:       if (!local) {
43:         if (provides(item.path)) continue
44:         try {
45:           Bun.resolveSync(item.path, path.dirname(file))
46:         } catch {
47:           const target = missingPackageTarget(item.path, file)
48:           if (target) track(target, true)
49:         }
50:         continue
51:       }
52:       const requested = fileURLToPath(local)
53:       // Resolving a workspace symlink can erase its node_modules boundary.
54:       if (requested.split(path.sep).includes("node_modules")) continue
55:       try {
56:         visit(
57:           item.kind === "require-call"
58:             ? createRequire(file).resolve(requested)
59:             : Bun.resolveSync(requested, path.dirname(file)),
60:           local.search,
61:         )
62:       } catch {
63:         // A missing local dependency may appear on the next save. Leave its
64:         // actual failure (or optional fallback) to the native loader.
65:         track(path.dirname(requested), true)
66:       }
67:     }
68:   }
69:   visit(root)
70:   return { version: String(++generation), load: () => Host.load(entrypoint) }
71: }
```
</details>

### Tool Call: `read` (seq `184`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/llama/addon/AddonContext.cpp",
  "offset": 1,
  "limit": 145
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file node_modules/node-llama-cpp/llama/addon/AddonContext.cpp, lines 1-145
1: #include <thread>
2: #include <algorithm>
3: #include <cmath>
4: #include <vector>
5: #include "common/common.h"
6: #include "llama-context.h"
7: #include "llama-vocab.h"
8: #include "llama.h"
9: 
10: #include "addonGlobals.h"
11: #include "AddonModel.h"
12: #include "AddonModelLora.h"
13: #include "AddonGrammarEvaluationState.h"
14: #include "AddonContext.h"
15: 
16: static uint64_t calculateBatchMemorySize(int32_t n_tokens_alloc, int32_t embd, int32_t n_seq_max) {
17:     uint64_t totalSize = 0;
18: 
19:     if (embd) {
20:         totalSize += sizeof(float) * n_tokens_alloc * embd;
21:     } else {
22:         totalSize += sizeof(llama_token) * n_tokens_alloc;
23:     }
24: 
25:     totalSize += sizeof(llama_pos) * n_tokens_alloc;
26:     totalSize += sizeof(int32_t) * n_tokens_alloc;
27:     totalSize += sizeof(llama_seq_id *) * (n_tokens_alloc + 1);
28: 
29:     totalSize += sizeof(llama_seq_id) * n_seq_max * n_tokens_alloc;
30: 
31:     totalSize += sizeof(int8_t) * n_tokens_alloc;
32: 
33:     return totalSize;
34: }
35: 
36: static void addTokenToBatch(llama_batch& batch, llama_token token, llama_pos pos, llama_seq_id sequenceId, bool logits) {
37:     GGML_ASSERT(batch.seq_id[batch.n_tokens] && "llama_batch size exceeded");
38: 
39:     const int32_t batchIndex = batch.n_tokens;
40:     batch.token[batchIndex] = token;
41:     batch.pos[batchIndex] = pos;
42:     batch.n_seq_id[batchIndex] = 1;
43:     batch.seq_id[batchIndex][0] = sequenceId;
44:     batch.logits[batchIndex] = logits;
45:     batch.n_tokens++;
46: }
47: 
48: class AddonContextDecodeBatchWorker : public Napi::AsyncWorker {
49:     public:

... [省略中间 72 行输出，完整源码与引用契约见仓库及 doc/references/] ...

122: 
123:         void Execute() {
124:             try {
125:                 context->ctx = llama_init_from_model(context->model->model, context->context_params);
126: 
127:                 context->contextLoaded = context->ctx != nullptr;
128:             } catch (const std::exception& e) {
129:                 SetError(e.what());
130:             } catch(...) {
131:                 SetError("Unknown error when calling \"llama_init_from_model\"");
132:             }
133:         }
134:         void OnOK() {
135:             if (context->contextLoaded && !context->model->model_params.no_alloc) {
136:                 uint64_t contextMemorySize = llama_state_get_size(context->ctx);
137:                 adjustNapiExternalMemoryAdd(context->Env(), contextMemorySize);
138:                 context->loadedContextMemorySize = contextMemorySize;
139:             }
140: 
141:             deferred.Resolve(Napi::Boolean::New(Env(), context->contextLoaded));
142:         }
143:         void OnError(const Napi::Error& err) {
144:             deferred.Reject(err.Value());
145:         }
[Output truncated. Continue reading with offset: 146]
```
</details>

### Tool Call: `read` (seq `184`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js",
  "offset": 2090,
  "limit": 28
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js, lines 2090-2110
2090: function disposeContextIfReferenced(contextRef) {
2091:     const context = contextRef.deref();
2092:     if (context != null)
2093:         void context.dispose();
2094: }
2095: function disposeContextSequenceIfReferenced(contextRef) {
2096:     const context = contextRef.deref();
2097:     if (context != null)
2098:         context.dispose();
2099: }
2100: export function getDefaultContextBatchSize({ contextSize, sequences }) {
2101:     return Math.min(contextSize * sequences, 512);
2102: }
2103: export function getDefaultContextSequences() {
2104:     return 1;
2105: }
2106: const defaultFallbackContextSize = 4096;
2107: export function getDefaultModelContextSize({ trainContextSize }) {
2108:     return trainContextSize ?? defaultFallbackContextSize;
2109: }
2110: //# sourceMappingURL=LlamaContext.js.map
```
</details>

### Tool Call: `grep` (seq `184`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js",
  "pattern": "sequences =|sequences:|dispose\\(|_embeddings",
  "limit": 30
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Found 30 matches
node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js:
  Line 143:     constructor({ _model }, { sequences, contextSize, batchSize, flashAttention = _model.defaultContextFlashAttention, threads, batching: { dispatchSchedule: batchingDispatchSchedule = "nextCycle", itemPrioritizationStrategy: batchingItemsPrioritizationStrategy = "maximumParallelism" } = {}, swaFullCache = _model.defaultContextSwaFullCache, performanceTracking = false, experimentalKvCacheKeyType, experimentalKvCacheValueType, _embeddings, _ranking }) {

  Line 171:             sequences: this._totalSequences,

  Line 176:             embeddings: _embeddings,

  Line 200:             await this._ctx.dispose();

  Line 201:             this._vramConsumptionMarking?.dispose();

  Line 202:             this._ramConsumptionMarking?.dispose();

  Line 203:             this._modelPreventDisposalHandle.dispose();

  Line 206:     async dispose() {

  Line 210:         await this._disposeAggregator.dispose();

  Line 214:         return this.dispose();

  Line 443:                         consumerHandle?.dispose();

  Line 446:                         consumerHandle?.dispose();

  Line 528:                         decodeLock?.dispose();

  Line 529:                         preventDisposalHandle.dispose();

  Line 679:         this._threadSplitterConsumer.dispose();

  Line 692:         const sequences = Math.max(1, Math.floor(options.sequences ?? getDefaultContextSequences()));

  Line 715:             sequences: sequences,

  Line 725:             isEmbeddingContext: options._embeddings

  Line 745:                 isEmbeddingContext: options._embeddings,

  Line 778:                     initLock.dispose();

  Line 782:                         await context._ctx.dispose();

  Line 803:                         await context.dispose();

  Line 807:                         await context.dispose();

  Line 892:             this._disposeAggregator.add(() => void this._tokenPredictor?.dispose());

  Line 895:     async dispose() {

  Line 898:         await this._disposeAggregator.dispose();

  Line 904:         return this.dispose();

  Line 911:         void this.dispose();

  Line 1397:             evaluatorLock.dispose();

  Line 1419:             contextLock.dispose();


(Results are truncated: showing first 30 results. Consider using a more specific path or pattern.)
```
</details>

### Tool Call: `read` (seq `184`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist/bindings/utils/binariesGithubRelease.js"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file node_modules/node-llama-cpp/dist/bindings/utils/binariesGithubRelease.js, lines 1-17
1: import fs from "fs-extra";
2: import { binariesGithubReleasePath, llamaCppReleaseEnvVar } from "../../config.js";
3: export async function getBinariesGithubRelease() {
4:     const binariesGithubRelease = await fs.readJson(binariesGithubReleasePath);
5:     return binariesGithubRelease.release;
6: }
7: export async function setBinariesGithubRelease(release) {
8:     const binariesGithubReleaseJson = {
9:         release: release
10:     };
11:     await fs.writeJson(binariesGithubReleasePath, binariesGithubReleaseJson, {
12:         spaces: 4
13:     });
14: }
15: export const builtinLlamaCppRelease = await getBinariesGithubRelease();
16: export const defaultLlamaCppRelease = llamaCppReleaseEnvVar || builtinLlamaCppRelease;
17: //# sourceMappingURL=binariesGithubRelease.js.map
```
</details>

### Tool Call: `grep` (seq `184`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>/packages/core/src/plugin/promise.ts",
  "pattern": "setup|cleanup|dispose|finalizer",
  "limit": 35
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
No matches found
```
</details>

<details>
<summary><b>Assistant Reasoning</b> (seq <code>211</code>, agent: <code>general</code>, model: <code>example-provider/chat-model#default</code>)</summary>

**Assessing task requirements**

I think I need to update the user about the current setup and provide details on the task. I’m aiming for around 1800 words, with the critical parts being within 1000 to 1500 words. I should identify if there’s any busy event and check the actual event type, which might not be supported. I’ll need to look into local schema options to make sure everything aligns correctly. Let's see if this all comes together!

</details>

### Tool Call: `grep` (seq `211`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>/packages/schema/src",
  "pattern": "session\\.(busy|prompt|idle|execution\\.succeeded|execution\\.started|execution\\.failed|execution\\.interrupted)",
  "limit": 45
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Found 5 matches
<opencode-repo>/packages/schema/src/session-status-event.ts:
  Line 47:   type: "session.idle",


<opencode-repo>/packages/schema/src/session-event.ts:
  Line 245:   export const Started = Event.durable({ type: "session.execution.started", ...options, schema: Base })

  Line 248:   export const Succeeded = Event.durable({ type: "session.execution.succeeded", ...options, schema: Base })

  Line 252:     type: "session.execution.failed",

  Line 259:     type: "session.execution.interrupted",

```
</details>

### Tool Call: `read` (seq `211`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>/packages/core/src/plugin/promise.ts",
  "limit": 100
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file <opencode-repo>/packages/core/src/plugin/promise.ts, lines 1-3
1: export * as PluginPromise from "./promise.js"
2: 
3: export { fromPromise } from "@opencode/plugin/promise/adapter"
```
</details>

### Tool Call: `read` (seq `211`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js",
  "offset": 177,
  "limit": 40
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.js, lines 177-216
177:             ranking: _ranking,
178:             performanceTracking: this._performanceTracking,
179:             kvCacheKeyType: this._kvCacheKeyType,
180:             kvCacheValueType: this._kvCacheValueType,
181:             swaFullCache: this._swaFullCache
182:         }));
183:         this._batchingOptions = {
184:             dispatchSchedule: batchingDispatchSchedule,
185:             itemPrioritizationStrategy: batchingItemsPrioritizationStrategy
186:         };
187:         this._reclaimUnusedSequenceId = this._reclaimUnusedSequenceId.bind(this);
188:         this._freeReservedThreads = this._freeReservedThreads.bind(this);
189:         this._sequenceGcRegistry = new FinalizationRegistry(this._reclaimUnusedSequenceId);
190:         this._disposeAggregator.add(() => {
191:             this._disposed = true;
192:         });
193:         this._disposeAggregator.add(this._onReclaimUnusedSequenceId);
194:         this._disposeAggregator.add(this.onDispose.dispatchEvent);
195:         const onModelDisposeListener = this.model.onDispose.createListener(disposeContextIfReferenced.bind(null, new WeakRef(this)));
196:         this._disposeAggregator.add(onModelDisposeListener);
197:         this._disposeAggregator.add(registerFinalizer(this, onModelDisposeListener));
198:         this._disposeAggregator.add(async () => {
199:             await this._backendContextDisposeGuard.acquireDisposeLock();
200:             await this._ctx.dispose();
201:             this._vramConsumptionMarking?.dispose();
202:             this._ramConsumptionMarking?.dispose();
203:             this._modelPreventDisposalHandle.dispose();
204:         });
205:     }
206:     async dispose() {
207:         if (this._disposed)
208:             return;
209:         this._disposed = true;
210:         await this._disposeAggregator.dispose();
211:     }
212:     /** @hidden */
213:     [Symbol.asyncDispose]() {
214:         return this.dispose();
215:     }
216:     get disposed() {
[Output truncated. Continue reading with offset: 217]
```
</details>

### Tool Call: `grep` (seq `211`, status: `completed`)

**Input:**
```json
{
  "path": "node_modules/node-llama-cpp/dist/evaluator/LlamaModel/LlamaModel.js",
  "pattern": "tokenize\\(|tokenizer =",
  "limit": 15
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Found 15 matches
node_modules/node-llama-cpp/dist/evaluator/LlamaModel/LlamaModel.js:
  Line 134:         this.tokenizer = this.tokenize;

  Line 217:     tokenize(text, specialTokens = false, options) {

  Line 254:                     const tokens = Array.from(this._model.tokenize(workaroundTokenString + text, true));

  Line 259:                         if (countLeadingSpaces(this.detokenize(tokens, true)) === textLeadingSpaces)

  Line 264:                 const workaroundTokens = Array.from(this._model.tokenize(workaroundTokensString, true));

  Line 266:                     const tokens = Array.from(this._model.tokenize(text, true));

  Line 267:                     if (this.detokenize(tokens, true).startsWith(workaroundTokensString))

  Line 270:                 const tokens = Array.from(this._model.tokenize(workaroundTokensString + text, true));

  Line 274:                     if (countLeadingSpaces(this.detokenize(tokens, true)) === textLeadingSpaces)

  Line 280:                 const workaroundTokens = Array.from(this._model.tokenize(workaroundTokensString, false));

  Line 282:                     const tokens = Array.from(this._model.tokenize(text, false));

  Line 283:                     if (this.detokenize(tokens, false).startsWith(workaroundTokensString))

  Line 286:                 const tokens = Array.from(this._model.tokenize(workaroundTokensString + text, false));

  Line 294:         return Array.from(this._model.tokenize(text, specialTokens));

  Line 313:     detokenize(tokens, specialTokens = false, lastTokens) {


(Results are truncated: showing first 15 results. Consider using a more specific path or pattern.)
```
</details>

### Tool Call: `read` (seq `232`, status: `completed`)

**Input:**
```json
{
  "path": "<opencode-repo>/packages/schema/src/session-status-event.ts"
}
```

<details>
<summary><b>Tool Output</b></summary>

```text
Read file <opencode-repo>/packages/schema/src/session-status-event.ts, lines 1-53
1: export * as SessionStatusEvent from "./session-status-event.js"
2: 
3: import { Schema } from "effect"
4: import { optional } from "./schema.js"
5: import { Event } from "./event.js"
6: import { NonNegativeInt } from "./schema.js"
7: import { SessionID } from "./session-id.js"
8: 
9: export const Info = Schema.Union([
10:   Schema.Struct({
11:     type: Schema.Literal("idle"),
12:   }),
13:   Schema.Struct({
14:     type: Schema.Literal("retry"),
15:     attempt: NonNegativeInt,
16:     message: Schema.String,
17:     action: optional(
18:       Schema.Struct({
19:         reason: Schema.String,
20:         provider: Schema.String,
21:         title: Schema.String,
22:         message: Schema.String,
23:         label: Schema.String,
24:         link: optional(Schema.String),
25:       }),
26:     ),
27:     next: NonNegativeInt,
28:   }),
29:   Schema.Struct({
30:     type: Schema.Literal("busy"),
31:   }),
32: ]).annotate({ identifier: "SessionStatus" })
33: export type Info = Schema.Schema.Type<typeof Info>
34: 
35: export const Status = Event.ephemeral({
36:   type: "session.status",
37:   // The bare SessionStatus identifier belongs to the status union above.
38:   identifier: "SessionStatusUpdated",
39:   schema: {
40:     sessionID: SessionID,
41:     status: Info,
42:   },
43: })
44: 
45: // deprecated
46: export const Idle = Event.ephemeral({
47:   type: "session.idle",
48:   schema: {
49:     sessionID: SessionID,
50:   },
51: })
52: 
53: export const Definitions = Event.inventory(Status, Idle)
```
</details>

### Assistant Response (seq `241`, id `msg_example_f1de6dc4f3d4`, agent: `general`, model: `example-provider/chat-model#default`)

## Verdict

**The plan addresses the memory spike, but needs changes before it can reliably address responsiveness, reloads, and native hangs.** The biggest omissions are:

1. A module-level singleton may still be duplicated by OpenCode’s source loader.
2. `searchSessions()` independently embeds the entire backlog.
3. Current disposal can close SQLite underneath running work.
4. Chunk cancellation cannot interrupt a hung Metal call.
5. Embedding cache identity does not include the model or preprocessing configuration.

I reviewed the requested files, the installed dependency, and the local OpenCode loader. **Locally installed `node-llama-cpp` is 3.22.2**, despite the package declaring `^3.16.2`; confirm what PID 2945 actually loaded.

## 1. Shared core: necessary, with stricter lifecycle rules

### Use a genuinely process-wide registry

The local OpenCode Bun loader explicitly invalidates the entrypoint and local dependency caches:

`<opencode-repo>/packages/plugin/src/source.bun.ts:15-23`

Therefore, a top-level `Map` in the plugin is **not a reliable process-wide singleton**, including across reloads.

Use a namespaced `globalThis[Symbol.for(...)]` registry, with:

- Canonicalized database/model paths.
- Explicit configuration compatibility checks.
- An implementation/schema generation identifier.
- An initialization promise registered **before awaiting** initialization.
- Failed initialization removed from the registry.
- An explicit `closing` state and shutdown promise.

**Do not reuse old class instances indefinitely after source edits.** A registry keyed only by paths/options could preserve the buggy implementation across reloads. Conversely, adding a new generation key must not allow old and new generations to run GPU work concurrently: coordinate their transition through a stable registry-level gate.

### Ref-count work as well as workspace registrations

Current `RecallIndexer.dispose()` immediately closes SQLite:

`src/indexer.ts:243-246`

Running embedding work can subsequently call `saveEmbeddings()` against that closed connection. Queued tasks also lack a disposed check.

Recommended shutdown sequence:

1. Stop accepting new work; cancel timers and background jobs.
2. Remove this workspace’s subscriptions and registrations.
3. Drain or cancel admitted jobs cooperatively.
4. Await embedding resource disposal.
5. Close SQLite and remove the registry entry.

Make release idempotent and unwind registration/setup failures. OpenCode documents that already-captured tool executors survive registration disposal, so stale executors must either acquire a valid operation lease or reject cleanly.

### Handle configuration conflicts explicitly

Sharing keys should account for `modelDir`, context/input policy, and relevant backend options. Decide how different `idleDebounceMs` values interact rather than letting the first workspace silently determine behavior.

More importantly, **different models writing to the same database remain unsafe even with separate cores**; see cache identity below.

Keep custom embedders and memory databases isolated as proposed.

## 2. Context size: token-aware truncation is mandatory

**`contextSize: 2048` is a reasonable starting limit, not automatic truncation.**

The installed implementation:

`node_modules/node-llama-cpp/dist/evaluator/LlamaEmbeddingContext.js:24-55`

- Tokenizes the input.
- Adds required beginning/end tokens.
- Rejects when the resulting length is **greater than or equal to** the context size.
- Exposes `calculateInputLength()`.

Therefore:

- Cap **tokens**, not characters. Code, Chinese, emoji, and long identifiers invalidate character/token heuristics.
- Include formatting and special tokens in the budget.
- Require prepared input length **`< 2048`**, not `<= 2048`.
- Prefer passing truncated token arrays to `getEmbeddingFor()` to avoid detokenize/re-tokenize surprises.
- Apply the policy to both turns and search queries.

For this installed implementation, reserving three positions—up to two inserted special tokens plus one spare position—is conservative; validate the result using `calculateInputLength()`.

**Version matters:** the 3.16.2 implementation checks length differently and lacks this helper. Pin or declare the actual minimum dependency version required by the implementation.

### Preserve retrieval quality

Blind prefix truncation of:

```text
User: <very long question>
Assistant: <answer>
```

can remove the assistant answer entirely. Give user and assistant text separate budgets, or choose a documented head/tail policy. Preserve full text and full-content hashes in SQLite.

### Separate the two meanings of “batch”

- A persistence chunk of 16 turns controls durability and cancellation latency.
- `createEmbeddingContext({ batchSize })` controls **token processing**, not the number of turns.

The installed default token batch size is already capped at 512. Lowering persistence chunk size does not itself shrink KV allocation. Measure actual memory after applying the context cap; not every allocation scales linearly with context size.

## 3. Incremental persistence and preemption: change both indexing paths

### Search currently defeats the proposed preemption

`searchSessions()` contains its own full-backlog embedding loop:

`src/indexer.ts:201-218`

Aborting background indexing merely transfers the same backlog into the foreground search.

**Recommended search contract:**

1. Preempt background work.
2. Reconcile turn metadata.
3. Embed the query first.
4. Search already-persisted embeddings.
5. Resume remaining indexing when idle.

Expose incomplete indexing in metadata. If “flush before search” must remain supported, make it explicit or bounded; that requirement conflicts with fast search over a large backlog. Existing tests assert full flushing and will need intentional updates.

### Implement cancellation separately from timer clearing

Today `cancelIdleSync()` only clears a timer. Both `scheduleIdleSync()` and `syncPendingSessions()` call it internally.

If it starts aborting work without restructuring these calls, **a sync can cancel itself**, or duplicate idle events can repeatedly cancel useful progress.

Use separate operations:

- Clear debounce timer.
- Abort the current background job.
- Invalidate queued background jobs.
- Schedule/coalesce future work.

Give each job an `AbortSignal` or generation token, and check it when dequeued, before acquiring resources, and between items/chunks. Ensure foreground requests take priority over stale queued background jobs.

### Persist frequently without repeatedly loading the model

Keep one embedding scope around a bounded run; commit chunks within it. Do not acquire/dispose the model for every chunk.

Because the current embedder already evaluates texts sequentially, checking cancellation **between individual embeddings** can provide better responsiveness than waiting for 32 turns. Flush completed vectors before exiting on cancellation.

A hung first chunk still leaves zero persisted vectors. Smaller initial commits—or per-item persistence—reduce that failure window.

Also:

- Report actual committed counts, not `missing.length`.
- Preserve earlier commits when a later item fails.
- Log background failures; the current empty catch hides repeated failures.
- Resume interrupted work after the next genuine idle transition.

### Fix event handling

The local V2 schema defines:

- `session.status` with `busy`, `retry`, or `idle`.
- `session.execution.started/succeeded/failed/interrupted`.
- Deprecated `session.idle`.

The current checks for `session.busy` and `session.prompt` do not match that schema. The prompt hook helps, but does not cover every execution path.

Track busy state **by session ID**, idempotently across duplicate subscriptions. Otherwise, one session becoming idle can restart indexing while another remains active. Pass the tool’s cancellation signal into foreground work too.

## 4. Missing database changes

### Version embedding cache identity

Currently embeddings are keyed only by `content_hash`:

`src/db.ts:328-330`

Changing the model, truncation policy, or input formatting silently reuses incompatible vectors. Separate cores using different models can overwrite each other.

Add an embedding-profile identifier containing the model identity and preprocessing version, and either:

- Namespace embeddings by `(profile, content_hash)`, or
- Enforce one profile per database and rebuild embeddings on mismatch.

Validate vector dimension and finite values. Currently `dotProduct()` uses the shorter dimension, silently accepting incompatible vectors.

### Address cross-process contention

A process singleton does not coordinate another OpenCode service, standalone instance, or development process.

`BEGIN IMMEDIATE` in reconciliation and persistence can return `SQLITE_BUSY`; WAL still permits only one writer. Configure a bounded busy timeout **before initialization writes**, plus bounded retry/backoff for transient contention.

Because this uses synchronous SQLite, a long busy timeout blocks the server’s JavaScript thread. Prefer short waits with asynchronous retries outside transactions, or move database work off-thread if necessary.

Keep embedding computation outside transactions, as it already is. A busy timeout protects writes; it does **not** prevent two processes from redundantly computing the same embeddings. If multi-process indexing is supported, add an indexing lease or a single worker owner.

## 5. What specifically caused the Metal hang?

**The evidence identifies the blocked operation, not the precise underlying defect.**

The installed native worker calls:

```cpp
llama_decode(...);
llama_synchronize(...);
```

Its promise settles only after `Execute()` returns:

`node_modules/node-llama-cpp/llama/addon/AddonContext.cpp:69-99`

Your sample shows synchronization waiting for Metal command completion, with submission also blocked in IOGPU. That explains:

- Why embedding promises never settle.
- Why `finally` never executes.
- Why contexts remain allocated.
- Why all-at-end persistence leaves no embeddings.

**Concurrent large contexts and memory pressure are credible contributing factors, but do not prove a particular Metal deadlock or Bun bug.**

Relevant evidence: [upstream issue #595](https://github.com/withcatai/node-llama-cpp/issues/595) reports embedding hangs under both Bun and Node, including a Qwen3-Embedding report. However, the latest reporter follow-up could no longer reproduce even with the originally affected library version after environment changes. It is supporting evidence, not an exact diagnosis or guaranteed upgrade fix.

Additional implications:

- The installed embedding context already serializes evaluations **within one context** using a lock; separate contexts remain independent.
- Bun is supported. Switching to Node is a useful diagnostic comparison, not a demonstrated cure.
- `getEmbeddingFor()` has no decode-abort signal in the installed API.
- `Promise.race()` timeouts do not stop native GPU work.
- Disposal waits on native-use guards and can itself remain blocked.
- Chunk cancellation therefore cannot recover an already-hung decode.

If guaranteed recovery without taking down OpenCode is required, **run native embedding in a supervised child process**, with parent-enforced deadlines and termination. Offer CPU mode for diagnosis/fallback. Avoid starting replacement GPU work while a timed-out in-process operation is still alive.

## Recommended acceptance checks

Before calling the fix complete:

- Four workspace setups, including loader re-evaluation: one active native context.
- Teardown/reload during embedding: no closed-database access or overlapping generations.
- Cancellation during indexing: completed progress persists; search does not flush the backlog.
- One busy session plus another idle session: background indexing stays paused.
- Oversized multilingual/code inputs: prepared token count remains strictly below the cap.
- Model/profile changes: incompatible vectors cannot be reused.
- Two processes contending on SQLite: bounded retry and visible failures.
- Real-model tests under the service’s exact Bun/native-build versions; existing Node tests use fake embedders and cannot verify Metal behavior.

**Priority:** shared lifecycle + explicit token cap + query-first search + incremental persistence. Treat native-hang recovery as a separate requirement that cooperative cancellation alone cannot satisfy.
