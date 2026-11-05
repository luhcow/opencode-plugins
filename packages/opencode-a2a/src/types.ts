/**
 * Google A2A SDK (HTTP+JSON REST binding) protocol and plugin configuration types.
 * Compatible with A2A v1.0 (`a2a-go/v2`, `@a2a-js/sdk`, `a2a-python`) and v0.3 AgentCard formats.
 */

export type A2ARole = "ROLE_USER" | "ROLE_AGENT" | "ROLE_UNSPECIFIED" | "user" | "agent"

/** Fetch call signature without runtime-specific static helpers. */
export type A2AFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type A2ATaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_REJECTED"
  | "submitted"
  | "working"
  | "completed"
  | "failed"
  | "canceled"
  | "input-required"
  | "auth-required"
  | "rejected"
  | "unknown"

export interface A2APart {
  text?: string
  raw?: string
  data?: unknown
  url?: string
  filename?: string
  mediaType?: string
  metadata?: Record<string, unknown>
  /** Optional v0.3 / legacy union format compatibility */
  kind?: string
  content?: {
    $case?: string
    value?: unknown
  }
}

export interface A2AMessage {
  messageId: string
  role: A2ARole
  parts: A2APart[]
  contextId?: string
  taskId?: string
  referenceTaskIds?: string[]
  extensions?: string[]
  metadata?: Record<string, unknown>
}

export interface A2AArtifact {
  artifactId: string
  name?: string
  description?: string
  parts: A2APart[]
  extensions?: string[]
  metadata?: Record<string, unknown>
}

export interface A2ATaskStatus {
  state: A2ATaskState
  message?: A2AMessage
  timestamp?: string
}

export interface A2ATask {
  id: string
  contextId: string
  status: A2ATaskStatus
  artifacts?: A2AArtifact[]
  history?: A2AMessage[]
  metadata?: Record<string, unknown>
}

export interface A2ATaskStatusUpdateEvent {
  taskId: string
  contextId: string
  status: A2ATaskStatus
  final?: boolean
  metadata?: Record<string, unknown>
}

export interface A2ATaskArtifactUpdateEvent {
  taskId: string
  contextId: string
  artifact: A2AArtifact
  append?: boolean
  lastChunk?: boolean
  metadata?: Record<string, unknown>
}

export interface A2AStreamResponse {
  task?: A2ATask
  message?: A2AMessage
  statusUpdate?: A2ATaskStatusUpdateEvent
  artifactUpdate?: A2ATaskArtifactUpdateEvent
  error?: A2ARestErrorStatus
}

export interface A2ASendMessageConfig {
  acceptedOutputModes?: string[]
  returnImmediately?: boolean
  historyLength?: number
  blocking?: boolean
}

export interface A2ASendMessageRequest {
  tenant?: string
  message: A2AMessage
  configuration?: A2ASendMessageConfig
  metadata?: Record<string, unknown>
}

export interface A2AGetTaskRequest {
  id: string
  tenant?: string
  historyLength?: number
}

export interface A2ACancelTaskRequest {
  id: string
  tenant?: string
  metadata?: Record<string, unknown>
}

export interface A2AListTasksRequest {
  tenant?: string
  contextId?: string
  status?: A2ATaskState
  pageSize?: number
  pageToken?: string
  historyLength?: number
  statusTimestampAfter?: string
  includeArtifacts?: boolean
}

export interface A2AListTasksResponse {
  tasks: A2ATask[]
  nextPageToken?: string
  pageSize?: number
  totalSize?: number
}

