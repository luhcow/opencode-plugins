import { randomUUID } from "node:crypto"
import { resolveAgentHeaders, type ResolveAuthHeadersOptions } from "./auth.ts"
import { A2AEventAccumulator } from "./format.ts"
import { normalizeA2AEventPayload, parseSseResponse } from "./sse.ts"
import type {
  A2AAgentCard,
  A2AAgentConfig,
  A2AAgentSkill,
  A2ACancelTaskRequest,
  A2AExecutionResult,
  A2AFetch,
  A2AGetTaskRequest,
  A2AListTasksRequest,
  A2AListTasksResponse,
  A2AMessage,
  A2APart,
  A2AProgressUpdate,
  A2ASendMessageConfig,
  A2ASendMessageRequest,
  A2ASkillConfig,
  A2ATask,
} from "./types.ts"

export const DEFAULT_AGENT_CARD_PATH = "/.well-known/agent-card.json"
export const LEGACY_AGENT_CARD_PATH = "/.well-known/agent.json"
export const DEFAULT_A2A_TIMEOUT_MS = 300_000 // 5 minutes
export const A2A_PROTOCOL_VERSION = "1.0"

export interface ResolvedSkill extends A2AAgentSkill {
  toolName?: string
  defaultMetadata?: Record<string, unknown>
}

export interface SendTurnInput {
  text: string
  parts?: A2APart[]
  contextId?: string
  taskId?: string
  skillId?: string
  metadata?: Record<string, unknown>
  messageMetadata?: Record<string, unknown>
  configuration?: A2ASendMessageConfig
  stream?: boolean
  signal?: AbortSignal
  onProgress?: (update: A2AProgressUpdate) => void | Promise<void>
}

export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "")
}

export function sanitizeIdentifier(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return cleaned || "agent"
}

/**
 * Derives candidate Agent Card discovery URLs from an `A2AAgentConfig`.
 */
export function buildAgentCardCandidateUrls(config: A2AAgentConfig): string[] {
  const candidates: string[] = []
  const addCandidate = (u: string) => {
    const trimmed = u.trim()
    if (trimmed && !candidates.includes(trimmed)) {
      candidates.push(trimmed)
    }
  }

  if (typeof config.agentCardUrl === "string" && config.agentCardUrl.trim()) {
    addCandidate(config.agentCardUrl)
    return candidates
  }

  const rawBase = (config.url ?? config.baseUrl ?? config.endpoint ?? config.a2aUrl ?? "").trim()
  if (!rawBase) return candidates

  const cardPath = config.cardPath !== undefined ? config.cardPath.trim() : DEFAULT_AGENT_CARD_PATH

  if (cardPath === "" || rawBase.endsWith(".json")) {
    addCandidate(rawBase)
    return candidates
  }

  const normalizedCardPath = cardPath.startsWith("/") ? cardPath : `/${cardPath}`
  const baseNoSlash = trimTrailingSlashes(rawBase)

  try {
    const parsed = new URL(baseNoSlash)
    const origin = parsed.origin
    const pathname = trimTrailingSlashes(parsed.pathname)

    if (!pathname || pathname === "") {
      addCandidate(`${origin}${normalizedCardPath}`)
      if (normalizedCardPath === DEFAULT_AGENT_CARD_PATH) {
        addCandidate(`${origin}${LEGACY_AGENT_CARD_PATH}`)
      }
    } else if (pathname === "/a2a" || pathname.endsWith("/a2a")) {
      // If user configured `http://host/a2a`, try `<origin>/.well-known/agent-card.json` first, then `<base>/.well-known/agent-card.json`
      const parentPrefix = pathname.slice(0, pathname.length - "/a2a".length)
      addCandidate(`${origin}${parentPrefix}${normalizedCardPath}`)
      addCandidate(`${origin}${normalizedCardPath}`)
      addCandidate(`${baseNoSlash}${normalizedCardPath}`)
      if (normalizedCardPath === DEFAULT_AGENT_CARD_PATH) {
        addCandidate(`${origin}${LEGACY_AGENT_CARD_PATH}`)
      }
    } else {
      addCandidate(`${baseNoSlash}${normalizedCardPath}`)
      addCandidate(`${origin}${normalizedCardPath}`)
      if (normalizedCardPath === DEFAULT_AGENT_CARD_PATH) {
        addCandidate(`${baseNoSlash}${LEGACY_AGENT_CARD_PATH}`)
        addCandidate(`${origin}${LEGACY_AGENT_CARD_PATH}`)
      }
    }
  } catch {
    addCandidate(`${baseNoSlash}${normalizedCardPath}`)
  }

  return candidates
}

