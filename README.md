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

开发验证需要 Node.js 22.13+（建议 Node.js 24）、npm 和 OpenCode V2。依赖锁定验证基线为 `@opencode/plugin` 2.2.5 / OpenTUI 0.8.0（同时兼容 `@opencode/plugin` 2.2.2+ / OpenTUI 0.7+）；使用 TUI 内部节点的插件需要兼容的宿主版本。

### 从 GitHub 安装

仓库已公开，可直接引用 `v0.1.0` 标签下的插件子目录。在全局 `~/.config/opencode/opencode.jsonc` 或项目级 `opencode.jsonc` 中配置所需插件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:luhcow/opencode-plugins#v0.1.0::path:packages/opencode-auto-rename",
    "github:luhcow/opencode-plugins#v0.1.0::path:packages/opencode-reask",
    "github:luhcow/opencode-plugins#v0.1.0::path:packages/opencode-compact-before",
    "github:luhcow/opencode-plugins#v0.1.0::path:packages/opencode-tps",
    {
      "package": "github:luhcow/opencode-plugins#v0.1.0::path:packages/opencode-auto-review",
      "options": {
        "humanFallback": true
      }
    }
  ]
}
```

另外两个插件可按需添加：

- [`recall`](./packages/opencode-recall)：`github:luhcow/opencode-plugins#v0.1.0::path:packages/opencode-recall` ，会读取宿主历史数据库并首次下载本地向量模型。
- [`a2a`](./packages/opencode-a2a)：`github:luhcow/opencode-plugins#v0.1.0::path:packages/opencode-a2a` ，需在 `options.agents` 中配置自己的服务。

`::path:` 用于选择 Monorepo 内的插件包，不能省略。以上 Git 引用可直接安装，无需等待 npm 发布。完整配置和数据流见各插件 README。

### 本地开发

克隆本仓库并在根目录执行 `npm ci` ，将项目级配置中的 Git 引用换为对应的 `./packages/opencode-<name>` 目录。相对路径以配置文件所在目录解析；全局配置需填写指向实际 checkout 的路径。

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
