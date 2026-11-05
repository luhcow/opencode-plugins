# opencode-auto-review

基于 OpenAI Codex **Guardian V2**（`decisions.rs` + `guardian-context` + `guardian-reviewer`）架构实现的 OpenCode V2 自动权限审查插件。

## 核心设计（对齐 Codex Guardian）

1. **可选的一阶段分类（支持 `/v1/decisions` 的模型）**
   - `input`：按 Codex `TranscriptFormat::Line` 格式组装的完整用户指令、受限近期工具上下文与 `Planned action JSON`（无状态、无需读写本地 `storage` 账本）。
   - `questions`：仅单题 `guardian_risk`（`"low"` | `"high"`），分类准则（Rubric）直接内置 Codex `classifier_instructions.md` + `policy.md` 并放入 `questions[0].instructions`。
   - **6 秒硬超时**，响应解析仅读取 `answers[0].choice`（不设人为 `confidence` 门槛，彻底避免跨题互锁误报）：
     - `choice === "low"` $\rightarrow$ 立即自动放行（`allow`）。
     - `choice === "high"` $\rightarrow$ 升级至二级同步复核模型（若配置了 `reviewModel`），或根据 `humanFallback` 交由用户确认 / 拒绝。
2. **二阶段同步复核（默认自动继承当前对话模型）**
   - 对齐 Codex `guardian-reviewer/src/model.rs`（`select_review_model`）与 `assessment.rs`：
   - 当一阶段 `decision` 模型判为 `"high"`（或超时）时，**默认自动继承当前会话 Assistant 正在使用的对话模型**（如果该模型支持 `#low` 推理档位则自动优先选用 `#low`），无需手动硬编码第二个模型；也可通过 `reviewModel` 显式指定或设为 `"none"` 关闭二级复核。
   - 使用宽容 JSON 解析器提取 `{"outcome": "allow" | "deny", "risk_level": ..., "user_authorization": ..., "rationale": ...}`（仅 `outcome` 必填）。

## 配置示例

在全局 `~/.config/opencode/opencode.jsonc` 或项目级 `opencode.jsonc` 中引用公开仓库的发布标签：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:luhcow/opencode-plugins#v0.1.0::path:packages/opencode-auto-review",
      "options": {
        // model 省略时直接继承当前对话模型（并优先使用 #low 档位）
        // reviewModel 省略时默认自动继承当前对话模型（并优先使用 #low 档位）
        "humanFallback": true
      }
    }
  ]
}
```

本地开发时，在仓库根目录执行 `npm ci` ，并在该目录的项目配置中改用 `./packages/opencode-auto-review` 。相对路径以配置文件所在目录解析。
`model` / `reviewModel` 支持宿主中可用的 `provider/model[#variant]`，不依赖特定提供商。
主模型是 chat 类型时直接进行同步复核。审查会将用户指令、近期工具上下文和待执行操作发送给选定模型。
`humanFallback` 默认 `false`（无法判定时拒绝）；上例设为 `true` 时转为人工确认。

## 许可证

GPL-3.0-or-later（Guardian 提示词模板源自 `openai/codex`，Apache-2.0）。