/**
 * Resolves the A2A HTTP+JSON REST base endpoint URL from configuration and/or discovered AgentCard.
 */
export function resolveRestEndpoint(
  config: A2AAgentConfig,
  card?: Partial<A2AAgentCard> | null,
): { endpoint: string; tenant?: string; protocolVersion: string } {
  const explicitEndpoint = (config.endpoint ?? config.a2aUrl ?? "").trim()
  if (explicitEndpoint) {
    return {
      endpoint: trimTrailingSlashes(explicitEndpoint),
      tenant: config.tenant?.trim() || undefined,
      protocolVersion: A2A_PROTOCOL_VERSION,
    }
  }

  // Check AgentCard.supportedInterfaces for HTTP+JSON / REST binding
  if (Array.isArray(card?.supportedInterfaces) && card.supportedInterfaces.length > 0) {
    const httpJsonInterface =
      card.supportedInterfaces.find((iface) => {
        const binding = (iface.protocolBinding ?? "").toUpperCase()
        return (binding === "HTTP+JSON" || binding === "REST") && typeof iface.url === "string" && iface.url.trim()
      })

    if (httpJsonInterface?.url) {
      return {
        endpoint: trimTrailingSlashes(httpJsonInterface.url.trim()),
        tenant: config.tenant?.trim() || httpJsonInterface.tenant?.trim() || undefined,
        protocolVersion: httpJsonInterface.protocolVersion?.trim() || A2A_PROTOCOL_VERSION,
      }
    }
    throw new Error("Agent Card does not advertise an HTTP+JSON REST interface. Configure a REST endpoint explicitly.")
  }

  // Fallback to v0.3 AgentCard.url
  if (typeof card?.url === "string" && card.url.trim()) {
    return {
      endpoint: trimTrailingSlashes(card.url.trim()),
      tenant: config.tenant?.trim() || undefined,
      protocolVersion: card.version?.trim() || A2A_PROTOCOL_VERSION,
    }
  }

  // Fallback to deriving from `config.url` / `config.baseUrl`
  const rawBase = (config.url ?? config.baseUrl ?? "").trim()
  if (!rawBase) {
    throw new Error(`A2A agent "${config.id ?? config.name ?? "unknown"}" has no url or endpoint configured.`)
  }

  let cleaned = trimTrailingSlashes(rawBase)
  for (const suffix of [DEFAULT_AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, "/agent-card.json", "/agent.json"]) {
    if (cleaned.endsWith(suffix)) {
      cleaned = trimTrailingSlashes(cleaned.slice(0, cleaned.length - suffix.length))
      break
    }
  }

  try {
    const parsed = new URL(cleaned)
    const pathname = trimTrailingSlashes(parsed.pathname)
    if (!pathname || pathname === "") {
      return {
        endpoint: `${parsed.origin}/a2a`,
        tenant: config.tenant?.trim() || undefined,
        protocolVersion: A2A_PROTOCOL_VERSION,
      }
    }
  } catch {
    // Non-standard URL, use as-is
  }

  return {
    endpoint: cleaned,
    tenant: config.tenant?.trim() || undefined,
    protocolVersion: A2A_PROTOCOL_VERSION,
  }
}

/**
 * Resolves and filters the Agent's skills from the discovered AgentCard and static configuration.
 */
