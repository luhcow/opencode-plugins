import { Rpc } from "@opencode/plugin/rpc"

export type QuestionOption = {
  label: string
  description: string
}

export type QuestionItem = {
  header: string
  question: string
  multiple?: boolean
  options: QuestionOption[]
}

export type ReaskEntry = {
  index: number
  messageID: string
  toolCallID: string
  nextMessageID?: string
  status: "completed" | "cancelled" | "running"
  reanswered: boolean
  questions: QuestionItem[]
  answers: string[][]
  createdAt: number
}

export type ReaskListOutput = {
  items: ReaskEntry[]
}

export type ReaskStartInput = {
  sessionID: string
  messageID?: string
  toolCallID?: string
  index?: number
  revert?: boolean
  files?: boolean
}

export type ReaskStartOutput = {
  ok: boolean
  formID?: string
  messageID?: string
  toolCallID?: string
  index?: number
  revertedFromMessageID?: string
  error?: string
}

export type ReaskRevertInput = {
  sessionID: string
  messageID?: string
  toolCallID?: string
  index?: number
  files?: boolean
}

export type ReaskRevertOutput = {
  ok: boolean
  revertedFromMessageID?: string
  error?: string
}

export type ReaskCancelInput = {
  sessionID: string
}

export type ReaskCancelOutput = {
  ok: boolean
  message?: string
}

export const ReaskRpc = Rpc.define({
  id: "reask",
  methods: {
    list: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          items: { type: "array" },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
    start: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
          index: { type: "number" },
          revert: { type: "boolean" },
          files: { type: "boolean" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          formID: { type: "string" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
          index: { type: "number" },
          revertedFromMessageID: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    revertOnly: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
          index: { type: "number" },
          files: { type: "boolean" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          revertedFromMessageID: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    cancel: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {
    replied: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
          index: { type: "number" },
          answers: { type: "array" },
          formatted: { type: "string" },
        },
        required: ["sessionID", "messageID", "toolCallID", "index", "answers", "formatted"],
        additionalProperties: false,
      },
    },
  },
})
