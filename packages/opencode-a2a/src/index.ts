import { Plugin } from "@opencode/plugin"
import {
  expandTildePath,
  formatAuthHeaderValue,
  inferSecurityFromCard,
  interpolateConfigValue,
  readSecretFile,
  resolveAgentHeaders,
  resolveAgentToken,
  type InferredCardSecurity,
  type ResolveAuthHeadersOptions,
} from "./auth.ts"
import {
  A2ARestClient,
  A2A_PROTOCOL_VERSION,
  DEFAULT_A2A_TIMEOUT_MS,
  DEFAULT_AGENT_CARD_PATH,
  LEGACY_AGENT_CARD_PATH,
  buildAgentCardCandidateUrls,
  resolveAgentSkills,
  resolveRestEndpoint,
  sanitizeIdentifier,
  trimTrailingSlashes,
  type ResolvedSkill,
  type SendTurnInput,
} from "./client.ts"
import { A2AContextStore, type StoredA2AContext } from "./context-store.ts"
import {
  A2AEventAccumulator,
  META_THOUGHT_KEY,
  TRACE_EXTENSION_URI,
  concatPartsText,
  extractEffectiveContextId,
  formatA2AResult,
  getPartStructuredData,
  getPartText,
  getStructuredContentType,
  isFailedState,
  isInputRequiredState,
  isThoughtPart,
  isTraceArtifact,
} from "./format.ts"
import {
  DefaultToolNamingStrategy,
  FALLBACK_SKILL_ID,
  FALLBACK_SKILL_TAG,
  MAX_TOOL_NAME_LENGTH,
  applyFallbackSkill,
  buildSkillToolDescription,
  buildSkillToolInputSchema,
  isFallbackSkill,
  safeSegment,
  shortHash,
  truncateWithHash,
  type ToolNamingStrategy,
} from "./skillmap.ts"
import { DEFAULT_MAX_SSE_EVENT_SIZE_BYTES, normalizeA2AEventPayload, parseSseResponse, type ParsedSseFrame } from "./sse.ts"
import type {
  A2AAgentCapabilities,
  A2AAgentCard,
  A2AAgentConfig,
  A2AAgentInterface,
  A2AAgentSkill,
  A2AArtifact,
  A2AAuthConfig,
  A2ACancelTaskRequest,
  A2AExecutionResult,
  A2AFallbackSkillMode,
  A2AGetTaskRequest,
  A2AListTasksRequest,
  A2AListTasksResponse,
  A2AMessage,
  A2APart,
  A2APluginOptions,
  A2AProgressUpdate,
  A2ARestErrorDetail,
  A2ARestErrorStatus,
  A2ARole,
  A2ASecurityScheme,
  A2ASendMessageConfig,
  A2ASendMessageRequest,
  A2ASkillConfig,
  A2ASkillExposureMode,
  A2AStreamResponse,
  A2ATask,
  A2ATaskArtifactUpdateEvent,
  A2ATaskState,
  A2ATaskStatus,
  A2ATaskStatusUpdateEvent,
  A2AToolNamingStyle,
} from "./types.ts"

