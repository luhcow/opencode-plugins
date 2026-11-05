import assert from "node:assert/strict"
import test from "node:test"
import {
  NOTICE_PREFIX,
  WAKE_PREFIX,
  applyContextOverrides,
  buildFormFields,
  extractEntries,
  formatQuestionAnswer,
  makeKey,
  type ModelMessage,
  type RawSessionMessage,
  type SessionOverrides,
} from "../src/core.ts"

test("formatQuestionAnswer matches OpenCode native question tool output", () => {
  const questions = [
    {
      header: "Mode",
      question: "Which mode should we use?",
      options: [
        { label: "Fast", description: "Run quickly" },
        { label: "Safe", description: "Run with checks" },
      ],
    },
    {
      header: "Targets",
      question: "Select targets",
      multiple: true,
      options: [
        { label: "Server", description: "Server plugin" },
        { label: "TUI", description: "TUI plugin" },
      ],
    },
  ]

  const formatted = formatQuestionAnswer(questions, [["Safe"], ["Server", "TUI"]])
  assert.equal(
    formatted,
    'User has answered your questions: "Which mode should we use?"="Safe", "Select targets"="Server, TUI". You can now continue with the user\'s answers in mind.',
  )
})

test("buildFormFields pre-populates single and multiselect defaults", () => {
  const questions = [
    {
      header: "Mode",
      question: "Choose mode",
      options: [{ label: "A", description: "Option A" }],
    },
    {
      header: "Extras",
      question: "Choose extras",
      multiple: true,
      options: [
        { label: "X", description: "Option X" },
        { label: "Y", description: "Option Y" },
      ],
    },
  ]

  const fields = buildFormFields(questions, [["Custom answer"], ["X", "Y"]])
  assert.equal(fields.length, 2)
  assert.equal(fields[0]?.type, "string")
  assert.equal(fields[0]?.default, "Custom answer")
  assert.equal(fields[1]?.type, "multiselect")
  assert.deepEqual(fields[1]?.default, ["X", "Y"])
})

test("extractEntries extracts both completed and cancelled question calls and skips internal notices", () => {
  const messages: RawSessionMessage[] = [
    { id: "msg_1", type: "user", text: "Hello" },
    {
      id: "msg_2",
      type: "assistant",
      time: { created: 1000 },
      content: [
        {
          type: "tool",
          id: "call_q1",
          name: "question",
          state: {
            status: "completed",
            input: {
              questions: [
                {
                  header: "Q1",
                  question: "First question?",
                  options: [{ label: "Yes", description: "Confirm" }],
                },
              ],
            },
            metadata: {
              answers: [["Yes"]],
            },
          },
        },
      ],
    },
    {
      id: "msg_notice",
      type: "synthetic",
      text: `${WAKE_PREFIX}\ninternal`,
      metadata: { source: "reask" },
    },
    {
      id: "msg_3",
      type: "assistant",
      time: { created: 2000 },
      content: [
        {
          type: "tool",
          id: "call_q2",
          name: "question",
          state: {
            status: "error",
            input: {
              questions: [
                {
                  header: "Q2",
                  question: "Second question?",
                  options: [{ label: "No", description: "Decline" }],
                },
              ],
            },
            error: { message: "The user dismissed this question" },
          },
        },
      ],
    },
    { id: "msg_4", type: "idle" },
  ]

  const entries = extractEntries(messages, {})
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.index, 1)
  assert.equal(entries[0]?.messageID, "msg_2")
  assert.equal(entries[0]?.nextMessageID, "msg_3")
  assert.equal(entries[0]?.status, "completed")
  assert.deepEqual(entries[0]?.answers, [["Yes"]])

  assert.equal(entries[1]?.index, 2)
  assert.equal(entries[1]?.messageID, "msg_3")
  assert.equal(entries[1]?.nextMessageID, "msg_4")
  assert.equal(entries[1]?.status, "cancelled")
  assert.deepEqual(entries[1]?.answers, [[]])
})

test("applyContextOverrides strips internal wake messages and rewrites errored or completed tool-results", () => {
  const questions = [
    {
      header: "Approach",
      question: "Which approach?",
      options: [{ label: "Revert", description: "Selective revert" }],
    },
  ]
  const formatted = formatQuestionAnswer(questions, [["Revert"]])
  const overrides: SessionOverrides = {
    [makeKey("msg_2", "call_q1")]: {
      messageID: "msg_2",
      toolCallID: "call_q1",
      questions,
      answers: [["Revert"]],
      formatted,
      updatedAt: 3000,
    },
  }

  const modelMessages: ModelMessage[] = [
    {
      id: "msg_1",
      role: "user",
      content: [{ type: "text", text: "Build plugin" }],
    },
    {
      id: "msg_2",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          id: "call_q1",
          name: "question",
          input: { questions },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call_q1",
          name: "question",
          resultType: "error",
          result: {
            type: "error",
            value: { message: "The user dismissed this question" },
          },
        },
      ],
    },
    {
      id: "msg_wake",
      role: "user",
      content: [{ type: "text", text: `${WAKE_PREFIX}\n${formatted}` }],
    },
    {
      id: "msg_notice",
      role: "user",
      content: [{ type: "text", text: `${NOTICE_PREFIX}\nstatus` }],
    },
  ]

  applyContextOverrides(modelMessages, overrides)

  // Wake and notice messages are stripped
  assert.equal(modelMessages.length, 3)
  const toolMsg = modelMessages[2]
  assert.equal(toolMsg?.role, "tool")
  const toolPart = (toolMsg?.content as Array<Record<string, unknown>>)[0]
  assert.equal(toolPart?.type, "tool-result")
  assert.equal(toolPart?.resultType, undefined)
  assert.deepEqual(toolPart?.result, {
    type: "text",
    value: formatted,
  })
})
