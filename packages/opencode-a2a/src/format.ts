import type {
  A2AArtifact,
  A2AExecutionResult,
  A2AMessage,
  A2APart,
  A2AProgressUpdate,
  A2AResponseMetadata,
  A2AStreamResponse,
  A2ATask,
  A2ATaskState,
} from "./types.ts"

export const META_THOUGHT_KEY = "adk_thought"
export const TRACE_EXTENSION_URI = "urn:x-a2a:trace:v1"

/**
 * Returns true for artifacts tagged as observability sideband (`urn:x-a2a:trace:v1`),
 * matching `a2a-mcp-skillmap` trace-artifact suppression.
 */
export function isTraceArtifact(artifact: A2AArtifact | null | undefined): boolean {
  if (!artifact || typeof artifact !== "object") return false
  return Array.isArray(artifact.extensions) && artifact.extensions.includes(TRACE_EXTENSION_URI)
}

/**
 * Extracts text from an A2A Part (supporting v1.0 `{ text }` and v0.3 `{ content: { $case: "text", value } }`).
 */
export function getPartText(part: A2APart | null | undefined): string {
  if (!part || typeof part !== "object") return ""
  if (typeof part.text === "string") return part.text
  if (part.content?.$case === "text" && typeof part.content.value === "string") {
    return part.content.value
  }
  return ""
}

/**
 * Checks if a part is tagged as chain-of-thought reasoning (`metadata.adk_thought === true`).
 */
export function isThoughtPart(part: A2APart | null | undefined): boolean {
  if (!part?.metadata || typeof part.metadata !== "object") return false
  return part.metadata[META_THOUGHT_KEY] === true
}

/**
 * Reads an explicitly configured custom content-type metadata field.
 */
