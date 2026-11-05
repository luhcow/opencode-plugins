import type { QuestionItem, QuestionOption, ReaskEntry } from "./rpc.ts"

export const NOTICE_PREFIX = "[reask]"
export const WAKE_PREFIX = "[reask-wake]"

export type StoredOverride = {
  messageID: string
  toolCallID: string
  questions: QuestionItem[]
  answers: string[][]
  formatted: string
  updatedAt: number
}

export type SessionOverrides = Record<string, StoredOverride>

export type RawToolPart = {
  type?: string
  id?: string
  name?: string
  time?: {
    created?: number
    ran?: number
    completed?: number
  }
  state?: {
    status?: string
    input?: unknown
    content?: Array<{ type?: string; text?: string }>
    metadata?: {
      answers?: unknown
    }
    error?: {
      message?: string
    }
  }
}

export type RawSessionMessage = {
  id?: string
  type?: string
  text?: string
  description?: string
  metadata?: Record<string, unknown>
  time?: {
    created?: number
    completed?: number
  }
  content?: unknown
}

export type ModelMessagePart = {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  result?: unknown
  resultType?: string
  isFailure?: boolean
}

export type ModelMessage = {
  id?: string
  role?: string
  content?: unknown
}

export function makeKey(messageID: string, toolCallID: string): string {
  return `${messageID}:${toolCallID}`
}

export function clip(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 1) + "…"
}

export function isInternalText(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith(NOTICE_PREFIX) || trimmed.startsWith(WAKE_PREFIX)
}

export function isInternalSyntheticMessage(msg: RawSessionMessage): boolean {
  if (msg.type !== "synthetic") return false
  const text = typeof msg.text === "string" ? msg.text : ""
  if (isInternalText(text)) return true
  return msg.metadata?.source === "reask"
}

export function formatQuestionAnswer(questions: QuestionItem[], answers: string[][]): string {
  return `User has answered your questions: ${questions
    .map((q, idx) => `"${q.question}"="${answers[idx]?.length ? answers[idx].join(", ") : "Unanswered"}"`)
    .join(", ")}. You can now continue with the user's answers in mind.`
}

export function normalizeQuestions(input: unknown): QuestionItem[] {
  if (!input || typeof input !== "object") return []
  const rawQuestions = (input as { questions?: unknown }).questions
  if (!Array.isArray(rawQuestions)) return []
  return rawQuestions.flatMap((item): QuestionItem[] => {
    if (!item || typeof item !== "object") return []
    const rec = item as {
      header?: unknown
      question?: unknown
      multiple?: unknown
      options?: unknown
    }
    const question = typeof rec.question === "string" ? rec.question : ""
    const header = typeof rec.header === "string" ? rec.header : question.slice(0, 24) || "Question"
    if (!question) return []
    const options: QuestionOption[] = Array.isArray(rec.options)
      ? rec.options.flatMap((opt): QuestionOption[] => {
          if (!opt || typeof opt !== "object") return []
          const o = opt as { label?: unknown; description?: unknown }
          if (typeof o.label !== "string" || !o.label) return []
          return [
            {
              label: o.label,
              description: typeof o.description === "string" ? o.description : "",
            },
          ]
        })
      : []
    return [
      {
        header,
        question,
        ...(rec.multiple === true ? { multiple: true } : {}),
        options,
      },
    ]
  })
}

export function normalizeAnswers(raw: unknown, count: number): string[][] {
  if (!Array.isArray(raw)) return Array.from({ length: count }, () => [])
  return Array.from({ length: count }, (_, idx) => {
    const entry = raw[idx]
    if (Array.isArray(entry)) {
      return entry.filter((v): v is string => typeof v === "string" && v.length > 0)
    }
    if (typeof entry === "string" && entry.length > 0) {
      return [entry]
    }
    return []
  })
}

export function buildFormFields(questions: QuestionItem[], previousAnswers: string[][]) {
  return questions.map((q, index) => {
    const prev = previousAnswers[index] ?? []
    const options = q.options.map((opt) => ({
      value: opt.label,
      label: opt.label,
      description: opt.description,
    }))
    if (q.multiple === true) {
      return {
        key: `q${index}`,
        title: q.header,
        description: q.question,
        type: "multiselect" as const,
        options,
        custom: true,
        ...(prev.length > 0 ? { default: prev } : {}),
      }
    }
    return {
      key: `q${index}`,
      title: q.header,
      description: q.question,
      type: "string" as const,
      options,
      custom: true,
      ...(prev[0] ? { default: prev[0] } : {}),
    }
  })
}

