import { createHash } from "node:crypto"
import type { ResolvedSkill } from "./client.ts"
import type { A2AFallbackSkillMode, A2AToolNamingStyle } from "./types.ts"

/** Maximum tool name length (matches MCP & OpenCode tool name limits). */
export const MAX_TOOL_NAME_LENGTH = 64

/** Reserved tag marking a synthesized fallback skill (`a2a-mcp-skillmap` convention). */
export const FALLBACK_SKILL_TAG = "__bridge-fallback__"

/** Reserved skill ID for the fallback message skill. */
export const FALLBACK_SKILL_ID = "message"

const ALLOWED_NAME_REGEX = /^[a-zA-Z0-9_-]+$/

function sanitizeSegment(segment: string): string {
  if (!segment) return ""
  return segment.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8)
}

export function safeSegment(raw: string): string {
  const clean = sanitizeSegment(raw)
  if (clean.length === 0) return `h${shortHash(raw)}`
  return clean
}

export function truncateWithHash(name: string, maxLen: number = MAX_TOOL_NAME_LENGTH): string {
  if (name.length <= maxLen) return name
  const hash = shortHash(name)
  const keep = maxLen - hash.length - 1
  if (keep <= 0) return hash.slice(0, maxLen)
  return `${name.slice(0, keep)}-${hash}`
}

export interface ToolNamingStrategy {
  deriveName(agentId: string, skillId: string): string
  deriveNameWithNamespace(agentUrl: string, agentId: string, skillId: string): string
  isValid(name: string): boolean
}

/**
 * Deterministic tool-naming strategy modeled after `a2a-mcp-skillmap`'s `DefaultToolNamingStrategy`.
 * Supports both `<agent>__<skill_id>` (`double_underscore`) and `a2a_<agent>_<skill_id>` (`a2a_prefix`).
 */
export class DefaultToolNamingStrategy implements ToolNamingStrategy {
  readonly maxLength: number
  readonly style: A2AToolNamingStyle
  readonly prefix: string

  constructor(options?: {
    maxLength?: number
    style?: A2AToolNamingStyle
    prefix?: string
  }) {
    this.maxLength = options?.maxLength ?? MAX_TOOL_NAME_LENGTH
    this.style = options?.style ?? "double_underscore"
    this.prefix = options?.prefix ?? "a2a"
  }

  deriveName(agentId: string, skillId: string): string {
    const agent = safeSegment(String(agentId ?? ""))
    const skill = safeSegment(String(skillId ?? ""))
    if (this.style === "a2a_prefix") {
      const pfx = safeSegment(this.prefix || "a2a")
      const normalizedAgent = agent.replace(/-/g, "_")
      const normalizedSkill = skill.replace(/-/g, "_")
      const base = normalizedAgent.startsWith(`${pfx}_`) ? normalizedAgent : `${pfx}_${normalizedAgent}`
      return truncateWithHash(`${base}_${normalizedSkill}`, this.maxLength)
    }
    const raw = `${agent}__${skill}`
    return truncateWithHash(raw, this.maxLength)
  }

  deriveNameWithNamespace(agentUrl: string, agentId: string, skillId: string): string {
    const ns = `ns${shortHash(agentUrl)}`
    const agent = safeSegment(String(agentId ?? ""))
    const skill = safeSegment(String(skillId ?? ""))
    if (this.style === "a2a_prefix") {
      const pfx = safeSegment(this.prefix || "a2a")
      const normalizedAgent = agent.replace(/-/g, "_")
      const normalizedSkill = skill.replace(/-/g, "_")
      return truncateWithHash(`${pfx}_${ns}_${normalizedAgent}_${normalizedSkill}`, this.maxLength)
    }
    const raw = `${ns}__${agent}__${skill}`
    return truncateWithHash(raw, this.maxLength)
  }

  isValid(name: string): boolean {
    if (typeof name !== "string") return false
    if (name.length === 0 || name.length > this.maxLength) return false
    return ALLOWED_NAME_REGEX.test(name)
  }
}

/**
 * Synthesizes a fallback `message` skill when an A2A Agent Card advertises zero skills,
 * matching `a2a-mcp-skillmap`'s `applyFallbackSkill`.
 */
export function applyFallbackSkill(
  agent: {
    id: string
    name: string
    description?: string
    skills: ResolvedSkill[]
  },
  mode: A2AFallbackSkillMode = "message",
): ResolvedSkill[] {
  if (mode === "none") return agent.skills
  if (agent.skills.length > 0) return agent.skills

  const identity =
    agent.description && agent.description.trim().length > 0
      ? `${agent.name} — ${agent.description.trim()}`
      : agent.name

  const synthetic: ResolvedSkill = {
    id: FALLBACK_SKILL_ID,
    name: "Send message",
    description: `${identity}. This agent advertises no skills; send it a free-form message.`,
    tags: [FALLBACK_SKILL_TAG],
    inputModes: ["text"],
    outputModes: ["text"],
  }

  return [synthetic]
}