export function getStructuredContentType(part: A2APart | null | undefined, mapping?: A2AResponseMetadata): string | undefined {
  if (!mapping?.contentTypeKey) return undefined
  if (!part?.metadata || typeof part.metadata !== "object") return undefined
  const raw = part.metadata[mapping.contentTypeKey]
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

/**
 * Extracts standard data parts, or JSON text with an opt-in metadata mapping.
 */
export function getPartStructuredData(part: A2APart | null | undefined, mapping?: A2AResponseMetadata): {
  contentType?: string
  mediaType?: string
  data: unknown
} | undefined {
  if (!part || typeof part !== "object") return undefined
  const contentType = getStructuredContentType(part, mapping)
  if (contentType) {
    const text = getPartText(part)
    if (text) {
      try {
        return {
          contentType,
          mediaType: part.mediaType,
          data: JSON.parse(text),
        }
      } catch {
        return {
          contentType,
          mediaType: part.mediaType,
          data: text,
        }
      }
    }
  }
  if (part.data !== undefined) {
    return {
      contentType,
      mediaType: part.mediaType,
      data: part.data,
    }
  }
  if (part.content?.$case === "data" && part.content.value !== undefined) {
    return {
      contentType,
      mediaType: part.mediaType,
      data: part.content.value,
    }
  }
  return undefined
}

/**
 * Extracts concatenated plain text from an array of A2A Parts.
 */
export function concatPartsText(
  parts: readonly (A2APart | null | undefined)[] | undefined,
  options?: { includeThoughts?: boolean; separator?: string; responseMetadata?: A2AResponseMetadata },
): string {
  if (!Array.isArray(parts) || parts.length === 0) return ""
  const includeThoughts = options?.includeThoughts ?? false
  const separator = options?.separator ?? ""
  const chunks: string[] = []
  for (const part of parts) {
    if (!part) continue
    if (!includeThoughts && isThoughtPart(part)) continue
    if (getStructuredContentType(part, options?.responseMetadata)) continue
    const text = getPartText(part)
    if (text) {
      chunks.push(text)
    } else if (typeof part.url === "string" && part.url.trim()) {
      chunks.push(`[URL: ${part.url.trim()}]`)
    }
  }
  return chunks.join(separator)
}

/**
 * Resolves the effective conversation `contextId` from a Task or Message.
 * Custom metadata is used only when explicitly configured by the user.
 */
export function extractEffectiveContextId(input: {
  task?: A2ATask | null
  message?: A2AMessage | null
  fallbackContextId?: string
  responseMetadata?: A2AResponseMetadata
}): string | undefined {
  const key = input.responseMetadata?.contextIdKey
  const customContextId = key ? input.task?.metadata?.[key] ?? input.message?.metadata?.[key] : undefined
  if (typeof customContextId === "string" && customContextId.trim()) {
    return customContextId.trim()
  }
  if (typeof input.task?.contextId === "string" && input.task.contextId.trim()) {
    return input.task.contextId.trim()
  }
  if (typeof input.message?.contextId === "string" && input.message.contextId.trim()) {
    return input.message.contextId.trim()
  }
  if (typeof input.fallbackContextId === "string" && input.fallbackContextId.trim()) {
    return input.fallbackContextId.trim()
  }
  return undefined
}

export function isInputRequiredState(state?: A2ATaskState): boolean {
  return (
    state === "TASK_STATE_INPUT_REQUIRED" ||
    state === "input-required" ||
    state === "TASK_STATE_AUTH_REQUIRED" ||
    state === "auth-required"
  )
}

export function isFailedState(state?: A2ATaskState): boolean {
  return (
    state === "TASK_STATE_FAILED" ||
    state === "failed" ||
    state === "TASK_STATE_REJECTED" ||
    state === "rejected" ||
    state === "TASK_STATE_CANCELED" ||
    state === "canceled"
  )
}

/**
 * Stateful accumulator that folds one or more `A2AStreamResponse` events
 * (from either `POST /message:stream` SSE or `POST /message:send` / `GET /tasks/{id}`)
 * into a structured `A2AExecutionResult`.
 */
export class A2AEventAccumulator {
  private readonly agentId: string
  private readonly agentName: string
  private readonly onProgress?: (update: A2AProgressUpdate) => void | Promise<void>

  private taskId?: string
  private contextId?: string
  private metadataContextId?: string
  private readonly responseMetadata?: A2AResponseMetadata
  private state?: A2ATaskState
  private lastTask?: A2ATask
  private lastMessage?: A2AMessage
  private statusText = ""
  private readonly steps: string[] = []
  private readonly artifactOrder: string[] = []
  private readonly artifactsById = new Map<
    string,
    {
      answerChunks: string[]
      thoughtChunks: string[]
      structured: Array<{ contentType?: string; mediaType?: string; data: unknown }>
    }
  >()
  private readonly messageAnswerChunks: string[] = []
  private readonly messageThoughtChunks: string[] = []
  private readonly structuredPayloads: Array<{ contentType?: string; mediaType?: string; data: unknown }> = []
  private rawEventsCount = 0

  constructor(options: {
    agentId: string
    agentName: string
    onProgress?: (update: A2AProgressUpdate) => void | Promise<void>
    responseMetadata?: A2AResponseMetadata
  }) {
    this.agentId = options.agentId
    this.agentName = options.agentName
    this.onProgress = options.onProgress
    this.responseMetadata = options.responseMetadata
  }

  get currentTaskId(): string | undefined {
    return this.taskId
  }

  get currentContextId(): string | undefined {
    return this.metadataContextId || this.contextId
  }

  private readContextMetadata(metadata?: Record<string, unknown>): void {
    const key = this.responseMetadata?.contextIdKey
    const value = key ? metadata?.[key] : undefined
    if (typeof value === "string" && value.trim()) this.metadataContextId = value.trim()
  }

  private ingestArtifact(artifact: A2AArtifact, append?: boolean): {
    answerDelta: string
    thoughtDelta: string
  } {
    const id = artifact.artifactId || `artifact_${this.artifactOrder.length + 1}`
    let entry = this.artifactsById.get(id)
    if (!entry) {
      entry = { answerChunks: [], thoughtChunks: [], structured: [] }
      this.artifactsById.set(id, entry)
      this.artifactOrder.push(id)
    } else if (append === false) {
      // Full snapshot replacement for this artifactId when append is explicitly false on an existing artifact
      entry.answerChunks = []
      entry.thoughtChunks = []
      entry.structured = []
    }

    let answerDelta = ""
    let thoughtDelta = ""

    for (const part of artifact.parts ?? []) {
      if (!part) continue
      const structured = getPartStructuredData(part, this.responseMetadata)
      if (structured) {
        entry.structured.push(structured)
        this.structuredPayloads.push(structured)
        continue
      }
      const text = getPartText(part)
      if (!text) {
        if (typeof part.url === "string" && part.url.trim()) {
          const urlLabel = `[URL: ${part.url.trim()}]`
          entry.answerChunks.push(urlLabel)
          answerDelta += urlLabel
        }
        continue
      }
      if (isThoughtPart(part)) {
        entry.thoughtChunks.push(text)
        thoughtDelta += text
      } else {
        entry.answerChunks.push(text)
        answerDelta += text
      }
    }

    return { answerDelta, thoughtDelta }
  }

  async addEvent(event: A2AStreamResponse): Promise<void> {
    this.rawEventsCount += 1

    if (event.error) {
      const code = event.error.code ?? event.error.status ?? "ERROR"
      const message = event.error.message ?? "Unknown A2A error"
      throw new Error(`A2A error (${code}): ${message}`)
    }

    if (event.task) {
      const task = event.task
      this.lastTask = task
      if (task.id) this.taskId = task.id
      if (task.contextId) this.contextId = task.contextId
      this.readContextMetadata(task.metadata)
      if (task.status?.state) {
        this.state = task.status.state
      }
      if (task.status?.message) {
        const msgText = concatPartsText(task.status.message.parts, { separator: "\n" })
        if (msgText) this.statusText = msgText
      }
      if (Array.isArray(task.artifacts) && task.artifacts.length > 0) {
        for (const artifact of task.artifacts) {
          if (artifact && !isTraceArtifact(artifact)) {
            this.ingestArtifact(artifact, false)
          }
        }
      }
      await this.onProgress?.({
        taskId: this.taskId,
        contextId: this.currentContextId,
        state: this.state,
      })
    }

    if (event.statusUpdate) {
      const su = event.statusUpdate
      if (su.taskId) this.taskId = su.taskId
      if (su.contextId) this.contextId = su.contextId
      this.readContextMetadata(su.metadata)
      if (su.status?.state) {
        this.state = su.status.state
      }
      const msgText = su.status?.message
        ? concatPartsText(su.status.message.parts, { separator: "\n" }).trim()
        : ""
      if (msgText) {
        if (su.status.state === "TASK_STATE_WORKING" || su.status.state === "working") {
          this.steps.push(msgText)
        } else {
          this.statusText = msgText
        }
      }
      await this.onProgress?.({
        taskId: this.taskId,
        contextId: this.currentContextId,
        state: this.state,
        ...(msgText ? { stepText: msgText } : {}),
      })
    }

    if (event.artifactUpdate) {
      const au = event.artifactUpdate
      if (au.taskId) this.taskId = au.taskId
      if (au.contextId) this.contextId = au.contextId
      this.readContextMetadata(au.metadata)
      if (au.artifact && !isTraceArtifact(au.artifact)) {
        // Note: in a2a-go, the first artifact event has append=false (or omitted) and subsequent updates have append=true.
        // Using `au.append ?? true` when an artifactId already exists ensures chunks are concatenated smoothly.
        const alreadyExists = Boolean(au.artifact.artifactId && this.artifactsById.has(au.artifact.artifactId))
        const shouldAppend = alreadyExists ? (au.append ?? true) : true
        const { answerDelta, thoughtDelta } = this.ingestArtifact(au.artifact, shouldAppend)
        if (answerDelta || thoughtDelta) {
          await this.onProgress?.({
            taskId: this.taskId,
            contextId: this.currentContextId,
            state: this.state,
            ...(answerDelta ? { deltaText: answerDelta } : {}),
            ...(thoughtDelta ? { thoughtDelta } : {}),
          })
        }
      }
    }

    if (event.message) {
      const msg = event.message
      this.lastMessage = msg
      if (msg.taskId) this.taskId = msg.taskId
      if (msg.contextId) this.contextId = msg.contextId
      this.readContextMetadata(msg.metadata)
      for (const part of msg.parts ?? []) {
        if (!part) continue
        const structured = getPartStructuredData(part, this.responseMetadata)
        if (structured) {
          this.structuredPayloads.push(structured)
          continue
        }
        const text = getPartText(part)
        if (!text) continue
        if (isThoughtPart(part)) {
          this.messageThoughtChunks.push(text)
        } else {
          this.messageAnswerChunks.push(text)
        }
      }
    }
  }

  buildResult(): A2AExecutionResult {
    const artifactAnswers: string[] = []
    const artifactThoughts: string[] = []

    for (const id of this.artifactOrder) {
      const entry = this.artifactsById.get(id)
      if (!entry) continue
      const ans = entry.answerChunks.join("").trim()
      if (ans) artifactAnswers.push(ans)
      const th = entry.thoughtChunks.join("").trim()
      if (th) artifactThoughts.push(th)
    }

    let answerText = artifactAnswers.join("\n\n").trim()
    if (!answerText && this.messageAnswerChunks.length > 0) {
      answerText = this.messageAnswerChunks.join("\n").trim()
    }
    if (!answerText && this.lastTask?.history?.length) {
      // Fallback: check the last agent message in task.history
      for (let i = this.lastTask.history.length - 1; i >= 0; i--) {
        const msg = this.lastTask.history[i]
        if (msg && (msg.role === "ROLE_AGENT" || msg.role === "agent")) {
          const histText = concatPartsText(msg.parts, { separator: "\n" }).trim()
          if (histText) {
            answerText = histText
            break
          }
        }
      }
    }
    if (!answerText && this.statusText) {
      answerText = this.statusText
    }

    const reasoningText = [...artifactThoughts, ...this.messageThoughtChunks].join("\n\n").trim()
    const inputRequired = isInputRequiredState(this.state)
    const inputRequiredPrompt = inputRequired ? this.statusText || answerText || undefined : undefined

    const effectiveContextId = this.currentContextId

    return {
      agentId: this.agentId,
      agentName: this.agentName,
      taskId: this.taskId,
      contextId: effectiveContextId,
      state: this.state,
      answerText,
      reasoningText,
      statusText: this.statusText,
      steps: [...this.steps],
      structuredPayloads: [...this.structuredPayloads],
      inputRequired,
      inputRequiredPrompt,
      task: this.lastTask,
      message: this.lastMessage,
      rawEventsCount: this.rawEventsCount,
    }
  }
}

/**
 * Formats an `A2AExecutionResult` into human- and LLM-friendly Markdown.
 */
export function formatA2AResult(
  result: A2AExecutionResult,
  options?: {
    includeReasoning?: boolean
    includeSteps?: boolean
  },
): string {
  const sections: string[] = []

  if (options?.includeReasoning && result.reasoningText) {
    sections.push(`<thinking>\n${result.reasoningText}\n</thinking>`)
  }

  if (options?.includeSteps && result.steps.length > 0) {
    sections.push(`**Steps:**\n${result.steps.map((s) => `- ${s}`).join("\n")}`)
  }

  if (result.answerText) {
    sections.push(result.answerText)
  } else if (result.statusText) {
    sections.push(result.statusText)
  } else if (isFailedState(result.state)) {
    sections.push(`Task ended with state: ${result.state}`)
  } else if (result.structuredPayloads.length === 0) {
    sections.push(`(No text output returned; state: ${result.state ?? "unknown"})`)
  }

  if (
    result.statusText &&
    result.answerText &&
    result.statusText !== result.answerText &&
    (isFailedState(result.state) || result.inputRequired)
  ) {
    sections.push(`**Status message:** ${result.statusText}`)
  }

  if (result.structuredPayloads.length > 0) {
    for (const item of result.structuredPayloads) {
      const label = item.contentType ? `Structured Payload (${item.contentType})` : "Structured Data"
      const serialized = typeof item.data === "string" ? item.data : JSON.stringify(item.data, null, 2)
      sections.push(`**${label}:**\n\`\`\`json\n${serialized}\n\`\`\``)
    }
  }

  if (result.inputRequired) {
    const ctxHint = result.contextId ? ` with \`contextId: "${result.contextId}"\`` : ""
    sections.push(
      `> **Input Required (${result.state}):** The A2A agent is waiting for user confirmation or additional parameters. Ask the user or provide the required input in a follow-up call${ctxHint}.`,
    )
  }

  const metaParts: string[] = [`agent: ${result.agentId}`]
  if (result.contextId) metaParts.push(`contextId: ${result.contextId}`)
  if (result.taskId) metaParts.push(`taskId: ${result.taskId}`)
  if (result.state) metaParts.push(`state: ${result.state}`)

  sections.push(`---\n[A2A ${metaParts.join(" | ")}]`)

  return sections.join("\n\n")
}