export interface A2ARestErrorDetail {
  "@type"?: string
  reason?: string
  domain?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface A2ARestErrorStatus {
  code?: number
  status?: string
  message?: string
  details?: A2ARestErrorDetail[]
}

export interface A2AAgentInterface {
  url: string
  protocolBinding?: string
  protocolVersion?: string
  tenant?: string
}

export interface A2AAgentCapabilities {
  streaming?: boolean
  pushNotifications?: boolean
  stateTransitionHistory?: boolean
  extensions?: unknown[]
}

export interface A2AApiKeySecurityScheme {
  description?: string
  location?: "header" | "query" | "cookie" | string
  in?: "header" | "query" | "cookie" | string
  name?: string
}

export interface A2AHttpAuthSecurityScheme {
  description?: string
  scheme?: string
  bearerFormat?: string
}

export interface A2ASecurityScheme {
  /** A2A v1.0 protobuf JSON nested format */
  apiKeySecurityScheme?: A2AApiKeySecurityScheme
  httpAuthSecurityScheme?: A2AHttpAuthSecurityScheme
  openIdConnectSecurityScheme?: {
    description?: string
    openIdConnectUrl?: string
  }
  oauth2SecurityScheme?: Record<string, unknown>
  /** A2A v0.3 / OpenAPI flat format */
  type?: "apiKey" | "http" | "oauth2" | "openIdConnect" | string
  in?: "header" | "query" | "cookie" | string
  location?: "header" | "query" | "cookie" | string
  name?: string
  scheme?: string
  description?: string
}

export interface A2AAgentSkill {
  id: string
  name: string
  description?: string
  tags?: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
  /** Optional JSON Schema descriptor for structured skill arguments (a2a-mcp-skillmap extension). */
  inputSchema?: Record<string, unknown>
}

export interface A2AAgentCard {
  name: string
  description?: string
  version?: string
  /** A2A v0.3 direct endpoint URL */
  url?: string
  /** A2A v1.0 supported interfaces */
  supportedInterfaces?: A2AAgentInterface[]
  capabilities?: A2AAgentCapabilities
  defaultInputModes?: string[]
  defaultOutputModes?: string[]
  skills?: A2AAgentSkill[]
  securitySchemes?: Record<string, A2ASecurityScheme>
  securityRequirements?: Array<{
    schemes?: Record<string, string[]>
    [key: string]: unknown
  }>
  security?: Array<Record<string, string[]>>
  provider?: {
    url?: string
    organization?: string
  }
  documentationUrl?: string
}

/**
 * Flexible token/authentication configuration for an A2A Agent endpoint.
 */
export interface A2AAuthConfig {
  /**
   * Authentication type hint:
   * - `"bearer"`: `Authorization: Bearer <token>` (or custom `header` + `scheme`)
   * - `"header"` / `"apiKey"`: `<header>: <token>` (e.g. `X-User-Token: <token>`)
   * - `"auto"` (default): inspects `header` / `AgentCard.securitySchemes`
   */
  type?: "bearer" | "header" | "apiKey" | "auto" | "none"
  /**
   * Direct token value or interpolation expression:
   * - `{file:~/.config/opencode/secrets/agent-token}`
   * - `{env:A2A_TOKEN}`
   * - `$A2A_TOKEN` or `${A2A_TOKEN}`
   * - `file://~/.config/opencode/secrets/agent-token`
   * - Literal token string
   */
  token?: string
  /**
   * Read token from a local file path (supports `~/...`).
   * Example: `"~/.config/opencode/secrets/agent-token"`
   */
  tokenFile?: string
  /**
   * Read token from an environment variable name.
   * Example: `"A2A_TOKEN"`
   */
  tokenEnv?: string
  /**
   * HTTP header name to carry the token (e.g. `"X-User-Token"` or `"Authorization"`).
   * When omitted, inferred from `AgentCard.securitySchemes` or defaults to `"Authorization"`.
   */
  header?: string
  /**
   * Optional prefix/scheme added before the token value (e.g. `"Bearer"` or `""`).
   * Defaults to `"Bearer"` when `header` is `"Authorization"`, and `""` for custom headers like `"X-User-Token"`.
   */
  scheme?: string
  /** Alias for `scheme` */
  prefix?: string
}

/**
 * Static or override configuration for an individual A2A Skill.
 */
export interface A2ASkillConfig {
  id: string
  name?: string
  description?: string
  tags?: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
  inputSchema?: Record<string, unknown>
  /** Override the exposed OpenCode tool name for this skill */
  toolName?: string
  /** Extra metadata merged into `SendMessageRequest.metadata` and `Message.metadata` when calling this skill */
  metadata?: Record<string, unknown>
}

export type A2ASkillExposureMode = boolean | "all" | "export" | "configured" | "none"

export type A2AToolNamingStyle = "double_underscore" | "a2a_prefix"

export type A2AFallbackSkillMode = "message" | "none"

/** Optional mappings for non-standard response metadata. Standard A2A fields are the default. */
export interface A2AResponseMetadata {
  contextIdKey?: string
  contentTypeKey?: string
}

/**
 * Configuration for a single A2A Agent endpoint.
 */
export interface A2AAgentConfig {
  /** Unique agent identifier (used in tool names such as `a2a_<id>`). */
  id?: string
  /** Human-readable agent name override. */
  name?: string
  /** Agent description override. */
  description?: string
  /** Whether this agent is enabled (default: `true`). */
  enabled?: boolean
  /**
   * Base server URL or Agent Card URL.
   * Examples:
   * - `"https://agent.example.com"`
   * - `"https://agent.example.com/.well-known/agent-card.json"`
   * - `"https://agent.example.com/a2a"`
   */
  url?: string
  /** Alias for `url`. */
  baseUrl?: string
  /**
   * Explicit A2A HTTP+JSON REST base endpoint URL (e.g. `"https://agent.example.com/a2a"`).
   * When omitted, automatically resolved from `AgentCard.supportedInterfaces` (`HTTP+JSON`),
   * `AgentCard.url`, or `<url>/a2a`.
   */
  endpoint?: string
  /** Alias for `endpoint`. */
  a2aUrl?: string
  /**
   * Full URL to the Agent Card JSON document.
   * Overrides `url` + `cardPath` when discovering the Agent Card.
   */
  agentCardUrl?: string
  /**
   * Relative path to the Agent Card joined to `url` (default: `"/.well-known/agent-card.json"`).
   * Pass `""` if `url` is already the full Agent Card URL.
   */
  cardPath?: string
  /** Optional A2A tenant segment (`/{tenant}/message:send`). */
  tenant?: string
  /**
   * Whether to automatically fetch `/.well-known/agent-card.json` on startup / first call
   * (default: `true`).
   */
  discover?: boolean
  /** Optional static / fallback AgentCard when `discover` is false or server is unreachable at startup. */
  card?: Partial<A2AAgentCard>
  /**
   * Whether to use SSE streaming (`POST /message:stream`) instead of synchronous `POST /message:send`.
   * When omitted (`undefined`), automatically uses `true` if `AgentCard.capabilities.streaming` is true.
   */
  streaming?: boolean
  /**
   * Authentication / Token configuration.
   */
  auth?: A2AAuthConfig
  /** Shorthand for `auth.token`. */
  token?: string
  /** Shorthand for `auth.tokenFile`. */
  tokenFile?: string
  /** Shorthand for `auth.tokenEnv`. */
  tokenEnv?: string
  /** Shorthand for `auth.header` (e.g. `"X-User-Token"` or `"Authorization"`). */
  tokenHeader?: string
  /** Shorthand for `auth.scheme` (e.g. `"Bearer"` or `""`). */
  tokenScheme?: string
  /**
   * Custom HTTP headers sent on every request.
   * Values support `{file:...}`, `{env:...}`, and `${VAR}` interpolation!
   * Example: `{ "X-API-Key": "{file:~/.config/opencode/secrets/agent-token}" }`
   */
  headers?: Record<string, string>
  /**
   * How Agent Card skills are exposed as OpenCode tools:
   * - `true` / `"all"`: Expose every discovered/configured skill as a tool (`a2a_<agent>_<skill>`)
   * - `"export"`: Only expose skills tagged with `"export"` (plus any explicitly listed in `skills` / `includeSkills`)
   * - `"configured"`: Only expose skills explicitly configured in `skills` / `includeSkills`
   * - `false` / `"none"` (default when omitted is `true` if skills are filtered/configured, or configurable): Only expose the unified agent tool `a2a_<agent>` (with `skill` parameter)
   * Default: `true`
   */
  exposeSkills?: A2ASkillExposureMode
  /**
   * Static skill definitions or skill ID whitelist.
   * When provided as string IDs or `A2ASkillConfig` objects, filters discovered skills (and merges custom definitions).
   */
  skills?: Array<string | A2ASkillConfig>
  /** Whitelist of skill IDs to expose as individual tools. */
  includeSkills?: string[]
  /** Blacklist of skill IDs to exclude from individual tool registration. */
  excludeSkills?: string[]
  /** Only expose skills having at least one of these tags (e.g. `["export"]`). */
  includeTags?: string[]
  /** Exclude skills having any of these tags (e.g. `["internal"]`). */
  excludeTags?: string[]
  /** Custom tool name for the main agent tool (default: `a2a_<agentId>`). */
  toolName?: string
  /** Custom prefix for skill tools (default: `<agentId>` or `a2a_<agentId>` depending on `namingStyle`). */
  toolPrefix?: string
  /**
   * Tool naming convention for skill tools:
   * - `"double_underscore"`: `<agent>__<skill_id>` (e.g. `example__search`)
   * - `"a2a_prefix"`: `a2a_<agent>_<skill_id>` (e.g. `a2a_example_search`)
   * - `"both"`: Register both `<agent>__<skill_id>` and `a2a_<agent>_<skill_id>`
   */
  namingStyle?: A2AToolNamingStyle | "both"
  /**
   * Whether to synthesize a fallback `message` skill when the Agent Card advertises zero skills
   * (a2a-mcp-skillmap `applyFallbackSkill` behavior, default: `"message"`).
   */
  fallbackTool?: A2AFallbackSkillMode
  /** Whether to register a dedicated `<toolPrefix>_task` tool for `tasks/{id}` get/cancel (default: `true`). */
  exposeTaskTool?: boolean
  /** Whether to register a unified agent dispatch tool `a2a_<agentId>` alongside skill tools (default: `true`). */
  exposeAgentTool?: boolean
  /**
   * Automatically track and reuse `contextId` per OpenCode `sessionID` for multi-turn conversations
   * when `contextId` is not explicitly specified (default: `true`).
   */
  autoContext?: boolean
  /**
   * Automatically call `POST /tasks/{id}:cancel` when the OpenCode tool call's AbortSignal fires
   * and an in-flight `taskId` is known (default: `true`).
   */
  autoCancelOnAbort?: boolean
  /**
   * Include reasoning / thought parts (`metadata.adk_thought === true`) in tool output (default: `false`).
   */
  includeReasoning?: boolean
  /** Opt-in mappings for server-specific context IDs or JSON text payloads. */
  responseMetadata?: A2AResponseMetadata
  /** Default metadata merged into every `SendMessageRequest.metadata` (e.g. `{ lang: "zh_CN" }`). */
  defaultMetadata?: Record<string, unknown>
  /** Request timeout in milliseconds (default: `300000` = 5 minutes). */
  timeoutMs?: number
}

/**
 * Top-level plugin options for `opencode-a2a`.
 */
export interface A2APluginOptions {
  /**
   * Multiple A2A Agent configurations as an array or a map keyed by agent ID.
   */
  agents?: A2AAgentConfig[] | Record<string, A2AAgentConfig>
  /**
   * Global prefix for registered tools (default: `"a2a"`).
   */
  toolPrefix?: string
  /**
   * Default tool naming style across all agents:
   * - `"double_underscore"`: `<agent>__<skill_id>` (a2a-mcp-skillmap style)
   * - `"a2a_prefix"`: `a2a_<agent>_<skill_id>`
   * - `"both"`: Register both
   * Default: `"double_underscore"`
   */
  namingStyle?: A2AToolNamingStyle | "both"
  /**
   * Fallback skill synthesis mode when an Agent Card has 0 skills (default: `"message"`).
   */
  fallbackTool?: A2AFallbackSkillMode
  /**
   * Default timeout in milliseconds for A2A requests (default: `300000`).
   */
  timeoutMs?: number
  /**
   * Default `exposeSkills` mode across all agents (default: `true`).
   */
  exposeSkills?: A2ASkillExposureMode
  /**
   * Default `exposeAgentTool` across all agents (default: `true`).
   */
  exposeAgentTool?: boolean
  /**
   * Default `exposeTaskTool` across all agents (default: `true`).
   */
  exposeTaskTool?: boolean
  /**
   * Default `autoContext` across all agents (default: `true`).
   */
  autoContext?: boolean
  /**
   * Default `includeReasoning` across all agents (default: `false`).
   */
  includeReasoning?: boolean
  /**
   * Custom fetch implementation (useful for unit testing or custom proxies).
   */
  fetch?: A2AFetch
}

export interface A2AProgressUpdate {
  taskId?: string
  contextId?: string
  state?: A2ATaskState
  stepText?: string
  deltaText?: string
  thoughtDelta?: string
}

export interface A2AExecutionResult {
  agentId: string
  agentName: string
  taskId?: string
  contextId?: string
  state?: A2ATaskState
  answerText: string
  reasoningText: string
  statusText: string
  steps: string[]
  structuredPayloads: Array<{
    contentType?: string
     mediaType?: string
    data: unknown
  }>
  inputRequired: boolean
  inputRequiredPrompt?: string
  task?: A2ATask
  message?: A2AMessage
  rawEventsCount: number
}