export {
  A2AContextStore,
  A2AEventAccumulator,
  A2ARestClient,
  A2A_PROTOCOL_VERSION,
  DEFAULT_A2A_TIMEOUT_MS,
  DEFAULT_AGENT_CARD_PATH,
  DEFAULT_MAX_SSE_EVENT_SIZE_BYTES,
  DefaultToolNamingStrategy,
  FALLBACK_SKILL_ID,
  FALLBACK_SKILL_TAG,
  LEGACY_AGENT_CARD_PATH,
  MAX_TOOL_NAME_LENGTH,
  META_THOUGHT_KEY,
  TRACE_EXTENSION_URI,
  applyFallbackSkill,
  buildAgentCardCandidateUrls,
  buildSkillToolDescription,
  buildSkillToolInputSchema,
  concatPartsText,
  expandTildePath,
  extractEffectiveContextId,
  formatA2AResult,
  formatAuthHeaderValue,
  getPartStructuredData,
  getPartText,
  getStructuredContentType,
  inferSecurityFromCard,
  interpolateConfigValue,
  isFailedState,
  isFallbackSkill,
  isInputRequiredState,
  isThoughtPart,
  isTraceArtifact,
  normalizeA2AEventPayload,
  parseSseResponse,
  readSecretFile,
  resolveAgentHeaders,
  resolveAgentSkills,
  resolveAgentToken,
  resolveRestEndpoint,
  safeSegment,
  sanitizeIdentifier,
  shortHash,
  trimTrailingSlashes,
  truncateWithHash,
  type A2AAgentCapabilities,
  type A2AAgentCard,
  type A2AAgentConfig,
  type A2AAgentInterface,
  type A2AAgentSkill,
  type A2AArtifact,
  type A2AAuthConfig,
  type A2ACancelTaskRequest,
  type A2AExecutionResult,
  type A2AFallbackSkillMode,
  type A2AGetTaskRequest,
  type A2AListTasksRequest,
  type A2AListTasksResponse,
  type A2AMessage,
  type A2APart,
  type A2APluginOptions,
  type A2AProgressUpdate,
  type A2ARestErrorDetail,
  type A2ARestErrorStatus,
  type A2ARole,
  type A2ASecurityScheme,
  type A2ASendMessageConfig,
  type A2ASendMessageRequest,
  type A2ASkillConfig,
  type A2ASkillExposureMode,
  type A2AStreamResponse,
  type A2ATask,
  type A2ATaskArtifactUpdateEvent,
  type A2ATaskState,
  type A2ATaskStatus,
  type A2ATaskStatusUpdateEvent,
  type A2AToolNamingStyle,
  type InferredCardSecurity,
  type ParsedSseFrame,
  type ResolveAuthHeadersOptions,
  type ResolvedSkill,
  type SendTurnInput,
  type StoredA2AContext,
  type ToolNamingStrategy,
}

export interface AgentToolInput {
  action?: "send" | "get_task" | "cancel_task" | "list_tasks" | "discover"
  message?: string
  prompt?: string
  query?: string
  skill?: string
  skillId?: string
  contextId?: string
  sessionId?: string
  taskId?: string
  newContext?: boolean
  historyLength?: number
  metadata?: Record<string, unknown>
  stream?: boolean
}

export interface SkillToolInput {
  message?: string
  prompt?: string
  query?: string
  contextId?: string
  sessionId?: string
  taskId?: string
  newContext?: boolean
  metadata?: Record<string, unknown>
  stream?: boolean
  [key: string]: unknown
}

export interface TaskToolInput {
  action?: "get" | "status" | "result" | "cancel" | "list"
  taskId?: string
  contextId?: string
  historyLength?: number
  metadata?: Record<string, unknown>
}

const RESERVED_SKILL_INPUT_KEYS = new Set([
  "message",
  "prompt",
  "query",
  "contextId",
  "sessionId",
  "taskId",
  "newContext",
  "metadata",
  "stream",
])

function deriveDefaultAgentId(config: A2AAgentConfig, index: number): string {
  if (typeof config.id === "string" && config.id.trim()) {
    return config.id.trim()
  }
  if (typeof config.name === "string" && config.name.trim()) {
    return sanitizeIdentifier(config.name)
  }
  if (typeof config.card?.name === "string" && config.card.name.trim()) {
    return sanitizeIdentifier(config.card.name)
  }
  const rawUrl = config.url ?? config.baseUrl ?? config.endpoint ?? config.a2aUrl ?? config.agentCardUrl
  if (typeof rawUrl === "string" && rawUrl.trim()) {
    try {
      const parsed = new URL(rawUrl.trim())
      const hostFirst = parsed.hostname.split(".")[0] ?? "agent"
      const cleaned = sanitizeIdentifier(hostFirst.replace(/^app-|^api-|^a2a-/, ""))
      if (cleaned) return cleaned
    } catch {
      // Fallback below
    }
  }
  return `agent_${index + 1}`
}