export function resolveAgentSkills(
  config: A2AAgentConfig,
  card?: Partial<A2AAgentCard> | null,
  defaultExposeSkills: A2AAgentConfig["exposeSkills"] = true,
): {
  allSkills: ResolvedSkill[]
  exposedSkills: ResolvedSkill[]
} {
  const byId = new Map<string, ResolvedSkill>()
  const configuredSkillIds = new Set<string>()

  // 1. Load skills from AgentCard
  for (const skill of card?.skills ?? []) {
    if (!skill || typeof skill.id !== "string" || !skill.id.trim()) continue
    const id = skill.id.trim()
    byId.set(id, {
      id,
      name: skill.name?.trim() || id,
      description: skill.description?.trim(),
      tags: Array.isArray(skill.tags) ? [...skill.tags] : undefined,
      examples: Array.isArray(skill.examples) ? [...skill.examples] : undefined,
      inputModes: Array.isArray(skill.inputModes) ? [...skill.inputModes] : undefined,
      outputModes: Array.isArray(skill.outputModes) ? [...skill.outputModes] : undefined,
      inputSchema: skill.inputSchema && typeof skill.inputSchema === "object" ? { ...skill.inputSchema } : undefined,
    })
  }

  // 2. Merge static / override `config.skills`
  for (const item of config.skills ?? []) {
    if (typeof item === "string") {
      const id = item.trim()
      if (!id) continue
      configuredSkillIds.add(id)
      if (!byId.has(id)) {
        byId.set(id, { id, name: id })
      }
    } else if (item && typeof item === "object" && typeof item.id === "string" && item.id.trim()) {
      const cfg = item as A2ASkillConfig
      const id = cfg.id.trim()
      configuredSkillIds.add(id)
      const existing = byId.get(id)
      byId.set(id, {
        id,
        name: cfg.name?.trim() || existing?.name || id,
        description: cfg.description?.trim() ?? existing?.description,
        tags: cfg.tags ? [...cfg.tags] : existing?.tags,
        examples: cfg.examples ? [...cfg.examples] : existing?.examples,
        inputModes: cfg.inputModes ? [...cfg.inputModes] : existing?.inputModes,
        outputModes: cfg.outputModes ? [...cfg.outputModes] : existing?.outputModes,
        inputSchema: cfg.inputSchema ? { ...cfg.inputSchema } : existing?.inputSchema,
        toolName: cfg.toolName?.trim(),
        defaultMetadata: cfg.metadata ? { ...cfg.metadata } : undefined,
      })
    }
  }

  for (const id of config.includeSkills ?? []) {
    if (typeof id === "string" && id.trim()) {
      configuredSkillIds.add(id.trim())
    }
  }

  const allSkills = Array.from(byId.values())
  const exposeMode = config.exposeSkills !== undefined ? config.exposeSkills : defaultExposeSkills

  if (exposeMode === false || exposeMode === "none") {
    return { allSkills, exposedSkills: [] }
  }

  const excludeIds = new Set(
    (config.excludeSkills ?? []).map((s) => s.trim()).filter(Boolean),
  )
  const includeTags = new Set(
    (config.includeTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  )
  const excludeTags = new Set(
    (config.excludeTags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  )

  const exposedSkills = allSkills.filter((skill) => {
    if (excludeIds.has(skill.id)) return false

    const skillTags = (skill.tags ?? []).map((t) => t.toLowerCase())
    if (excludeTags.size > 0 && skillTags.some((t) => excludeTags.has(t))) {
      // Allow explicit whitelist in configuredSkillIds to override tag exclusion
      if (!configuredSkillIds.has(skill.id)) return false
    }

    if (exposeMode === "configured") {
      return configuredSkillIds.has(skill.id)
    }

    if (exposeMode === "export") {
      return skillTags.includes("export") || configuredSkillIds.has(skill.id)
    }

    if (configuredSkillIds.size > 0) {
      return configuredSkillIds.has(skill.id)
    }

    if (includeTags.size > 0) {
      return skillTags.some((t) => includeTags.has(t))
    }

    return true
  })

  return { allSkills, exposedSkills }
}

/**
 * HTTP+JSON REST client for a single A2A Agent endpoint.
 */
export class A2ARestClient {
  readonly agentId: string
  readonly config: A2AAgentConfig
  private readonly fetchImpl: A2AFetch
  private readonly authOptions?: ResolveAuthHeadersOptions
  private readonly defaultTimeoutMs: number
  private discoveredCard: A2AAgentCard | null = null
  private discoveryAttempted = false

  constructor(options: {
    agentId: string
    config: A2AAgentConfig
    fetch?: A2AFetch
    authOptions?: ResolveAuthHeadersOptions
    defaultTimeoutMs?: number
  }) {
    this.agentId = options.agentId
    this.config = options.config
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.authOptions = options.authOptions
    this.defaultTimeoutMs = options.config.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_A2A_TIMEOUT_MS

    if (options.config.card && options.config.card.name) {
      this.discoveredCard = {
        name: options.config.card.name,
        ...options.config.card,
      }
    }
  }

  get card(): A2AAgentCard | null {
    return this.discoveredCard
  }

  get displayName(): string {
    return (
      this.config.name?.trim() ||
      this.discoveredCard?.name?.trim() ||
      this.agentId
    )
  }

  get description(): string {
    return (
      this.config.description?.trim() ||
      this.discoveredCard?.description?.trim() ||
      `A2A Agent (${this.displayName})`
    )
  }

  private mergeWithStaticCard(fetched: A2AAgentCard): A2AAgentCard {
    const staticCard = this.config.card
    if (!staticCard) return fetched
    return {
      ...fetched,
      ...staticCard,
      name: staticCard.name ?? fetched.name,
      description: staticCard.description ?? fetched.description,
      capabilities: {
        ...fetched.capabilities,
        ...staticCard.capabilities,
      },
      securitySchemes: {
        ...fetched.securitySchemes,
        ...staticCard.securitySchemes,
      },
      skills: staticCard.skills ?? fetched.skills,
    }
  }

  /**
   * Discovers the AgentCard from `/.well-known/agent-card.json` (with fallback to `/.well-known/agent.json`).
   */
  async discoverAgentCard(options?: { force?: boolean; signal?: AbortSignal }): Promise<A2AAgentCard | null> {
    if (this.config.discover === false) {
      this.discoveryAttempted = true
      return this.discoveredCard
    }

    if (this.discoveryAttempted && this.discoveredCard && !options?.force) {
      return this.discoveredCard
    }

    this.discoveryAttempted = true
    const candidates = buildAgentCardCandidateUrls(this.config)
    if (candidates.length === 0) {
      return this.discoveredCard
    }

    const headers: Record<string, string> = {
      Accept: "application/json, application/a2a+json",
      ...resolveAgentHeaders(this.config, this.discoveredCard, this.authOptions),
    }

    let lastError: unknown
    for (const url of candidates) {
      try {
        const response = await this.fetchWithTimeout(
          url,
          {
            method: "GET",
            headers,
            signal: options?.signal,
          },
          Math.min(this.defaultTimeoutMs, 15_000),
        )
        if (!response.ok) {
          lastError = new Error(`Agent Card discovery returned HTTP ${response.status}`)
          await response.body?.cancel().catch(() => {})
          continue
        }
        const json = (await response.json()) as A2AAgentCard
        if (json && typeof json === "object" && (typeof json.name === "string" || Array.isArray(json.skills))) {
          this.discoveredCard = this.mergeWithStaticCard({
            ...json,
            name: json.name || this.agentId,
          })
          return this.discoveredCard
        }
      } catch (err) {
        lastError = err
      }
    }

    if (this.discoveredCard) {
      return this.discoveredCard
    }

    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError))
    }

    return null
  }

  private buildMethodPath(path: string, tenantOverride?: string): { url: string; protocolVersion: string } {
    const { endpoint, tenant, protocolVersion } = resolveRestEndpoint(this.config, this.discoveredCard)
    const target = new URL(endpoint)
    const configuredUrls = [this.config.url, this.config.baseUrl, this.config.endpoint, this.config.a2aUrl, this.config.agentCardUrl,
      this.config.card?.url, ...(this.config.card?.supportedInterfaces?.map((item) => item.url) ?? [])].filter((url): url is string => Boolean(url))
    if (!configuredUrls.some((url) => new URL(url).origin === target.origin)) {
      throw new Error("Discovered A2A endpoint has an unconfigured origin. Set endpoint explicitly to use it.")
    }
    const effectiveTenant = tenantOverride?.trim() || tenant
    const tenantPrefix = effectiveTenant ? `/${encodeURIComponent(effectiveTenant)}` : ""
    const normalizedPath = path.startsWith("/") ? path : `/${path}`
    return {
      url: `${endpoint}${tenantPrefix}${normalizedPath}`,
      protocolVersion,
    }
  }

  private buildRequestHeaders(acceptHeader = "application/a2a+json, application/json", protocolVersion = A2A_PROTOCOL_VERSION): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: acceptHeader,
      "A2A-Version": protocolVersion,
      ...resolveAgentHeaders(this.config, this.discoveredCard, this.authOptions),
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = this.defaultTimeoutMs): Promise<Response> {
    const target = new URL(url)
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      throw new Error("A2A URLs must use HTTP(S) without embedded credentials.")
    }
    // These signals remain active while the response body/SSE stream is consumed.
    const signals = init.signal ? [init.signal] : []
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: "error", // Custom token headers must never follow a redirect to another server.
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      })
    } catch {
      throw new Error("A2A request failed, was cancelled, or timed out. Check the configured endpoint and authentication.")
    }
  }

  private async throwHttpError(response: Response, _url: string): Promise<never> {
    await response.body?.cancel().catch(() => {})
    // Error pages can echo authentication headers, request bodies, and private URLs.
    throw new Error(`A2A HTTP ${response.status}`)
  }

  private buildSendMessageRequest(input: SendTurnInput): A2ASendMessageRequest {
    const parts: A2APart[] =
      Array.isArray(input.parts) && input.parts.length > 0
        ? input.parts
        : [{ text: input.text }]

    const msgMetadata: Record<string, unknown> = {
      ...input.metadata,
      ...input.messageMetadata,
    }
    const reqMetadata: Record<string, unknown> = {
      ...this.config.defaultMetadata,
      ...input.metadata,
    }

    if (input.skillId) {
      if (reqMetadata.skillId === undefined) reqMetadata.skillId = input.skillId
      if (reqMetadata.skill === undefined) reqMetadata.skill = input.skillId
      if (msgMetadata.skillId === undefined) msgMetadata.skillId = input.skillId
      if (msgMetadata.skill === undefined) msgMetadata.skill = input.skillId
    }

    const message: A2AMessage = {
      messageId: randomUUID(),
      role: "ROLE_USER",
      parts,
      ...(input.contextId ? { contextId: input.contextId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(Object.keys(msgMetadata).length > 0 ? { metadata: msgMetadata } : {}),
    }

    return {
      ...(this.config.tenant ? { tenant: this.config.tenant } : {}),
      message,
      ...(input.configuration ? { configuration: input.configuration } : {}),
      ...(Object.keys(reqMetadata).length > 0 ? { metadata: reqMetadata } : {}),
    }
  }

  /**
   * Sends a synchronous message via `POST /message:send`.
   */
  async sendMessage(input: SendTurnInput): Promise<A2AExecutionResult> {
    if (!this.discoveryAttempted && this.config.discover !== false) {
      await this.discoverAgentCard({ signal: input.signal }).catch(() => null)
    }

    const body = this.buildSendMessageRequest(input)
    const { url, protocolVersion } = this.buildMethodPath("/message:send", body.tenant)
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.buildRequestHeaders("application/a2a+json, application/json", protocolVersion),
      body: JSON.stringify(body),
      signal: input.signal,
    })

    if (!response.ok) {
      await this.throwHttpError(response, url)
    }

    const json = await response.json()
    const event = normalizeA2AEventPayload(json)
    const accumulator = new A2AEventAccumulator({
      agentId: this.agentId,
      agentName: this.displayName,
      onProgress: input.onProgress,
      responseMetadata: this.config.responseMetadata,
    })
    await accumulator.addEvent(event)
    return accumulator.buildResult()
  }

  /**
   * Sends a streaming message via `POST /message:stream` (SSE).
   */
  async streamMessage(input: SendTurnInput): Promise<A2AExecutionResult> {
    if (!this.discoveryAttempted && this.config.discover !== false) {
      await this.discoverAgentCard({ signal: input.signal }).catch(() => null)
    }

    const body = this.buildSendMessageRequest(input)
    const { url, protocolVersion } = this.buildMethodPath("/message:stream", body.tenant)
    const accumulator = new A2AEventAccumulator({
      agentId: this.agentId,
      agentName: this.displayName,
      onProgress: input.onProgress,
      responseMetadata: this.config.responseMetadata,
    })

    const autoCancel = this.config.autoCancelOnAbort ?? true
    let cancelTriggered = false
    const onAbort = () => {
      if (autoCancel && !cancelTriggered && accumulator.currentTaskId) {
        cancelTriggered = true
        void this.cancelTask({ id: accumulator.currentTaskId }).catch(() => {})
      }
    }

    if (input.signal) {
      input.signal.addEventListener("abort", onAbort, { once: true })
    }

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: this.buildRequestHeaders("text/event-stream", protocolVersion),
        body: JSON.stringify(body),
        signal: input.signal,
      })

      if (!response.ok) {
        await this.throwHttpError(response, url)
      }

      const contentType = response.headers.get("Content-Type") ?? ""
      if (contentType.includes("application/json") || contentType.includes("application/a2a+json")) {
        // Fallback if server answered /message:stream with a single JSON payload
        const json = await response.json()
        await accumulator.addEvent(normalizeA2AEventPayload(json))
        return accumulator.buildResult()
      }

      for await (const frame of parseSseResponse(response)) {
        if (frame.type === "error") {
          let errPayload: unknown
          try {
            errPayload = JSON.parse(frame.data)
          } catch {
            throw new Error(`A2A SSE error: ${frame.data}`)
          }
          await accumulator.addEvent(normalizeA2AEventPayload(errPayload))
          continue
        }

        const trimmed = frame.data.trim()
        if (!trimmed || trimmed === "[DONE]") continue
        const parsed = JSON.parse(trimmed)
        const event = normalizeA2AEventPayload(parsed)
        await accumulator.addEvent(event)
      }

      return accumulator.buildResult()
    } finally {
      if (input.signal) {
        input.signal.removeEventListener("abort", onAbort)
      }
    }
  }

  /**
   * Executes a conversation turn, automatically choosing between `POST /message:stream`
   * and `POST /message:send` based on `input.stream`, `config.streaming`, or `AgentCard.capabilities.streaming`.
   */
  async executeTurn(input: SendTurnInput): Promise<A2AExecutionResult> {
    if (!this.discoveryAttempted && this.config.discover !== false) {
      await this.discoverAgentCard({ signal: input.signal }).catch(() => null)
    }

    const useStreaming =
      input.stream !== undefined
        ? input.stream
        : this.config.streaming !== undefined
          ? this.config.streaming
          : Boolean(this.discoveredCard?.capabilities?.streaming)

    if (useStreaming) {
      return await this.streamMessage(input)
    }
    return await this.sendMessage(input)
  }

  /**
   * Retrieves a Task by ID via `GET /tasks/{id}`.
   */
  async getTask(
    params: A2AGetTaskRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{ task: A2ATask; result: A2AExecutionResult }> {
    const query = new URLSearchParams()
    if (params.historyLength !== undefined) {
      query.set("historyLength", String(params.historyLength))
    }
    const qs = query.toString()
    const path = `/tasks/${encodeURIComponent(params.id)}${qs ? `?${qs}` : ""}`
    const { url, protocolVersion } = this.buildMethodPath(path, params.tenant)

    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.buildRequestHeaders("application/a2a+json, application/json", protocolVersion),
      signal: options?.signal,
    })

    if (!response.ok) {
      await this.throwHttpError(response, url)
    }

    const json = await response.json()
    const normalized = normalizeA2AEventPayload(json)
    const task = normalized.task ?? (json as A2ATask)
    const accumulator = new A2AEventAccumulator({
      agentId: this.agentId,
      agentName: this.displayName,
      responseMetadata: this.config.responseMetadata,
    })
    await accumulator.addEvent({ task })
    return {
      task,
      result: accumulator.buildResult(),
    }
  }

  /**
   * Cancels a Task by ID via `POST /tasks/{id}:cancel`.
   */
  async cancelTask(
    params: A2ACancelTaskRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{ task: A2ATask; result: A2AExecutionResult }> {
    const path = `/tasks/${encodeURIComponent(params.id)}:cancel`
    const { url, protocolVersion } = this.buildMethodPath(path, params.tenant)
    const body = params.metadata ? { metadata: params.metadata } : {}

    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.buildRequestHeaders("application/a2a+json, application/json", protocolVersion),
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!response.ok) {
      await this.throwHttpError(response, url)
    }

    const json = await response.json()
    const normalized = normalizeA2AEventPayload(json)
    const task = normalized.task ?? (json as A2ATask)
    const accumulator = new A2AEventAccumulator({
      agentId: this.agentId,
      agentName: this.displayName,
      responseMetadata: this.config.responseMetadata,
    })
    await accumulator.addEvent({ task })
    return {
      task,
      result: accumulator.buildResult(),
    }
  }

  /**
   * Lists tasks via `GET /tasks`.
   */
  async listTasks(
    params?: A2AListTasksRequest,
    options?: { signal?: AbortSignal },
  ): Promise<A2AListTasksResponse> {
    const query = new URLSearchParams()
    if (params?.contextId) query.set("contextId", params.contextId)
    if (params?.status && params.status !== "TASK_STATE_UNSPECIFIED") query.set("status", params.status)
    if (params?.pageSize !== undefined && params.pageSize > 0) query.set("pageSize", String(params.pageSize))
    if (params?.pageToken) query.set("pageToken", params.pageToken)
    if (params?.historyLength !== undefined) query.set("historyLength", String(params.historyLength))
    if (params?.statusTimestampAfter) query.set("statusTimestampAfter", params.statusTimestampAfter)
    if (params?.includeArtifacts !== undefined) query.set("includeArtifacts", String(params.includeArtifacts))

    const qs = query.toString()
    const path = `/tasks${qs ? `?${qs}` : ""}`
    const { url, protocolVersion } = this.buildMethodPath(path, params?.tenant)

    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.buildRequestHeaders("application/a2a+json, application/json", protocolVersion),
      signal: options?.signal,
    })

    if (!response.ok) {
      await this.throwHttpError(response, url)
    }

    return (await response.json()) as A2AListTasksResponse
  }

  /**
   * Fetches the authenticated Extended AgentCard via `GET /extendedAgentCard`.
   */
  async getExtendedAgentCard(options?: { tenant?: string; signal?: AbortSignal }): Promise<A2AAgentCard> {
    const { url, protocolVersion } = this.buildMethodPath("/extendedAgentCard", options?.tenant)
    const response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.buildRequestHeaders("application/a2a+json, application/json", protocolVersion),
      signal: options?.signal,
    })

    if (!response.ok) {
      await this.throwHttpError(response, url)
    }

    const card = (await response.json()) as A2AAgentCard
    this.discoveredCard = this.mergeWithStaticCard(card)
    return this.discoveredCard
  }
}
