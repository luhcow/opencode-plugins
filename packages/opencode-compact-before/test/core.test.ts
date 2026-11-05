import { test } from "node:test"
import assert from "node:assert/strict"
import {
  activeCheckpointID,
  findCheckpoint,
  prefixTranscript,
  resolveCheckpoint,
  visibleHistory,
  type Message,
} from "../src/core.ts"

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

test("resolves compact-before, native keepID, whole-summary, legacy recent, and provider checkpoints", () => {
  assert.deepEqual(
    resolveCheckpoint({
      id: "msg_cb",
      type: "compaction",
      status: "completed",
      summary: "## Objective\nPlugin boundary",
      metadata: { keepID: "msg_user_2", compactBefore: { beforeID: "msg_user_2", requestID: "msg_cb" } },
    }),
    {
      kind: "boundary",
      id: "msg_cb",
      summary: "## Objective\nPlugin boundary",
      beforeID: "msg_user_2",
      source: "compact-before",
    },
  )

  assert.deepEqual(
    resolveCheckpoint({
      id: "msg_native_keep",
      type: "compaction",
      status: "completed",
      summary: "## Objective\nNative summary with keepID",
      metadata: { keepID: "msg_assistant_3" },
    }),
    {
      kind: "boundary",
      id: "msg_native_keep",
      summary: "## Objective\nNative summary with keepID",
      beforeID: "msg_assistant_3",
      source: "native",
    },
  )

  assert.deepEqual(
    resolveCheckpoint({
      id: "msg_whole",
      type: "compaction",
      status: "completed",
      summary: "## Objective\nWhole conversation summary",
    }),
    {
      kind: "summary",
      id: "msg_whole",
      summary: "## Objective\nWhole conversation summary",
      source: "native",
    },
  )

  assert.deepEqual(
    resolveCheckpoint({
      id: "msg_legacy",
      type: "compaction",
      status: "completed",
      summary: "## Objective\nLegacy summary",
      metadata: { recent: "[User]: kept tail" },
    }),
    {
      kind: "summary",
      id: "msg_legacy",
      summary: "## Objective\nLegacy summary",
      source: "native",
      recent: "[User]: kept tail",
    },
  )

  assert.deepEqual(
    resolveCheckpoint({
      id: "msg_provider",
      type: "compaction",
      status: "completed",
      summary: "",
      native: { messages: [{ role: "user", content: "window" }] },
      metadata: { keepID: "msg_ignored" },
    }),
    {
      kind: "provider",
      id: "msg_provider",
    },
  )

  assert.equal(
    resolveCheckpoint({
      id: "msg_running",
      type: "compaction",
      status: "running",
      summary: "## Objective\nIn progress",
      metadata: { keepID: "msg_user_2" },
    }),
    undefined,
  )
  assert.equal(
    resolveCheckpoint({
      id: "msg_empty",
      type: "compaction",
      status: "completed",
      summary: "   ",
      metadata: { keepID: "msg_user_2" },
    }),
    undefined,
  )
})

test("selects active completed checkpoint in visible history and ignores failed or reverted compactions", () => {
  const messages: Message[] = [
    { id: "msg_1", type: "user", text: "First" },
    { id: "msg_2", type: "compaction", status: "completed", summary: "First checkpoint" },
    { id: "msg_3", type: "user", text: "Second" },
    { id: "msg_4", type: "compaction", status: "completed", summary: "Second checkpoint" },
    { id: "msg_5", type: "compaction", status: "failed", summary: "" },
    { id: "msg_6", type: "compaction", status: "running", summary: "Streaming" },
  ]
  assert.equal(activeCheckpointID(messages), "msg_4")
  assert.equal(activeCheckpointID(messages, "msg_3"), "msg_2")
  assert.equal(activeCheckpointID(messages, "msg_2"), undefined)

  const descending = [...messages].reverse()
  assert.equal(findCheckpoint(descending, "msg_2")?.id, "msg_2")
  assert.equal(findCheckpoint(descending, "msg_5"), undefined)
})