export function unwrapMessages(value: unknown): RawSessionMessage[] {
  if (Array.isArray(value)) return value as RawSessionMessage[]
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: RawSessionMessage[] }).data
  }
  return []
}

export function extractEntries(messages: RawSessionMessage[], overrides: SessionOverrides): ReaskEntry[] {
  const entries: ReaskEntry[] = []
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const message = messages[msgIdx]
    if (!message || message.type !== "assistant" || !message.id || !Array.isArray(message.content)) continue

    let nextMessageID: string | undefined
    for (let nextIdx = msgIdx + 1; nextIdx < messages.length; nextIdx++) {
      const candidate = messages[nextIdx]
      if (!candidate?.id) continue
      if (isInternalSyntheticMessage(candidate)) continue
      nextMessageID = candidate.id
      break
    }
    if (!nextMessageID && messages[msgIdx + 1]?.id) {
      nextMessageID = messages[msgIdx + 1]?.id
    }

    for (const rawPart of message.content) {
      if (!rawPart || typeof rawPart !== "object") continue
      const part = rawPart as RawToolPart
      if (part.type !== "tool" || part.name?.toLowerCase() !== "question" || !part.id) continue

      const questions = normalizeQuestions(part.state?.input)
      if (questions.length === 0) continue

      const key = makeKey(message.id, part.id)
      const override = overrides[key]
      const rawStatus = part.state?.status
      const status: "completed" | "cancelled" | "running" = override
        ? "completed"
        : rawStatus === "completed"
          ? "completed"
          : rawStatus === "running" || rawStatus === "streaming"
            ? "running"
            : "cancelled"

      const answers = override
        ? normalizeAnswers(override.answers, questions.length)
        : normalizeAnswers(part.state?.metadata?.answers, questions.length)

      entries.push({
        index: entries.length + 1,
        messageID: message.id,
        toolCallID: part.id,
        nextMessageID,
        status,
        reanswered: Boolean(override),
        questions,
        answers,
        createdAt: part.time?.created ?? message.time?.created ?? Date.now(),
      })
    }
  }
  return entries
}

export function extractTextFromModelContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return ""
      const rec = part as { type?: string; text?: string }
      return rec.type === "text" && typeof rec.text === "string" ? rec.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

export function applyContextOverrides(messages: ModelMessage[], overrides: SessionOverrides): void {
  // 1. Strip internal wake/notice synthetic messages so model context stays clean
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== "user") continue
    const text = extractTextFromModelContent(msg.content)
    if (text && isInternalText(text)) {
      messages.splice(i, 1)
    }
  }

  const overrideList = Object.values(overrides)
  if (overrideList.length === 0) return

  const byToolCallID = new Map<string, StoredOverride>()
  for (const item of overrideList) {
    byToolCallID.set(item.toolCallID, item)
  }

  const appliedToolCallIDs = new Set<string>()

  // 2. Rewrite existing tool-result parts matching overridden toolCallIDs
  for (const msg of messages) {
    if (msg?.role !== "tool" || !Array.isArray(msg.content)) continue
    for (let i = 0; i < msg.content.length; i++) {
      const part = msg.content[i] as ModelMessagePart | undefined
      if (!part || part.type !== "tool-result" || typeof part.id !== "string") continue
      const override = byToolCallID.get(part.id)
      if (!override) continue
      const updatedPart: Record<string, unknown> = {
        ...part,
        type: "tool-result",
        id: override.toolCallID,
        name: part.name || "question",
        result: {
          type: "text",
          value: override.formatted,
        },
      }
      delete updatedPart.resultType
      delete updatedPart.isFailure
      msg.content[i] = updatedPart
      appliedToolCallIDs.add(override.toolCallID)
    }
  }

  // 3. If an assistant tool-call had no tool-result (e.g. interrupted before settle), inject it right after
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue
    for (const rawPart of msg.content) {
      const part = rawPart as ModelMessagePart | undefined
      if (!part || part.type !== "tool-call" || typeof part.id !== "string") continue
      const override = byToolCallID.get(part.id)
      if (!override || appliedToolCallIDs.has(override.toolCallID)) continue

      const toolResultPart = {
        type: "tool-result",
        id: override.toolCallID,
        name: part.name || "question",
        result: {
          type: "text",
          value: override.formatted,
        },
      }

      const nextMsg = messages[i + 1]
      if (nextMsg?.role === "tool" && Array.isArray(nextMsg.content)) {
        nextMsg.content.push(toolResultPart)
      } else {
        messages.splice(i + 1, 0, {
          role: "tool",
          content: [toolResultPart],
        })
      }
      appliedToolCallIDs.add(override.toolCallID)
    }
  }
}
