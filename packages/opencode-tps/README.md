# opencode-tps

在 OpenCode TUI 底部状态栏（`prompt.footer.status`）实时显示当前会话的生成速度（`tok/s`）。

## 功能特性

- **流式实时估算（Streaming）**：在模型输出文本（`session.text.delta`）、思考过程（`session.reasoning.delta`）、工具参数（`session.tool.input.delta` / `session.tool.input.ended`）及压缩摘要（`session.compaction.delta`）时，以 100ms 刷新率实时计算并高亮显示 `⚡ ~XX.X tok/s`。
- **工具等待不稀释速度**：当单步模型流式输出完毕（`session.step.streamed` / `session.tool.called`）进入本地工具执行阶段时，自动锁定该步流式耗时，避免 Shell/MCP 等工具执行耗时拉低 `tok/s`。
- **官方精确 Token 自动校准**：每个 Step 结束（`session.step.ended`）后，自动使用模型返回的精确 `tokens.output + tokens.reasoning` 替换估算值，并动态校准当前会话的字符/Token 估算系数。
- **回合结束与历史会话保留显示**：回合完成后，在底部状态栏保留本轮最终精确生成速度 `XX.X tok/s`（与 OpenCode 原生 `SessionTurn.tokensPerSecond` 多步加权口径完全一致，并自动感知 `/undo` 回滚边界）。

## 安装与配置

在本仓库根目录的项目级 `opencode.jsonc` 中配置；其他项目使用实际安装位置或发布后的包名：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./packages/opencode-tps"
  ]
}
```

## 运行测试

```bash
# 单元测试
npm test -w opencode-tps

# 真实 TUI 集成测试
OPENCODE_SOURCE_DIR=../opencode npm run test:tui -w opencode-tps
```
