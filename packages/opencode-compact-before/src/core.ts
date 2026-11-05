import { NATIVE_SUMMARY_PROMPT } from "./prompt.ts"

export type Message = {
  id: string
  type: string
  text?: string
  summary?: string
  status?: string
  command?: string
  output?: unknown
  content?: readonly unknown[]
  files?: readonly unknown[]
  skills?: readonly unknown[]
  metadata?: unknown
}

export type ModelRef = { providerID: string; id: string; variant?: string }

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? ""
}

function attachment(value: unknown): string {
  const file = record(value)
  const source = record(file.source)
  return `[Attachment: ${text(file.mime) || "file"} ${text(file.name) || text(source.uri)}]`
}

function toolContent(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value.map((item) => (record(item).type === "text" ? text(record(item).text) : attachment(item))).join("\n")
}

/** Serialize original conversation as text, like native compaction's text transcript. */
export function renderMessage(message: Message): string {
  switch (message.type) {
    case "user":
      return [
        `[User]: ${message.text ?? ""}`,
        ...(message.files ?? []).map(attachment),
        ...(message.skills ?? []).map((skill) => `[Skill]: ${text(record(skill).text)}`),
      ].join("\n")
    case "assistant":
      return (message.content ?? [])
        .map((value) => {
          const part = record(value)
          if (part.type === "text") return `[Assistant]: ${text(part.text)}`
          if (part.type !== "tool") return ""
          const state = record(part.state)
          const call = `[Tool call ${text(part.name)}]: ${json(state.input)}`
          if (state.status === "completed") return `${call}\n[Tool result]: ${toolContent(state.content)}`
          if (state.status === "error") return `${call}\n[Tool error]: ${text(record(state.error).message)}`
          return `${call}\n[Tool state]: ${text(state.status)}`
        })
        .filter(Boolean)
        .join("\n")
    case "synthetic":
    case "skill":
      return `[${message.type}]: ${message.text ?? ""}`
    case "shell":
      return `[Shell]: ${message.command ?? ""}\n${text(record(message.output).output)}`
    default:
      return ""
  }
}

export function prefixTranscript(messages: readonly Message[], beforeID: string): string {
  const index = messages.findIndex((message) => message.id === beforeID)
  if (index < 0) throw new Error(`Message not found: ${beforeID}`)
  return messages.slice(0, index).map(renderMessage).filter(Boolean).join("\n\n")
}

export function visibleHistory(messages: readonly Message[], revertID?: string): readonly Message[] {
  if (!revertID) return messages
  const index = messages.findIndex((message) => message.id === revertID)
  return index < 0 ? messages : messages.slice(0, index)
}

export function summaryPrompt(transcript: string): string {
  return `${transcript}\n\n${NATIVE_SUMMARY_PROMPT}`
}

export function errorText(error: unknown): string {
  const message = record(error).message
  return error instanceof Error ? error.message : typeof message === "string" ? message : String(error)
}
