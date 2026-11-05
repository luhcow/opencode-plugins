# opencode-a2a

OpenCode V2 的通用 A2A HTTP+JSON REST 客户端插件。支持多 Agent、Agent Card 发现、Skill 映射、SSE 流式输出和多轮上下文。

## 配置

以下配置放在本仓库根目录的项目级 `opencode.jsonc` 中。用于其他项目时替换为实际安装位置，或发布后的 npm 包名。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "./packages/opencode-a2a",
    "options": {
      "agents": {
        "research": {
          "url": "https://agent.example.com",
          "auth": { "type": "bearer", "tokenEnv": "A2A_TOKEN" },
          "exposeSkills": "all"
        }
      }
    }
  }]
}
```

域名为虚构示例，需替换为自己的服务。插件没有内置服务地址或凭据。

- `agents` 可为对象或数组；未配置 Agent 时不连接任何服务。
- `url` 用于发现 `/.well-known/agent-card.json`，兼容 `/.well-known/agent.json`。
- `endpoint` 可显式指定 REST 地址；`discover: false` 可关闭发现并使用静态 `card` / `skills`。
- `auth` 支持 `bearer`、`header`、`apiKey`、`auto`、`none`。自定义认证头通过 `auth.header` 指定或从 Agent Card 推导。
- Token 可来自 `tokenEnv`、`tokenFile`，以及 `headers` 中的 `{env:VAR}` / `{file:path}`。文件支持 `~`、标准 `file:` URL；相对文件路径以插件工作区为基准。
- `streaming` 覆盖 Agent Card 的流式能力；`timeoutMs` 默认 300000，覆盖响应体读取。

## 工具与协议

- `research__<skill>`：每个 Skill 对应一个工具，描述包含 tags/examples；调用透传 `skillId`。
- `a2a_research`：统一消息、发现和任务入口。
- `a2a_research_task`：读取、列出或取消任务。
- `namingStyle` 支持 `double_underscore`、`a2a_prefix`、`both`。
- `exposeSkills`、`includeSkills`、`excludeSkills`、`includeTags`、`excludeTags` 控制独立 Skill 工具的展示，不作为远端权限控制。
- 无 Skill 时由 `fallbackTool: "message"` 提供通用消息工具；可设为 `"none"`。
- 支持 `message:send`、`message:stream`、`tasks`、`tasks/{id}:cancel` 和 `extendedAgentCard`；不实现 JSON-RPC/gRPC 传输。

标准 `contextId` 按 OpenCode 会话和 Agent 隔离保存于内存。`newContext: true` 开启新上下文，`autoContext: false` 关闭自动续接。取消工具时默认尝试取消已知任务。
标准 `data` 部分直接作为结构化输出；默认隐藏 `adk_thought` 和 trace artifacts。`includeReasoning: true` 可显示远端显式提供的思考部分。

非标准响应字段需按 Agent 显式配置，例如：

```jsonc
"responseMetadata": {
  "contextIdKey": "example.context_id",
  "contentTypeKey": "example_content_type"
}
```

## 数据流

启动时获取配置服务的 Agent Card，调用时发送工具输入和显式 metadata。认证仅来自用户配置。
发现到不同源的服务时需显式填写 `endpoint`；HTTP 重定向不自动跟随，使用服务的最终 URL。HTTP 错误仅报告状态码，避免错误页回显认证内容。
Skill 映射和 trace 过滤设计参考 [a2a-mcp-skillmap](https://github.com/shashikanth-gs/a2a-mcp-skillmap) 与 [a2a-wrapper](https://github.com/shashikanth-gs/a2a-wrapper)。

## 验证

```sh
npm test -w opencode-a2a
```

测试使用虚构数据和模拟 HTTP，不连接真实服务。
