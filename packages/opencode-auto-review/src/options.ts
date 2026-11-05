import { DECISIONS_DEADLINE_MS } from "./decisions.js"

export interface HumanReviewRule {
  action?: string
  resource?: string
  reason: string
}

export interface ReviewerModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface PluginOptions {
  enabled: boolean
  agent: string
  /** Primary model (`provider/model[#variant]`), either a `decision` or `chat` model. */
  model?: string
  /**
   * Optional secondary synchronous `chat` reviewer model (`provider/model[#variant]`)
   * used when a primary `decision` model returns `"high"` risk or fails, matching
   * Codex Guardian V2 -> Guardian Reviewer escalation.
   */
  reviewModel?: string
  /** Overall synchronous review timeout (Codex `REVIEW_TIMEOUT = 90s`). */
  timeoutMs: number
  /** Fast `/v1/decisions` classification timeout (Codex `DEADLINE = 6s`). */
  decisionTimeoutMs: number
  actions: string[]
  humanReviewRules: HumanReviewRule[]
  /** When false, an action needing human confirmation becomes a deny so unattended work does not stall. */
  humanFallback: boolean
  /** Optional extra policy appended to the Guardian security policy (`guardian_extra_policy`). */
  extraPolicy: string
  debug: boolean
}

export const DEFAULT_OPTIONS: PluginOptions = {
  enabled: true,
  agent: "auto-reviewer",
  timeoutMs: 90_000,
  decisionTimeoutMs: DECISIONS_DEADLINE_MS,
  actions: ["read", "edit", "glob", "grep", "shell", "webfetch", "websearch", "external_directory"],
  humanReviewRules: [],
  humanFallback: false,
  extraPolicy: "",
  debug: false,
}

const ALLOWED_KEYS = new Set([
  "enabled",
  "agent",
  "model",
  "reviewModel",
  "timeoutMs",
  "decisionTimeoutMs",
  "actions",
  "humanReviewRules",
  "humanFallback",
  "extraPolicy",
  "debug",
])

export function parseOptions(input: unknown): PluginOptions {
  if (!isRecord(input)) return { ...DEFAULT_OPTIONS, actions: [...DEFAULT_OPTIONS.actions], humanReviewRules: [] }
  const unknownKey = Object.keys(input).find((key) => !ALLOWED_KEYS.has(key))
  if (unknownKey) throw new TypeError(`plugin options contains unknown key: ${unknownKey}`)

  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new TypeError("enabled must be a boolean")
  }
  const agent = input.agent === undefined ? DEFAULT_OPTIONS.agent : requiredString(input.agent, "agent", 128)
  const model = optionalModelString(input.model, "model")
  const reviewModel = optionalReviewModelString(input.reviewModel)
  const timeoutMs = integerOption(input.timeoutMs, DEFAULT_OPTIONS.timeoutMs, 1_000, 600_000, "timeoutMs")
  const decisionTimeoutMs = integerOption(
    input.decisionTimeoutMs,
    DEFAULT_OPTIONS.decisionTimeoutMs,
    500,
    120_000,
    "decisionTimeoutMs",
  )
  const actions = input.actions === undefined ? [...DEFAULT_OPTIONS.actions] : stringArray(input.actions, "actions")
  const humanReviewRules = parseHumanReviewRules(input.humanReviewRules)
  if (input.humanFallback !== undefined && typeof input.humanFallback !== "boolean") {
    throw new TypeError("humanFallback must be a boolean")
  }
  if (input.extraPolicy !== undefined && typeof input.extraPolicy !== "string") {
    throw new TypeError("extraPolicy must be a string")
  }
  if (input.debug !== undefined && typeof input.debug !== "boolean") {
    throw new TypeError("debug must be a boolean")
  }

  return {
    enabled: input.enabled !== false,
    agent,
    ...(model ? { model } : {}),
    ...(reviewModel ? { reviewModel } : {}),
    timeoutMs,
    decisionTimeoutMs,
    actions,
    humanReviewRules,
    humanFallback: input.humanFallback === true,
    extraPolicy: typeof input.extraPolicy === "string" ? input.extraPolicy : "",
    debug: input.debug === true,
  }
}

export function parseModelRef(value: string): ReviewerModelRef | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  const providerID = value.slice(0, slash)
  const modelAndVariant = value.slice(slash + 1)
  const hash = modelAndVariant.lastIndexOf("#")
  if (hash < 0) return { providerID, id: modelAndVariant }
  const id = modelAndVariant.slice(0, hash)
  const variant = modelAndVariant.slice(hash + 1)
  if (!id || !variant) return undefined
  return { providerID, id, variant }
}

export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith(" *") && value === pattern.slice(0, -2)) return true
  let source = ""
  for (const char of pattern) {
    if (char === "*") source += ".*"
    else if (char === "?") source += "."
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`, "s").test(value)
}

export function isEligibleAction(action: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(action, pattern))
}

export function findHumanReviewReason(
  action: string,
  resources: readonly string[],
  rules: readonly HumanReviewRule[],
): string | undefined {
  let reason: string | undefined
  for (const rule of rules) {
    if (rule.action && !matchesPattern(action, rule.action)) continue
    if (rule.resource && !resources.some((resource) => matchesPattern(resource, rule.resource!))) continue
    reason = rule.reason
  }
  return reason
}

function optionalModelString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  const str = requiredString(value, name, 512)
  if (!/^[^/#\s]+\/[^/#\s]+(?:\/[^/#\s]+)*(?:#[^#\s]+)?$/.test(str)) {
    throw new TypeError(`${name} must use provider/model[#variant] format`)
  }
  return str
}

function optionalReviewModelString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const str = requiredString(value, "reviewModel", 512)
  if (str === "none" || str === "off") return str
  return optionalModelString(str, "reviewModel")
}

function parseHumanReviewRules(value: unknown): HumanReviewRule[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError("humanReviewRules must be an array")
  if (value.length > 128) throw new TypeError("humanReviewRules cannot contain more than 128 rules")
  const allowedKeys = new Set(["action", "resource", "reason"])
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`humanReviewRules[${index}] must be an object`)
    const unknown = Object.keys(item).find((key) => !allowedKeys.has(key))
    if (unknown) throw new TypeError(`humanReviewRules[${index}] contains unknown key: ${unknown}`)
    if (typeof item.reason !== "string" || !item.reason.trim() || Buffer.byteLength(item.reason, "utf8") > 512) {
      throw new TypeError(`humanReviewRules[${index}].reason must be 1-512 bytes`)
    }
    if (item.action !== undefined && (typeof item.action !== "string" || !item.action)) {
      throw new TypeError(`humanReviewRules[${index}].action must be a non-empty string`)
    }
    if (item.resource !== undefined && (typeof item.resource !== "string" || !item.resource)) {
      throw new TypeError(`humanReviewRules[${index}].resource must be a non-empty string`)
    }
    return {
      ...(typeof item.action === "string" ? { action: item.action } : {}),
      ...(typeof item.resource === "string" ? { resource: item.resource } : {}),
      reason: item.reason.trim(),
    }
  })
}

function stringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    value.some((item) => typeof item !== "string" || !item || Buffer.byteLength(item, "utf8") > 256)
  ) {
    throw new TypeError(`${name} must be a non-empty array of non-empty strings`)
  }
  return [...value]
}

function requiredString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError(`${name} must be a non-empty string no longer than ${maxBytes} bytes`)
  }
  return value.trim()
}

function integerOption(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
