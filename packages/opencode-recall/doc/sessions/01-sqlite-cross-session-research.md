# OpenCode插件跨对话共享SQLite

- **工程阶段**：阶段 0：前期技术预研（跨会话共享 SQLite 可行性）
- **Session ID**：`ses_example_e0712d9d9097`
- **工作区目录**：`.`
- **创建时间**：2026-10-28T06:18:29.534Z
- **更新时间**：2026-10-28T06:19:02.473Z
- **定位说明**：验证 OpenCode 插件在多个会话/工作区之间共享同一个本地 SQLite 后端存储（WAL 模式 + 进程内/跨进程并发）的可行性。

---

## Turn #1 — User (seq `4`, id `msg_example_320daf12f31d`)

opencode 的插件能都在多个对话之间共享同一个并使用同一个sqllite后端存储吗？

### Tool Call: `skill` (seq `7`, status: `completed`)

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

### Tool Call: `webfetch` (seq `14`, status: `completed`)

**Input:**
```json
{
  "url": "https://opencode.ai/v2/docs/build/plugins",
  "format": "markdown"
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

### Tool Call: `webfetch` (seq `21`, status: `completed`)

**Input:**
```json
{
  "url": "https://opencode.ai/v2/docs/build/plugins/server",
  "format": "markdown"
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

... [省略中间 1412 行输出，完整源码与引用契约见仓库及 doc/references/] ...

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

Both hooks run for every request a session issues. `event.kind` says which flow issued it: `"primary"` for the agent
loop, `"compaction"` for checkpoint summaries, `"title"` for title generation, and `"generate"` for transient
`ctx.session.generate` calls. Use it instead of the agent ID to tell auxiliary requests apart.

```ts
await ctx.session.hook("http.request", (event) => {
  event.request.headers.set("x-session-id", event.sessionID)
[showing lines 1-1486 of 1809; full output saved to ~/.local/share/opencode/tool-output/tool_example_b515b5110447]
```
</details>

<details>
<summary><b>Assistant Reasoning</b> (seq <code>28</code>, agent: <code>build</code>, model: <code>example-provider/chat-model#medium</code>)</summary>

**Clarifying answer scope**

I’m looking to provide a concise answer regarding the phrase "都 ... 同一个" and its instances, but there’s no need for a repository. I’m thinking about how SQLite can store data in its own file across processes, but there's no physical guarantee when it comes to context storage. I believe that 500 Chinese characters should be sufficient for this explanation. Let's make sure it’s all clear and straightforward!

</details>

### Assistant Response (seq `28`, id `msg_example_c2e8902dd302`, agent: `build`, model: `example-provider/chat-model#medium`)

**可以跨对话共享数据，也可以共用一个 SQLite 数据库；但“共用数据库”和“共用同一个插件运行实例”是两回事。** 按 OpenCode V2 来说：

### 1. 插件实例不按对话一一创建
服务端插件运行在 OpenCode 后台服务中，加载时执行 `setup(ctx)`，实例带有自己的 `ctx.location`。

所以不要把它理解成“每个对话一个插件”，也不要假设“所有项目、所有窗口永远只有一个实例”。跨 location、独立服务进程和插件重载，都需要考虑实例边界。

### 2. 跨对话持久化可以直接用内置存储
V2 提供插件作用域的持久化 JSON 存储：

```ts
await ctx.storage.set("shared/settings", { enabled: true })
const settings = await ctx.storage.get("shared/settings")

// 需要按会话区分时，自己加入 sessionID
await ctx.storage.set(`sessions/${sessionID}/state`, state)
```

官方文档保证的是**插件作用域的持久化存储 API**，没有在该文档中承诺其物理 SQLite 后端，以及跨 location 的具体隔离规则。

### 3. 明确要所有插件、所有对话共用 SQLite
可以让插件统一访问一个固定绝对路径，例如：

```text
~/.local/share/my-opencode-plugins/shared.sqlite
```

建议：
- 所有插件复用统一的存储模块，统一管理表结构和迁移。
- 用 `plugin_id`、`project_id`、`session_id` 区分需要隔离的数据。
- 开启 WAL、配置 `busy_timeout`，写操作用短事务。
- 多进程可以访问同一数据库文件，但不是共享同一个内存连接。

**你的目标如果是“多个对话共享任务、缓存和执行状态”，完全可行，推荐“插件实例按需加载 + 统一 SQLite 存储层”。**

参考：[V2 服务端插件与 Storage](https://opencode.ai/v2/docs/build/plugins/server#storage)。
