# opencode-plugins

OpenCode V2 插件 Monorepo。

## 包含插件

| 包名 | 目录 | 插件 ID | 功能说明 |
| :--- | :--- | :--- | :--- |
| [`opencode-reask`](./packages/opencode-reask) | `packages/opencode-reask` | `reask` | 重新回答已提交或已取消的 Ask（`question`），支持选择式回滚（Selective Revert）、TUI 鼠标点击问答卡片、时间线弹窗、快捷键与 `/reask` 命令 |
| [`opencode-auto-rename`](./packages/opencode-auto-rename) | `packages/opencode-auto-rename` | `auto-rename-first-turn` | 在会话**第一轮回答结束**后，结合首条提问与 Assistant 完整回复自动重新生成精确会话标题 |
| [`opencode-compact-before`](./packages/opencode-compact-before) | `packages/opencode-compact-before` | `compact-before` | `/compact-before` 或 `Ctrl+Alt+C` 选择用户消息，将之前的历史保存为原生压缩检查点 |
| [`opencode-tps`](./packages/opencode-tps) | `packages/opencode-tps` | `tps` | 在底部状态栏实时显示流式 `tok/s`（生成时动态估算、工具执行时不稀释、步骤结束按精确 token 自动校准并保留本轮最终速度） |
| [`opencode-auto-review`](./packages/opencode-auto-review) | `packages/opencode-auto-review` | `opencode-auto-review` | 自动权限审查，支持宿主配置的 chat 模型及可选 decision 分类模型 |
| [`opencode-recall`](./packages/opencode-recall) | `packages/opencode-recall` | `opencode-recall` | SQLite 历史会话语义检索，使用本地 GGUF 向量模型，支持 Revert/Fork 去重 |
| [`opencode-a2a`](./packages/opencode-a2a) | `packages/opencode-a2a` | `opencode-a2a` | 面向 Google A2A SDK（HTTP+JSON REST binding）的通用插件，融合 `a2a-mcp-skillmap` 设计，支持多端点配置、自定义 Header/文件/环境变量 Token 认证、自动发现 `/.well-known/agent-card.json` 并将每个 skill 映射为独立工具（注入 description/tags/examples 并透传 `skillId`）、SSE 流式响应与 `contextId` 多轮对话 |

## 安装与配置

开发验证需要 Node.js 22.13+（建议 Node.js 24）、npm 和 OpenCode V2。依赖锁定验证基线为 `@opencode/plugin` 2.2.2 / OpenTUI 0.7.0；使用 TUI 内部节点的插件需要兼容的宿主版本。

从本仓库根目录执行 `npm ci`，在该目录的项目级 `opencode.jsonc` 中配置所需插件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./packages/opencode-auto-rename",
    "./packages/opencode-reask",
    "./packages/opencode-compact-before",
    "./packages/opencode-tps",
    {
      "package": "./packages/opencode-auto-review",
      "options": {
        "humanFallback": true
      }
    }
  ]
}
```

在其他项目或全局配置中加载时，路径需指向自己的安装位置。发布到 npm 后可以直接使用对应包名。
`recall` 会读取宿主历史数据库并首次下载本地向量模型；`a2a` 需要配置自己的服务。两者的配置和数据流见各自 README。

## 运行测试

```bash
npm test
npm run check
npm run check:public
npm run check:packages
```

TUI 集成测试需要 Bun 和安装好依赖的 OpenCode 源码，使用 `OPENCODE_SOURCE_DIR` 显式指定。普通单元测试使用临时数据和模拟服务。

工程复原文档保留在 `packages/opencode-recall/doc/` ，包含脱敏后的历史过程，不进入 npm 包。公开化修改依据和验证结果见 `docs/public-readiness.md` 。

## 开源协议 (License)

- 本仓库整体及所有插件遵循 **GNU General Public License v3.0 or later ([`GPL-3.0-or-later`](./LICENSE))**（[`opencode-auto-review`](./packages/opencode-auto-review) 内置的 Guardian 提示词模板源自 [`openai/codex`](https://github.com/openai/codex)，Apache-2.0）。
