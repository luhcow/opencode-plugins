import { test } from "node:test"
import assert from "node:assert/strict"
import { prefixTranscript, visibleHistory, type Message } from "../src/core.ts"

test("selects an exclusive message ID boundary and serializes complete text without binary/reasoning", () => {
  const large = "important tool output ".repeat(300)
  const messages: Message[] = [
    {
      id: "msg_1",
      type: "user",
      text: "identical text",
      files: [{ mime: "image/png", name: "image.png", data: "PRIVATE_BASE64" }],
    },
    {
      id: "msg_2",
      type: "assistant",
      content: [
        { type: "reasoning", text: "PRIVATE_REASONING" },
        { type: "text", text: "Earlier answer" },
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { path: "code.ts" },
            content: [{ type: "text", text: large }],
          },
        },
      ],
    },
    { id: "msg_3", type: "compaction", summary: "OLD_CHECKPOINT" },
    { id: "msg_4", type: "user", text: "identical text" },
    {
      id: "msg_5",
      type: "assistant",
      content: [{ type: "text", text: "KEPT_ANSWER" }],
    },
  ]
  const transcript = prefixTranscript(messages, "msg_4")
  assert.match(transcript, /image.png/)
  assert.ok(transcript.includes(large))
  assert.equal(transcript.match(/identical text/g)?.length, 1)
  for (const excluded of ["PRIVATE_BASE64", "PRIVATE_REASONING", "OLD_CHECKPOINT", "KEPT_ANSWER"]) {
    assert.ok(!transcript.includes(excluded))
  }
  assert.equal(prefixTranscript(messages, "msg_1"), "")
  assert.throws(() => prefixTranscript(messages, "msg_missing"), /Message not found/)
})

test("staged reverts exclude the boundary and its tail from selectable and summarized history", () => {
  const messages: Message[] = [
    { id: "msg_1", type: "user", text: "Earlier" },
    { id: "msg_2", type: "user", text: "Kept" },
    { id: "msg_3", type: "assistant", content: [{ type: "text", text: "UNDONE" }] },
    { id: "msg_4", type: "user", text: "Also undone" },
  ]
  const visible = visibleHistory(messages, "msg_3")
  assert.deepEqual(
    visible.map((message) => message.id),
    ["msg_1", "msg_2"],
  )
  assert.ok(!prefixTranscript(visible, "msg_2").includes("UNDONE"))
  assert.throws(() => prefixTranscript(visible, "msg_4"), /Message not found/)
  assert.equal(visibleHistory(messages, "msg_missing"), messages)
})
