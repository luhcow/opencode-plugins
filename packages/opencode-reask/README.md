# opencode-reask

OpenCode V2 插件：支持在 **Ask（`question` 工具）提交后** 或 **问答被取消 / 对话被中断后**，通过**鼠标点击问答卡片、时间线选择弹窗、快捷键或斜杠命令**选择式回滚（Selective Revert）并重新回答 Ask。

---

## 核心特性

1. **全状态重答支持**
   - **已提交的 Ask（`completed`）**：随时修改历史问答的选项或自定义输入，自动预填上次选择的答案。
   - **已取消 / 对话中断的 Ask（`cancelled` / `interrupted`）**：当不小心按 `Esc` 取消了问答或中断了对话时，无需让模型重发问题，直接重新打开原生问答表单作答并无缝继续。
2. **原生级选择式回滚（Selective Revert）**
   - 对齐 OpenCode 原生 `/undo` 与 `/timeline` 回滚机制：重答某次 Ask 时，自动在紧随该次 Ask 的下一条消息处调用 `session.revert.stage`，恢复后续模型步骤产生的文件快照改动并隐藏后续对话。
   - 支持 **保留文件改动（Keep files）** 模式：仅回滚后续对话记录，保留磁盘文件修改。
   - 在重答表单提交前若按 `Esc` 放弃，自动调用 `session.revert.clear` 完整恢复回滚前的会话与文件状态（或使用原生 `/redo` 恢复）。
3. **原生底部表单 UI + 无缝上下文注入**
   - 调用 `session.form.create` 在 TUI 底部唤起与内置 `question` 完全一致的原生表单组件（支持单选、多选 `multiselect`、自由文本输入，并自动预选中上次答案）。
   - 提交后通过 `session.hook("context")` 将原 `question` 的 `tool-result` 原地替换为新答案（清除取消错误态）并唤醒会话继续推理，不污染模型上下文。
4. **4 种触发方式（对齐回滚对话的所有入口）**
   - **鼠标直接点击 TUI 中的问答卡片**：鼠标悬停 `# Questions`（或 `Asked N questions`）卡片自动高亮，左键点击弹出 `Question Actions` 菜单。
   - **时间线选择弹窗**：快捷键 `<leader>k` / 命令面板 `Select question (Ask) to re-answer...` / `/reask`。
   - **快速重答最近一次 Ask**：快捷键 `<leader>shift+k` / 命令面板 `Re-answer last question (Ask)` / `/reask last`。
   - **斜杠命令直接指定**：`/reask <编号> [--keep-files]`。

---

## 安装与配置

在全局 `~/.config/opencode/opencode.jsonc` 或项目级 `opencode.jsonc` 中引用公开仓库的发布标签：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:luhcow/opencode-plugins#v0.1.0::path:packages/opencode-reask"
  ]
}
```

OpenCode V2 通过包的 `exports` 自动加载 Server、TUI 和 RPC 契约。配置修改后自动重载，也可执行 `/reload` 强制重载。

本地开发时，在仓库根目录执行 `npm ci` ，并在该目录的项目配置中改用 `./packages/opencode-reask` 。相对路径以配置文件所在目录解析。

需要宿主支持 `session.revert` 和 `session.form` API。所有操作使用当前宿主连接，适用于本地、独立和远程服务。
新答案通过宿主的插件 storage 保存，并用于更新该会话的模型上下文。

---

## 使用指南

### 1. 鼠标点击问答卡片（TUI）

在会话消息流中，将鼠标移动到任意 `# Questions` 卡片（或被取消的 `Asked N questions` 行）上会显示高亮背景，左键点击即可打开 **Question Actions** 菜单：

- **Re-answer & Revert**：回滚该问答之后的对话与文件改动，并在底部弹出原生问答表单。
- **Re-answer (Keep files)**：仅回滚该问答之后的对话（保留文件修改），并弹出原生问答表单。
- **Revert only**：仅回滚到该问答之后，不立即打开表单（可用 `/redo` 恢复）。
- **View details**：查看完整问题、选项描述与当前回答。

### 2. 快捷键与命令面板

| 命令 ID | 默认快捷键 | 命令面板标题 | 说明 |
| :--- | :--- | :--- | :--- |
| `reask.select` | `<leader>k`（默认 `Ctrl+X` 后按 `K`） | `Select question (Ask) to re-answer...` | 打开历史 Ask 选择弹窗（回车重答并回滚，`Ctrl+K` 保留文件改动重答，`Ctrl+O` 更多操作） |
| `reask.last` | `<leader>shift+k` | `Re-answer last question (Ask)` | 直接回滚到最近一次 Ask 并弹出底部问答表单 |

可在 `~/.config/opencode/cli.json` 的 `"keybinds"` 中自定义上述命令 ID 的快捷键。

### 3. 斜杠命令（`/reask`）

```text
/reask                      # 打开历史 Ask 选择弹窗
/reask last                 # 直接重新回答最近一次 Ask（含回滚）
/reask <编号>               # 重新回答第 <编号> 条 Ask（如 /reask 1）
/reask <编号> --keep-files  # 重新回答第 <编号> 条 Ask，回滚后续对话但保留磁盘文件改动
/reask list                 # 列出当前会话所有 Ask 及其状态
/reask cancel               # 取消正在进行的重答表单并恢复回滚前状态
```

---

## 目录结构

```text
opencode-reask/
├── index.ts          # Server 插件根目录入口（供本地目录加载）
├── tui.ts            # TUI 插件根目录入口（供本地目录加载）
├── rpc.ts            # RPC 契约根目录入口（供本地目录加载）
├── src/
│   ├── core.ts       # 核心纯函数（问答提取、表单构建、答案格式化、上下文重写）
│   ├── rpc.ts        # OpenCode Plugin RPC 定义与类型
│   ├── index.ts      # Server 插件实现
│   └── tui.ts        # CLI/TUI 插件实现（快捷键、弹窗、鼠标点击拦截）
└── test/
    └── core.test.ts  # 单元测试
```

## 运行测试

```bash
npm test
```
