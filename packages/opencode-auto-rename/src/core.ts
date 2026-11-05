export const STORAGE_KEY = "renamed_sessions"
export const MAX_STORED_SESSIONS = 500
export const MAX_USER_CHARS = 1_500
export const MAX_ASSISTANT_CHARS = 3_000
export const MAX_TITLE_CHARS = 100

export type RawPart = {
  type?: string
  text?: string
  name?: string
  state?: {
    input?: unknown
  }
}

export type RawSessionMessage = {
  id?: string
  type?: string
  text?: string
  metadata?: Record<string, unknown>
  content?: unknown
}

export type SessionInfo = {
  id: string
  parentID?: string
  title?: string
  model?: {
    providerID: string
    id: string
    variant?: string
  }
}

export function clip(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit) + "…"
}

export function unwrapData<T>(value: unknown): T | undefined {
  if (!value || typeof value !== "object") return undefined
  if ("data" in (value as Record<string, unknown>) && (value as { data?: unknown }).data !== undefined) {
    return (value as { data: T }).data
  }
  return value as T
}

export function unwrapMessages(value: unknown): RawSessionMessage[] {
  if (Array.isArray(value)) return value as RawSessionMessage[]
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: RawSessionMessage[] }).data
  }
  return []
}

export function unwrapText(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  const record = value as { text?: unknown; data?: { text?: unknown } }
  if (typeof record.text === "string") return record.text
  if (typeof record.data?.text === "string") return record.data.text
  return ""
}

export function isInternalUserMessage(msg: RawSessionMessage): boolean {
  if (msg.type !== "user") return true
  const text = (msg.text ?? "").trimStart()
  return text.startsWith("[summarize-at]") || text.startsWith("[reask]") || text.startsWith("[reask-wake]")
}

export function hasExplicitSessionRenameCall(messages: RawSessionMessage[]): boolean {
  for (const msg of messages) {
    if (msg.type !== "assistant" || !Array.isArray(msg.content)) continue
    for (const rawPart of msg.content) {
      if (!rawPart || typeof rawPart !== "object") continue
      const part = rawPart as RawPart
      if (part.type !== "tool") continue
      const toolName = (part.name ?? "").toLowerCase()
      if (toolName.includes("session_rename")) return true
      if (toolName === "execute" && part.state?.input && typeof part.state.input === "object") {
        const code = (part.state.input as { code?: unknown }).code
        if (typeof code === "string" && code.includes("session_rename")) return true
      }
    }
  }
  return false
}

export function extractAssistantText(messages: RawSessionMessage[]): string {
  const chunks: string[] = []
  for (const msg of messages) {
    if (msg.type !== "assistant" || !Array.isArray(msg.content)) continue
    for (const rawPart of msg.content) {
      if (!rawPart || typeof rawPart !== "object") continue
      const part = rawPart as RawPart
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim())
      }
    }
  }
  return chunks.join("\n\n")
}

export type FirstTurnResolution =
  | { status: "wait" }
  | { status: "skip" }
  | { status: "ready"; userText: string; assistantText: string }

export function resolveFirstTurnForRename(
  messages: RawSessionMessage[],
  trigger: "idle" | "turn-boundary" = "idle",
): FirstTurnResolution {
  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg && msg.type === "user" && !isInternalUserMessage(msg)) {
      userIndices.push(i)
    }
  }

  if (userIndices.length === 0) {
    return { status: "wait" }
  }

  const firstUserIdx = userIndices[0]!
  const secondUserIdx = userIndices[1] ?? -1

  let firstIdleIdx = -1
  for (let i = firstUserIdx + 1; i < messages.length; i++) {
    if (messages[i]?.type === "idle") {
      firstIdleIdx = i
      break
    }
  }

  // If the session already went idle in the past and has a subsequent user turn after that idle,
  // its first-turn window has already passed.
  if (firstIdleIdx !== -1 && userIndices.some((u) => u > firstIdleIdx)) {
    return { status: "skip" }
  }

  // On a turn-boundary (context hook), only trigger once a queued 2nd user message has started
  // right after Turn 1 (before Turn 1 is still in progress when secondUserIdx === -1).
  if (trigger === "turn-boundary" && secondUserIdx === -1) {
    return { status: "wait" }
  }

  const firstBlockEnd = firstIdleIdx !== -1 ? firstIdleIdx : messages.length
  const firstBlockSlice = messages.slice(firstUserIdx, firstBlockEnd)

  if (hasExplicitSessionRenameCall(firstBlockSlice)) {
    return { status: "skip" }
  }

  const firstTurnEnd =
    secondUserIdx !== -1 ? secondUserIdx : firstIdleIdx !== -1 ? firstIdleIdx : messages.length
  const firstTurnSlice = messages.slice(firstUserIdx, firstTurnEnd)

  let assistantText = extractAssistantText(firstTurnSlice)
  if (!assistantText && trigger === "idle") {
    assistantText = extractAssistantText(firstBlockSlice)
  }

  if (!assistantText) {
    return { status: "wait" }
  }

  const userText = messages[firstUserIdx]?.text ?? ""
  return {
    status: "ready",
    userText,
    assistantText,
  }
}

export function cleanGeneratedTitle(raw: string): string {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return ""
  const cleaned = firstLine
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^["'`“”‘’*]+|["'`“”‘’*。.]+$/g, "")
    .trim()
  if (!cleaned) return ""
  return cleaned.length <= MAX_TITLE_CHARS ? cleaned : `${cleaned.slice(0, MAX_TITLE_CHARS - 3)}...`
}

export function buildTitlePrompt(userText: string, assistantText: string): string {
  const normalizedUser = userText.trim() || "[User sent an attachment/image]"
  return [
    "You name conversations so the user can find them later in a list of past sessions.",
    "Based on the user's first request and the assistant's first response below, generate a concise, specific title for this session.",
    "",
    "Rules:",
    "- Reply with ONLY the title on a single line (no quotes, no markdown formatting, no 'Title:' prefix, no trailing period).",
    "- Use the same language as the conversation (e.g. Chinese if the conversation is in Chinese).",
    "- Keep it concise (around 8-24 Chinese characters or 3-6 English words).",
    "- Name the specific subject, service, alert, file, issue, or conclusion from the assistant's response rather than generic phrases like '分析一下' or 'Image analysis'.",
    "",
    "<conversation>",
    `User: ${clip(normalizedUser, MAX_USER_CHARS)}`,
    "",
    `Assistant: ${clip(assistantText, MAX_ASSISTANT_CHARS)}`,
    "</conversation>",
    "",
    "Reply with only the title.",
  ].join("\n")
}