export function normalizeAgentConfigs(options: A2APluginOptions): Array<{ agentId: string; config: A2AAgentConfig }> {
  const result: Array<{ agentId: string; config: A2AAgentConfig }> = []
  const usedIds = new Set<string>()

  const allocateUniqueId = (baseId: string): string => {
    let candidate = baseId
    let counter = 2
    while (usedIds.has(candidate)) {
      candidate = `${baseId}_${counter}`
      counter += 1
    }
    usedIds.add(candidate)
    return candidate
  }

  const rawAgents = options.agents
  if (Array.isArray(rawAgents)) {
    rawAgents.forEach((cfg, idx) => {
      if (!cfg || typeof cfg !== "object" || cfg.enabled === false) return
      const id = allocateUniqueId(deriveDefaultAgentId(cfg, idx))
      result.push({ agentId: id, config: { ...cfg, id } })
    })
  } else if (rawAgents && typeof rawAgents === "object") {
    Object.entries(rawAgents).forEach(([key, cfg], idx) => {
      if (!cfg || typeof cfg !== "object" || cfg.enabled === false) return
      const preferredId = cfg.id?.trim() || key.trim() || deriveDefaultAgentId(cfg, idx)
      const id = allocateUniqueId(preferredId)
      result.push({ agentId: id, config: { ...cfg, id } })
    })
  } else {
    // Support single-agent top-level configuration shorthand
    const single = options as unknown as A2AAgentConfig
    if (single.url || single.baseUrl || single.endpoint || single.a2aUrl || single.agentCardUrl) {
      if (single.enabled !== false) {
        const id = allocateUniqueId(deriveDefaultAgentId(single, 0))
        result.push({ agentId: id, config: { ...single, id } })
      }
    }
  }

  return result
}

export function parsePluginOptions(raw: unknown): A2APluginOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return raw as A2APluginOptions
}

export function buildAgentToolDescription(
  client: A2ARestClient,
  allSkills: ResolvedSkill[],
): string {
  const lines: string[] = [
    `${client.displayName} (${client.agentId}): ${client.description}`,
    "Supports multi-turn conversations via `contextId` / `sessionId` (automatically tracked per OpenCode session unless `newContext: true` is passed) and task operations (`action`: 'send' | 'get_task' | 'cancel_task' | 'list_tasks' | 'discover').",
  ]

  if (allSkills.length > 0) {
    lines.push("\nAvailable Agent Card Skills:")
    for (const skill of allSkills) {
      const desc = skill.description ? ` - ${skill.description.split("\n")[0]!.slice(0, 220)}` : ""
      const tags = skill.tags?.length ? ` [tags: ${skill.tags.join(", ")}]` : ""
      const ex = skill.examples?.length ? ` (e.g., "${skill.examples[0]}")` : ""
      lines.push(`- \`${skill.id}\` (${skill.name})${tags}${desc}${ex}`)
    }
  }

  return lines.join("\n")
}

export function buildAgentToolInputSchema(allSkills: ResolvedSkill[]): Record<string, unknown> {
  const skillIds = allSkills.map((s) => s.id)
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["send", "get_task", "cancel_task", "list_tasks", "discover"],
        description:
          "Operation to perform: 'send' (default, send message via /message:send or /message:stream), 'get_task' (GET /tasks/{id}), 'cancel_task' (POST /tasks/{id}:cancel), 'list_tasks' (GET /tasks), or 'discover' (refresh /.well-known/agent-card.json).",
      },
      message: {
        type: "string",
        description: "Natural-language message or instruction to send to the A2A agent (required when action is 'send').",
      },
      skill: {
        type: "string",
        ...(skillIds.length > 0 ? { enum: skillIds } : {}),
        description: "Optional A2A skill ID to route the message to (injected into message.metadata.skillId and request.metadata.skillId).",
      },
      skillId: {
        type: "string",
        description: "Alias for `skill`.",
      },
      contextId: {
        type: "string",
        description:
          "Optional A2A contextId for multi-turn conversation continuity. When omitted, automatically reuses the contextId bound to the current OpenCode session.",
      },
      sessionId: {
        type: "string",
        description: "Alias for `contextId` (a2a-mcp-skillmap compatibility).",
      },
      taskId: {
        type: "string",
        description: "Task ID for 'get_task' / 'cancel_task', or when continuing an existing task in 'send'.",
      },
      newContext: {
        type: "boolean",
        description: "Set to true to start a brand-new conversation context instead of reusing the current session's contextId.",
      },
      historyLength: {
        type: "number",
        description: "Optional number of recent history messages to include in 'get_task' or 'list_tasks'.",
      },
      metadata: {
        type: "object",
        description: "Optional metadata object passed in SendMessageRequest.metadata and Message.metadata (e.g., { lang: 'zh_CN', action_param: {...} }).",
        additionalProperties: true,
      },
      stream: {
        type: "boolean",
        description: "Optional override for SSE streaming (true uses POST /message:stream, false uses POST /message:send).",
      },
    },
    additionalProperties: false,
  }
}