export function isFallbackSkill(skill: Pick<ResolvedSkill, "tags">): boolean {
  return Array.isArray(skill.tags) && skill.tags.includes(FALLBACK_SKILL_TAG)
}

/**
 * Formats a rich tool description for an individual A2A Skill tool by injecting
 * the skill's `description`, `tags`, `examples`, and agent identity.
 */
export function buildSkillToolDescription(
  agent: { id: string; name: string; description?: string },
  skill: ResolvedSkill,
): string {
  const lines: string[] = []

  const headerTitle =
    skill.name && skill.name !== skill.id ? `${skill.name} (${skill.id})` : skill.id
  lines.push(`[A2A Agent: ${agent.name} (${agent.id}) | Skill: ${headerTitle}]`)

  if (skill.description && skill.description.trim()) {
    lines.push(skill.description.trim())
  } else if (agent.description && agent.description.trim()) {
    lines.push(`${agent.description.trim()} (Skill: ${headerTitle})`)
  } else {
    lines.push(`Invoke skill "${headerTitle}" on A2A agent "${agent.name}".`)
  }

  const visibleTags = (skill.tags ?? []).filter((t) => t && t !== FALLBACK_SKILL_TAG)
  if (visibleTags.length > 0) {
    lines.push(`Tags: ${visibleTags.join(", ")}`)
  }

  const examples = (skill.examples ?? []).map((e) => e.trim()).filter(Boolean)
  if (examples.length > 0) {
    lines.push(`Examples:\n${examples.map((ex) => `- "${ex}"`).join("\n")}`)
  }

  lines.push(
    "Supports multi-turn conversation continuity via `contextId` / `sessionId` (automatically tracked per OpenCode session unless `newContext: true` is passed).",
  )

  return lines.join("\n\n")
}

/**
 * Builds the JSON Schema input definition for a skill tool, merging any custom
 * `skill.inputSchema` properties with standard A2A message & session continuity fields.
 */
export function buildSkillToolInputSchema(skill: ResolvedSkill): Record<string, unknown> {
  const baseProperties: Record<string, unknown> = {
    message: {
      type: "string",
      description: `Message or natural-language instruction to send to skill "${skill.name || skill.id}".`,
    },
    contextId: {
      type: "string",
      description:
        "Optional A2A contextId for multi-turn conversation continuity. Automatically reuses the current OpenCode session's contextId when omitted.",
    },
    sessionId: {
      type: "string",
      description:
        "Alias for contextId (a2a-mcp-skillmap compatibility). Pass back the sessionId/contextId from a previous call to continue the same conversation thread.",
    },
    taskId: {
      type: "string",
      description: "Optional A2A taskId when continuing or referencing a specific task.",
    },
    newContext: {
      type: "boolean",
      description: "Set to true to force starting a fresh A2A conversation context instead of reusing the current session context.",
    },
    metadata: {
      type: "object",
      description:
        "Optional extra metadata merged into SendMessageRequest.metadata and Message.metadata (e.g., { lang: 'zh_CN', action_param: {...} }).",
      additionalProperties: true,
    },
    stream: {
      type: "boolean",
      description:
        "Optional override for SSE streaming (true uses POST /message:stream, false uses POST /message:send).",
    },
  }

  const customSchema = skill.inputSchema
  if (
    customSchema &&
    typeof customSchema === "object" &&
    customSchema.type === "object" &&
    customSchema.properties &&
    typeof customSchema.properties === "object" &&
    !Array.isArray(customSchema.properties)
  ) {
    const customProps = customSchema.properties as Record<string, unknown>
    const customRequired = Array.isArray(customSchema.required)
      ? (customSchema.required as string[]).filter((r) => typeof r === "string")
      : []

    const mergedProperties: Record<string, unknown> = {
      ...customProps,
      ...baseProperties,
    }
    if (customProps.message) {
      mergedProperties.message = customProps.message
    }

    const required = customRequired.length > 0 ? customRequired : ["message"]
    return {
      type: "object",
      properties: mergedProperties,
      required,
      additionalProperties: customSchema.additionalProperties ?? true,
    }
  }

  return {
    type: "object",
    properties: baseProperties,
    required: ["message"],
    additionalProperties: false,
  }
}
