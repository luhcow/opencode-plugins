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

export type ReaskPrepareInput = {
  sessionID: string
  messageID?: string
  toolCallID?: string
  index?: number
  revert?: boolean
  files?: boolean
}

export type ReaskPrepareOutput = {
  ok: boolean
  formID?: string
  previousFormID?: string
  previousRevertStaged?: boolean
  messageID?: string
  toolCallID?: string
  index?: number
  questions?: QuestionItem[]
  answers?: string[][]
  revertedFromMessageID?: string
  error?: string
}

export type ReaskRevertTargetInput = {
  sessionID: string
  messageID?: string
  toolCallID?: string
  index?: number
}

export type ReaskRevertTargetOutput = {
  ok: boolean
  previousFormID?: string
  previousRevertStaged?: boolean
  revertedFromMessageID?: string
  error?: string
}

export type ReaskPendingInput = {
  formID: string
}

export type ReaskPendingOutput = {
  exists: boolean
  sessionID?: string
  revertStaged?: boolean
}

export type ReaskCompleteInput = {
  sessionID: string
  formID: string
  answer: Record<string, unknown>
}

export type ReaskCompleteOutput = {
  ok: boolean
  index?: number
  error?: string
}

export type ReaskAbortInput = {
  sessionID: string
  formID?: string
}

export type ReaskAbortOutput = {
  ok: boolean
  clearedFormID?: string
  revertStaged?: boolean
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
    prepare: {
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
          previousFormID: { type: "string" },
          previousRevertStaged: { type: "boolean" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
          index: { type: "number" },
          questions: { type: "array" },
          answers: { type: "array" },
          revertedFromMessageID: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    revertTarget: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          toolCallID: { type: "string" },
          index: { type: "number" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          previousFormID: { type: "string" },
          previousRevertStaged: { type: "boolean" },
          revertedFromMessageID: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    pending: {
      input: {
        type: "object",
        properties: {
          formID: { type: "string" },
        },
        required: ["formID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          exists: { type: "boolean" },
          sessionID: { type: "string" },
          revertStaged: { type: "boolean" },
        },
        required: ["exists"],
        additionalProperties: false,
      },
    },
    complete: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          formID: { type: "string" },
          answer: { type: "object" },
        },
        required: ["sessionID", "formID", "answer"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          index: { type: "number" },
          error: { type: "string" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    abort: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          formID: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          clearedFormID: { type: "string" },
          revertStaged: { type: "boolean" },
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
