import type {
  A2AArtifact,
  A2AMessage,
  A2ARestErrorStatus,
  A2AStreamResponse,
  A2ATask,
  A2ATaskArtifactUpdateEvent,
  A2ATaskStatusUpdateEvent,
} from "./types.ts"

export const DEFAULT_MAX_SSE_EVENT_SIZE_BYTES = 4 * 1024 * 1024 // 4 MiB

export interface ParsedSseFrame {
  type: string
  data: string
  id?: string
}

function stripOptionalLeadingSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value
}

async function* readTextStream(stream: ReadableStream<string>): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * Parses a standard Server-Sent Events (SSE) `Response` into `{ type, data, id }` frames.
 */
export async function* parseSseResponse(
  response: Response,
  maxEventSizeBytes: number = DEFAULT_MAX_SSE_EVENT_SIZE_BYTES,
): AsyncGenerator<ParsedSseFrame, void, undefined> {
  if (!response.body) {
    throw new Error("SSE response body is empty.")
  }

  let buffer = ""
  let eventType = "message"
  let eventData = ""
  let eventId: string | undefined
  let skipLeadingLf = false

  const textStream = response.body.pipeThrough(new TextDecoderStream())

  for await (const chunk of readTextStream(textStream)) {
    if (chunk === "") continue
    buffer += skipLeadingLf && chunk.startsWith("\n") ? chunk.slice(1) : chunk
    skipLeadingLf = false

    let lineEndIndex: number
    while ((lineEndIndex = buffer.search(/[\r\n]/)) >= 0) {
      if (lineEndIndex > maxEventSizeBytes) {
        throw new Error(`SSE line exceeded maximum allowed size of ${maxEventSizeBytes} bytes.`)
      }
      const line = buffer.slice(0, lineEndIndex)
      const endsWithCr = buffer[lineEndIndex] === "\r"
      const delimiterLength = endsWithCr && buffer[lineEndIndex + 1] === "\n" ? 2 : 1
      skipLeadingLf = endsWithCr && lineEndIndex + 1 === buffer.length
      buffer = buffer.slice(lineEndIndex + delimiterLength)

      if (line === "") {
        if (eventData !== "") {
          yield {
            type: eventType,
            data: eventData,
            ...(eventId !== undefined ? { id: eventId } : {}),
          }
          eventType = "message"
          eventData = ""
          eventId = undefined
        }
      } else if (line.startsWith(":")) {
        // Comment / keep-alive line — ignore
      } else if (line.startsWith("event:")) {
        eventType = stripOptionalLeadingSpace(line.slice("event:".length)).trim() || "message"
      } else if (line.startsWith("id:")) {
        eventId = stripOptionalLeadingSpace(line.slice("id:".length))
      } else if (line.startsWith("data:")) {
        const value = stripOptionalLeadingSpace(line.slice("data:".length))
        eventData = eventData === "" ? value : `${eventData}\n${value}`
        if (eventData.length > maxEventSizeBytes) {
          throw new Error(`SSE event data exceeded maximum allowed size of ${maxEventSizeBytes} bytes.`)
        }
      }
    }

    if (buffer.length > maxEventSizeBytes) {
      throw new Error(`SSE line exceeded maximum allowed size of ${maxEventSizeBytes} bytes.`)
    }
  }

  if (eventData !== "") {
    yield {
      type: eventType,
      data: eventData,
      ...(eventId !== undefined ? { id: eventId } : {}),
    }
  }
}

/**
 * Normalizes a JSON object decoded from an A2A `message:send` or `message:stream` payload
 * into the canonical `A2AStreamResponse` wrapper (`{ task?, message?, statusUpdate?, artifactUpdate?, error? }`).
 * Supports both A2A v1.0 (`StreamResponse` / `SendMessageResponse`) and bare / v0.3 discriminated shapes.
 */
export function normalizeA2AEventPayload(raw: unknown): A2AStreamResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid A2A event payload: expected JSON object.")
  }

  const obj = raw as Record<string, unknown>

  // Unwrap JSON-RPC `result` envelope if a server ever returns one
  if (obj.jsonrpc && obj.result && typeof obj.result === "object" && !Array.isArray(obj.result)) {
    return normalizeA2AEventPayload(obj.result)
  }

  // Error envelope
  if (obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)) {
    return { error: obj.error as A2ARestErrorStatus }
  }

  // Standard A2A v1.0 StreamResponse / SendMessageResponse fields
  if (obj.task && typeof obj.task === "object") {
    return { task: obj.task as A2ATask }
  }
  if (obj.message && typeof obj.message === "object") {
    return { message: obj.message as A2AMessage }
  }
  if (obj.statusUpdate && typeof obj.statusUpdate === "object") {
    return { statusUpdate: obj.statusUpdate as A2ATaskStatusUpdateEvent }
  }
  if (obj.artifactUpdate && typeof obj.artifactUpdate === "object") {
    return { artifactUpdate: obj.artifactUpdate as A2ATaskArtifactUpdateEvent }
  }

  // Protobuf TS `$case` payload wrapper (`{ payload: { $case: 'task', value: ... } }`)
  if (obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)) {
    const payload = obj.payload as { $case?: string; value?: unknown }
    if (payload.$case === "task" && payload.value) {
      return { task: payload.value as A2ATask }
    }
    if (payload.$case === "message" && payload.value) {
      return { message: payload.value as A2AMessage }
    }
    if (payload.$case === "statusUpdate" && payload.value) {
      return { statusUpdate: payload.value as A2ATaskStatusUpdateEvent }
    }
    if (payload.$case === "artifactUpdate" && payload.value) {
      return { artifactUpdate: payload.value as A2ATaskArtifactUpdateEvent }
    }
  }

  // v0.3 `kind` discriminator or bare objects
  const kind = typeof obj.kind === "string" ? obj.kind : undefined
  if (kind === "status-update" || (obj.taskId && obj.status && !obj.id)) {
    return { statusUpdate: obj as unknown as A2ATaskStatusUpdateEvent }
  }
  if (kind === "artifact-update" || (obj.taskId && obj.artifact && !obj.id)) {
    const artifact = obj.artifact as A2AArtifact
    return {
      artifactUpdate: {
        ...(obj as unknown as A2ATaskArtifactUpdateEvent),
        artifact,
      },
    }
  }
  if (kind === "task" || (typeof obj.id === "string" && obj.status && typeof obj.status === "object")) {
    return { task: obj as unknown as A2ATask }
  }
  if (kind === "message" || (Array.isArray(obj.parts) && (obj.role || obj.messageId))) {
    return { message: obj as unknown as A2AMessage }
  }

  throw new Error(`Unrecognized A2A response payload keys: ${Object.keys(obj).join(", ")}`)
}
