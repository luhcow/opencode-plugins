# opencode-compact-before

纯插件：选择一条用户消息，将它之前的历史生成摘要并保存为 OpenCode 原生检查点。

## 使用

- `/compact-before` 或 `Ctrl+Alt+C` 打开消息列表。
- 选择消息后直接提交压缩；选中的消息及之后的对话保留。
- 有未确认的撤销时，列表沿用撤销后的有效历史；提交压缩时由原生流程确认撤销。

压缩成功后，TUI 会将当前摘要显示在所选消息之前，并标明“以上历史已总结”和
“从下面这条消息开始保留在上下文中”。旧会话中的检查点会随原生历史加载、翻页自动定位。
再次压缩后显示新的边界；停用插件后恢复原生时间线显示。

在 `opencode.jsonc` 的 `plugins` 中加入本目录，即可加载 server 和 TUI 两部分。

## 实现

TUI 按原生 API 游标读取历史，定位选中消息之前的文本，完整提交给 server。
server 保存该次选择并调用 `session.compact({ id })`。匹配这次请求的 compaction hook
使用原生选定的模型、原版摘要提示词，通过 `experimental.generate.text` 一次生成摘要，
再返回 `result.summary` 和 `metadata.keepID` 交给 OpenCode 保存。

插件不设置摘要字数或字节上限、字符目标、分块大小、重试次数和预留预算，
也不添加会话忙、回滚变化、检查点状态等拦截。请求合并、模型错误和原生压缩错误由 OpenCode 处理。
消息 ID 匹配用于定位本次选择，不改写其他压缩请求。

原位显示通过 TUI 内部渲染节点实现：文字消息的行 ID、附件消息的相邻用户行位置、
原生 Compaction 标题及 Markdown 节点用于定位。摘要仍是同一个原生检查点，显示移动不写入消息。
摘要读取由原生时间线中的已完成压缩记录触发，不在新会话的乐观创建阶段提前查询服务端。
这是用户确认采用的内部接口适配方式，当前按 OpenCode 2.2.x 的节点结构验证。

`src/prompt.ts` 使用 OpenCode 2.2.0 的 `buildPrompt(false)` 原文，测试会逐字比较。
`keepID` 是当前原生实现的保留起点约定；原生保留区以历史文本形式发送，工具输出与附件按原生规则处理。
原始记录仍保存在会话中。

## 开发验证

`npm test` 运行逻辑测试。真实 TUI 回归测试：

```sh
OPENCODE_SOURCE_DIR=/path/to/opencode bun run test:tui
```

源码目录只用于开发测试，安装和使用插件不依赖它。