export const TASK_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["get", "status", "result", "cancel", "list"],
      description: "Task operation: 'get' / 'status' / 'result' (GET /tasks/{id}), 'cancel' (POST /tasks/{id}:cancel), or 'list' (GET /tasks).",
    },
    taskId: {
      type: "string",
      description: "Target A2A task ID (defaults to the most recent taskId in the current OpenCode session if omitted).",
    },
    contextId: {
      type: "string",
      description: "Optional contextId filter when action is 'list'.",
    },
    historyLength: {
      type: "number",
      description: "Optional number of history messages to retrieve.",
    },
    metadata: {
      type: "object",
      description: "Optional metadata for 'cancel'.",
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "opencode-a2a",
  async setup(ctx) {
    const options = parsePluginOptions(ctx.options)
    const agentEntries = normalizeAgentConfigs(options)
    const contextStore = new A2AContextStore()
    const globalPrefix = sanitizeIdentifier(options.toolPrefix ?? "a2a")

    const clients = agentEntries.map(
      ({ agentId, config }) =>
        new A2ARestClient({
          agentId,
          config,
          fetch: options.fetch,
          authOptions: { baseDirectory: ctx.location?.directory },
          defaultTimeoutMs: options.timeoutMs,
        }),
    )

    // Discover AgentCards in parallel on startup (non-fatal if an agent is temporarily unreachable)
    await Promise.allSettled(clients.map((client) => client.discoverAgentCard()))

    const toolRegistration = await ctx.tool.transform((editor) => {
      const registeredNames = new Set<string>()

      const executeSendTurn = async (
        client: A2ARestClient,
        params: {
          text: string
          skillId?: string
          skillDefaultMetadata?: Record<string, unknown>
          structuredArgs?: Record<string, unknown>
          explicitContextId?: string
          taskId?: string
          newContext?: boolean
          metadata?: Record<string, unknown>
          stream?: boolean
          sessionID?: string
          signal?: AbortSignal
          progress?: (update: Record<string, unknown>) => Promise<void>
        },
      ) => {
        const autoContext = client.config.autoContext ?? options.autoContext ?? true
        const includeReasoning = client.config.includeReasoning ?? options.includeReasoning ?? false

        if (params.newContext && params.sessionID) {
          contextStore.delete(params.sessionID, client.agentId)
        }

        const stored =
          !params.newContext && autoContext
            ? contextStore.get(params.sessionID, client.agentId)
            : undefined

        const effectiveContextId = params.explicitContextId?.trim() || stored?.contextId
        const mergedMetadata: Record<string, unknown> = {
          ...params.skillDefaultMetadata,
          ...(params.structuredArgs && Object.keys(params.structuredArgs).length > 0
            ? { args: params.structuredArgs }
            : {}),
          ...params.metadata,
        }

        const result = await client.executeTurn({
          text: params.text,
          contextId: effectiveContextId,
          taskId: params.taskId?.trim() || undefined,
          skillId: params.skillId,
          metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
          stream: params.stream,
          signal: params.signal,
          onProgress: async (update) => {
            if (params.sessionID && (update.contextId || update.taskId)) {
              contextStore.set(params.sessionID, client.agentId, {
                contextId: update.contextId,
                taskId: update.taskId,
              })
            }
            if (params.progress) {
              await params.progress({
                title: update.stepText
                  ? `[${client.displayName}] ${update.stepText}`
                  : `[${client.displayName}] ${update.state ?? "working"}`,
                agentId: client.agentId,
                ...(params.skillId ? { skillId: params.skillId } : {}),
                ...(update.taskId ? { taskId: update.taskId } : {}),
                ...(update.contextId ? { contextId: update.contextId } : {}),
                ...(update.state ? { state: update.state } : {}),
              })
            }
          },
        })

        if (params.sessionID && (result.contextId || result.taskId)) {
          contextStore.set(params.sessionID, client.agentId, {
            contextId: result.contextId ?? effectiveContextId,
            taskId: result.taskId,
          })
        }

        const resolvedSessionId = result.contextId ?? effectiveContextId

        return {
          content: formatA2AResult(result, {
            includeReasoning,
            includeSteps: true,
          }),
          metadata: {
            agentId: client.agentId,
            agentName: client.displayName,
            ...(params.skillId ? { skillId: params.skillId } : {}),
            ...(resolvedSessionId ? { contextId: resolvedSessionId, sessionId: resolvedSessionId } : {}),
            ...(result.taskId ? { taskId: result.taskId } : {}),
            ...(result.state ? { state: result.state } : {}),
            inputRequired: result.inputRequired,
          },
        }
      }

      for (const client of clients) {
        const { allSkills, exposedSkills: rawExposedSkills } = resolveAgentSkills(
          client.config,
          client.card,
          options.exposeSkills ?? true,
        )

        const fallbackMode: A2AFallbackSkillMode =
          client.config.fallbackTool ?? options.fallbackTool ?? "message"
        const exposeMode = client.config.exposeSkills ?? options.exposeSkills ?? true
        const exposedSkills =
          exposeMode === false || exposeMode === "none"
            ? []
            : applyFallbackSkill(
                {
                  id: client.agentId,
                  name: client.displayName,
                  description: client.description,
                  skills: rawExposedSkills,
                },
                fallbackMode,
              )

        const agentSlug = sanitizeIdentifier(client.agentId)
        const baseAgentToolName =
          client.config.toolName?.trim() ||
          (agentSlug.startsWith(`${globalPrefix}_`) ? agentSlug : `${globalPrefix}_${agentSlug}`)

        const exposeAgentTool = client.config.exposeAgentTool ?? options.exposeAgentTool ?? true

        // 1. Register the unified Agent Tool (`a2a_<agentId>`)
        if (exposeAgentTool && !registeredNames.has(baseAgentToolName)) {
          registeredNames.add(baseAgentToolName)
          editor.add({
            name: baseAgentToolName,
            description: buildAgentToolDescription(client, allSkills),
            input: buildAgentToolInputSchema(allSkills) as never,
            async execute(rawInput, toolContext) {
              const input = (rawInput ?? {}) as AgentToolInput
              const action = input.action ?? "send"
              const sessionID = toolContext?.sessionID
              const includeReasoning = client.config.includeReasoning ?? options.includeReasoning ?? false

              if (action === "discover") {
                const card = await client.discoverAgentCard({
                  force: true,
                  signal: toolContext?.signal,
                })
                const skills = card?.skills ?? []
                return {
                  content: JSON.stringify(
                    {
                      agentId: client.agentId,
                      name: card?.name ?? client.displayName,
                      description: card?.description ?? client.description,
                      version: card?.version,
                      supportedInterfaces: card?.supportedInterfaces,
                      capabilities: card?.capabilities,
                      skills: skills.map((s) => ({
                        id: s.id,
                        name: s.name,
                        description: s.description,
                        tags: s.tags,
                        examples: s.examples,
                      })),
                    },
                    null,
                    2,
                  ),
                  metadata: {
                    agentId: client.agentId,
                    skillsCount: skills.length,
                  },
                }
              }

              if (action === "get_task") {
                const stored = contextStore.get(sessionID, client.agentId)
                const taskId = input.taskId?.trim() || stored?.lastTaskId
                if (!taskId) {
                  throw new Error(`taskId is required for action="get_task" on agent "${client.agentId}".`)
                }
                const { result } = await client.getTask(
                  { id: taskId, historyLength: input.historyLength },
                  { signal: toolContext?.signal },
                )
                if (sessionID && result.contextId) {
                  contextStore.set(sessionID, client.agentId, {
                    contextId: result.contextId,
                    taskId: result.taskId ?? taskId,
                  })
                }
                return {
                  content: formatA2AResult(result, { includeReasoning, includeSteps: true }),
                  metadata: {
                    agentId: client.agentId,
                    taskId: result.taskId ?? taskId,
                    ...(result.contextId ? { contextId: result.contextId, sessionId: result.contextId } : {}),
                    ...(result.state ? { state: result.state } : {}),
                  },
                }
              }

              if (action === "cancel_task") {
                const stored = contextStore.get(sessionID, client.agentId)
                const taskId = input.taskId?.trim() || stored?.lastTaskId
                if (!taskId) {
                  throw new Error(`taskId is required for action="cancel_task" on agent "${client.agentId}".`)
                }
                const { result } = await client.cancelTask(
                  { id: taskId, metadata: input.metadata },
                  { signal: toolContext?.signal },
                )
                return {
                  content: formatA2AResult(result, { includeReasoning }),
                  metadata: {
                    agentId: client.agentId,
                    taskId: result.taskId ?? taskId,
                    ...(result.contextId ? { contextId: result.contextId, sessionId: result.contextId } : {}),
                    ...(result.state ? { state: result.state } : {}),
                  },
                }
              }

              if (action === "list_tasks") {
                const stored = contextStore.get(sessionID, client.agentId)
                const listRes = await client.listTasks(
                  {
                    contextId: (input.contextId ?? input.sessionId)?.trim() || stored?.contextId,
                    historyLength: input.historyLength,
                  },
                  { signal: toolContext?.signal },
                )
                return {
                  content: JSON.stringify(listRes, null, 2),
                  metadata: {
                    agentId: client.agentId,
                    count: listRes.tasks?.length ?? 0,
                  },
                }
              }

              const text = (input.message ?? input.prompt ?? input.query ?? "").trim()
              if (!text) {
                throw new Error(`"message" is required when calling ${baseAgentToolName}.`)
              }

              const skillId = (input.skill ?? input.skillId)?.trim() || undefined
              const matchedSkill = skillId ? allSkills.find((s) => s.id === skillId) : undefined

              return await executeSendTurn(client, {
                text,
                skillId,
                skillDefaultMetadata: matchedSkill?.defaultMetadata,
                explicitContextId: input.contextId ?? input.sessionId,
                taskId: input.taskId,
                newContext: input.newContext,
                metadata: input.metadata,
                stream: input.stream,
                sessionID,
                signal: toolContext?.signal,
                progress: toolContext?.progress as ((update: Record<string, unknown>) => Promise<void>) | undefined,
              })
            },
          })
        }

        // 2. Register dedicated Task Tool (`a2a_<agentId>_task`) if enabled
        const exposeTaskTool = client.config.exposeTaskTool ?? options.exposeTaskTool ?? true
        const taskToolName = `${baseAgentToolName}_task`
        if (exposeTaskTool && !registeredNames.has(taskToolName)) {
          registeredNames.add(taskToolName)
          editor.add({
            name: taskToolName,
            description: `Query or cancel A2A tasks on ${client.displayName} (GET /tasks/{id}, POST /tasks/{id}:cancel, GET /tasks).`,
            input: TASK_TOOL_INPUT_SCHEMA as never,
            async execute(rawInput, toolContext) {
              const input = (rawInput ?? {}) as TaskToolInput
              const action = input.action ?? "get"
              const sessionID = toolContext?.sessionID
              const stored = contextStore.get(sessionID, client.agentId)
              const includeReasoning = client.config.includeReasoning ?? options.includeReasoning ?? false

              if (action === "list") {
                const listRes = await client.listTasks(
                  {
                    contextId: input.contextId?.trim() || stored?.contextId,
                    historyLength: input.historyLength,
                  },
                  { signal: toolContext?.signal },
                )
                return {
                  content: JSON.stringify(listRes, null, 2),
                  metadata: {
                    agentId: client.agentId,
                    count: listRes.tasks?.length ?? 0,
                  },
                }
              }

              const taskId = input.taskId?.trim() || stored?.lastTaskId
              if (!taskId) {
                throw new Error(`taskId is required for ${taskToolName} (action="${action}").`)
              }

              if (action === "cancel") {
                const { result } = await client.cancelTask(
                  { id: taskId, metadata: input.metadata },
                  { signal: toolContext?.signal },
                )
                return {
                  content: formatA2AResult(result, { includeReasoning }),
                  metadata: {
                    agentId: client.agentId,
                    taskId: result.taskId ?? taskId,
                    ...(result.contextId ? { contextId: result.contextId, sessionId: result.contextId } : {}),
                    ...(result.state ? { state: result.state } : {}),
                  },
                }
              }

              const { result } = await client.getTask(
                { id: taskId, historyLength: input.historyLength },
                { signal: toolContext?.signal },
              )
              if (sessionID && result.contextId) {
                contextStore.set(sessionID, client.agentId, {
                  contextId: result.contextId,
                  taskId: result.taskId ?? taskId,
                })
              }
              return {
                content: formatA2AResult(result, { includeReasoning, includeSteps: true }),
                metadata: {
                  agentId: client.agentId,
                  taskId: result.taskId ?? taskId,
                  ...(result.contextId ? { contextId: result.contextId, sessionId: result.contextId } : {}),
                  ...(result.state ? { state: result.state } : {}),
                },
              }
            },
          })
        }

        // 3. Register individual Skill Tools (a2a-mcp-skillmap projection: 1 skill -> 1 tool)
        const namingStyle = client.config.namingStyle ?? options.namingStyle ?? "double_underscore"
        const stylesToRegister: A2AToolNamingStyle[] =
          namingStyle === "both" ? ["double_underscore", "a2a_prefix"] : [namingStyle]

        const agentEndpointUrl =
          client.config.url ?? client.config.baseUrl ?? client.config.endpoint ?? client.agentId

        for (const skill of exposedSkills) {
          const candidateNames: string[] = []
          if (skill.toolName?.trim()) {
            candidateNames.push(skill.toolName.trim())
          } else {
            for (const style of stylesToRegister) {
              const naming = new DefaultToolNamingStrategy({
                style,
                prefix: globalPrefix,
              })
              const nameAgentId =
                style === "double_underscore"
                  ? client.config.toolPrefix?.trim() || client.agentId
                  : client.config.toolPrefix?.trim() || client.agentId
              const primaryName = naming.deriveName(nameAgentId, skill.id)
              const resolvedName = registeredNames.has(primaryName)
                ? naming.deriveNameWithNamespace(agentEndpointUrl, nameAgentId, skill.id)
                : primaryName
              candidateNames.push(resolvedName)
            }
          }

          for (const skillToolName of candidateNames) {
            if (registeredNames.has(skillToolName)) continue
            registeredNames.add(skillToolName)

            const toolDescription = buildSkillToolDescription(
              {
                id: client.agentId,
                name: client.displayName,
                description: client.description,
              },
              skill,
            )
            const toolInputSchema = buildSkillToolInputSchema(skill)
            const fallback = isFallbackSkill(skill)

            editor.add({
              name: skillToolName,
              description: toolDescription,
              input: toolInputSchema as never,
              async execute(rawInput, toolContext) {
                const input = (rawInput ?? {}) as SkillToolInput

                // Extract any structured inputSchema arguments alongside `message`
                const structuredArgs: Record<string, unknown> = {}
                for (const [k, v] of Object.entries(input)) {
                  if (!RESERVED_SKILL_INPUT_KEYS.has(k) && v !== undefined) {
                    structuredArgs[k] = v
                  }
                }

                let text = (
                  typeof input.message === "string"
                    ? input.message
                    : typeof input.prompt === "string"
                      ? input.prompt
                      : typeof input.query === "string"
                        ? input.query
                        : ""
                ).trim()

                if (!text && Object.keys(structuredArgs).length > 0) {
                  text = JSON.stringify(structuredArgs)
                }

                if (!text) {
                  throw new Error(`"message" is required when calling ${skillToolName}.`)
                }

                return await executeSendTurn(client, {
                  text,
                  skillId: fallback ? undefined : skill.id,
                  skillDefaultMetadata: skill.defaultMetadata,
                  structuredArgs,
                  explicitContextId:
                    typeof input.contextId === "string"
                      ? input.contextId
                      : typeof input.sessionId === "string"
                        ? input.sessionId
                        : undefined,
                  taskId: typeof input.taskId === "string" ? input.taskId : undefined,
                  newContext: typeof input.newContext === "boolean" ? input.newContext : undefined,
                  metadata:
                    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
                      ? (input.metadata as Record<string, unknown>)
                      : undefined,
                  stream: typeof input.stream === "boolean" ? input.stream : undefined,
                  sessionID: toolContext?.sessionID,
                  signal: toolContext?.signal,
                  progress: toolContext?.progress as ((update: Record<string, unknown>) => Promise<void>) | undefined,
                })
              },
            })
          }
        }
      }
    })

    return async () => {
      await toolRegistration?.dispose?.()
      contextStore.clear()
    }
  },
})
