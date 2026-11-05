import assert from "node:assert/strict"
import test from "node:test"
import {
  buildTitlePrompt,
  cleanGeneratedTitle,
  extractAssistantText,
  hasExplicitSessionRenameCall,
  isInternalUserMessage,
  resolveFirstTurnForRename,
} from "../src/core.ts"

test("cleanGeneratedTitle strips prefixes, quotes, markdown, and trailing periods", () => {
  assert.equal(cleanGeneratedTitle('Title: "排查 trace 服务 GCS 日志量下降告警。"'), "排查 trace 服务 GCS 日志量下降告警")
  assert.equal(cleanGeneratedTitle("## **Trace GCS log size drop**\nExtra line"), "Trace GCS log size drop")
})

test("hasExplicitSessionRenameCall detects direct tool or code-mode session_rename", () => {
  assert.equal(
    hasExplicitSessionRenameCall([
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "execute",
            state: { input: { code: 'return await tools.opencode.session_rename({ title: "x" })' } },
          },
        ],
      },
    ]),
    true,
  )
  assert.equal(
    hasExplicitSessionRenameCall([
      {
        type: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    ]),
    false,
  )
})

test("extractAssistantText joins assistant text parts and ignores tool parts", () => {
  const text = extractAssistantText([
    {
      type: "assistant",
      content: [{ type: "tool", name: "read" }],
    },
    {
      type: "assistant",
      content: [{ type: "text", text: "### 结论\n一切正常" }],
    },
  ])
  assert.equal(text, "### 结论\n一切正常")
})

test("isInternalUserMessage filters plugin synthetic notices", () => {
  assert.equal(isInternalUserMessage({ type: "user", text: "[reask]\nNotice" }), true)
  assert.equal(isInternalUserMessage({ type: "user", text: "[Image 1] 分析一下" }), false)
})

test("buildTitlePrompt includes fallback when user text is empty", () => {
  const prompt = buildTitlePrompt("", "### 一句话结论\n非故障")
  assert.match(prompt, /\[User sent an attachment\/image\]/)
  assert.match(prompt, /一句话结论/)
})

test("resolveFirstTurnForRename handles queued 2nd user message without idle between Turn 1 and Turn 2", () => {
  const messages = [
    { type: "user", text: "[Image 1] 分析一下" },
    { type: "assistant", content: [{ type: "tool", name: "skill" }] },
    { type: "system", text: "The Code Mode tool catalog has changed." },
    { type: "assistant", content: [{ type: "text", text: "### 1. 结论假设\nSSP 162 入口请求断崖下跌" }] },
    { type: "user", text: "alert-analysis 不是被禁止主动读取了吗" },
    { type: "assistant", content: [{ type: "text", text: "你说得对，这里是我越界了。" }] },
    { type: "idle", text: "" },
  ]

  // 1) Right at Turn 1 -> Turn 2 boundary (before idle is appended)
  const atBoundary = resolveFirstTurnForRename(messages.slice(0, 5), "turn-boundary")
  assert.deepEqual(atBoundary, {
    status: "ready",
    userText: "[Image 1] 分析一下",
    assistantText: "### 1. 结论假设\nSSP 162 入口请求断崖下跌",
  })

  // 2) At the first idle after Turn 2 finishes
  const atIdle = resolveFirstTurnForRename(messages, "idle")
  assert.deepEqual(atIdle, {
    status: "ready",
    userText: "[Image 1] 分析一下",
    assistantText: "### 1. 结论假设\nSSP 162 入口请求断崖下跌",
  })
})

test("resolveFirstTurnForRename skips sessions that already completed an idle before a later user turn", () => {
  const messages = [
    { type: "user", text: "[Image 1] 分析一下" },
    { type: "assistant", content: [{ type: "text", text: "第一轮回复" }] },
    { type: "idle", text: "" },
    { type: "user", text: "第二轮问题" },
    { type: "assistant", content: [{ type: "text", text: "第二轮回复" }] },
    { type: "idle", text: "" },
  ]

  assert.deepEqual(resolveFirstTurnForRename(messages, "idle"), { status: "skip" })
  assert.deepEqual(resolveFirstTurnForRename(messages, "turn-boundary"), { status: "skip" })
})

test("resolveFirstTurnForRename waits during Turn 1 tool steps on turn-boundary", () => {
  const messages = [
    { type: "user", text: "[Image 1] 分析一下" },
    { type: "assistant", content: [{ type: "tool", name: "skill" }] },
  ]

  assert.deepEqual(resolveFirstTurnForRename(messages, "turn-boundary"), { status: "wait" })
  assert.deepEqual(resolveFirstTurnForRename(messages, "idle"), { status: "wait" })
})
