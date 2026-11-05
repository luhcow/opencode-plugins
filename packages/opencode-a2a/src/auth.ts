import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { A2AAgentCard, A2AAgentConfig, A2ASecurityScheme } from "./types.ts"

export interface ResolveAuthHeadersOptions {
  env?: Record<string, string | undefined>
  homedirPath?: string
  readFile?: (filePath: string) => string
  baseDirectory?: string
}

/**
 * Expands leading `~` or `~/` in a file path to the user's home directory.
 */
export function expandTildePath(rawPath: string, customHomedir?: string, baseDirectory = process.cwd()): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ""
  const home = customHomedir ?? homedir()
  if (trimmed === "~") return home
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(home, trimmed.slice(2))
  }
  return resolve(baseDirectory, trimmed)
}

/**
 * Reads a token from a file path (with `~` expansion) and trims leading/trailing whitespace & newlines.
 */
export function readSecretFile(filePath: string, options?: ResolveAuthHeadersOptions): string {
  const expanded = expandTildePath(filePath, options?.homedirPath, options?.baseDirectory)
  if (!expanded) return ""
  const reader = options?.readFile ?? ((p: string) => readFileSync(p, "utf8"))
  return reader(expanded).trim()
}

/**
 * Resolves a string that may contain:
 * - `{file:~/.config/opencode/secrets/agent-token}`
 * - `{env:A2A_TOKEN}`
 * - `${A2A_TOKEN}`
 * - `$A2A_TOKEN` (when the entire string is `$VAR_NAME`)
 * - `file://~/.config/opencode/secrets/agent-token`
 */
export function interpolateConfigValue(value: string, options?: ResolveAuthHeadersOptions): string {
  const env = options?.env ?? process.env
  const trimmed = value.trim()
  if (!trimmed) return ""

  if (trimmed.startsWith("file://")) {
    const filePath = trimmed.startsWith("file://~/") ? trimmed.slice("file://".length) : fileURLToPath(trimmed)
    return readSecretFile(filePath, options)
  }

  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    const varName = trimmed.slice(1)
    return (env[varName] ?? "").trim()
  }

  return value.replace(
    /\{file:([^}]+)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, fileExpr: string | undefined, envExpr: string | undefined, dollarEnvExpr: string | undefined) => {
      if (fileExpr !== undefined) {
        return readSecretFile(fileExpr, options)
      }
      const varName = envExpr ?? dollarEnvExpr
      if (varName !== undefined) {
        return (env[varName] ?? "").trim()
      }
      return ""
    },
  )
}

export interface InferredCardSecurity {
  headerName: string
  scheme: string
}

/**
 * Infers HTTP authentication header and scheme from an A2A AgentCard's `securitySchemes`.
 * Supports both A2A v1.0 (`apiKeySecurityScheme`, `httpAuthSecurityScheme`)
 * and v0.3 / OpenAPI (`type: "apiKey"`, `type: "http"`) formats.
 */
export function inferSecurityFromCard(card?: Partial<A2AAgentCard> | null): InferredCardSecurity | undefined {
  const schemes = card?.securitySchemes
  if (!schemes || typeof schemes !== "object") return undefined

  const entries = Object.values(schemes).filter((s): s is A2ASecurityScheme => Boolean(s && typeof s === "object"))
  if (entries.length === 0) return undefined

  // 1. Prefer header-based API key schemes declared by the card.
  for (const scheme of entries) {
    const apiKey = scheme.apiKeySecurityScheme
    if (apiKey) {
      const loc = (apiKey.location ?? apiKey.in ?? "header").toLowerCase()
      if (loc === "header" && typeof apiKey.name === "string" && apiKey.name.trim()) {
        return {
          headerName: apiKey.name.trim(),
          scheme: "",
        }
      }
    }
    if (scheme.type === "apiKey" || (scheme.name && (scheme.in === "header" || scheme.location === "header"))) {
      const loc = (scheme.in ?? scheme.location ?? "header").toLowerCase()
      if (loc === "header" && typeof scheme.name === "string" && scheme.name.trim()) {
        return {
          headerName: scheme.name.trim(),
          scheme: "",
        }
      }
    }
  }

  // 2. Check HTTP auth schemes (e.g. Bearer)
  for (const scheme of entries) {
    const httpAuth = scheme.httpAuthSecurityScheme
    if (httpAuth) {
      const authScheme = typeof httpAuth.scheme === "string" && httpAuth.scheme.trim() ? httpAuth.scheme.trim() : "Bearer"
      return {
        headerName: "Authorization",
        scheme: authScheme.toLowerCase() === "bearer" ? "Bearer" : authScheme,
      }
    }
    if (scheme.type === "http") {
      const authScheme = typeof scheme.scheme === "string" && scheme.scheme.trim() ? scheme.scheme.trim() : "Bearer"
      return {
        headerName: "Authorization",
        scheme: authScheme.toLowerCase() === "bearer" ? "Bearer" : authScheme,
      }
    }
    if (scheme.openIdConnectSecurityScheme || scheme.oauth2SecurityScheme || scheme.type === "openIdConnect" || scheme.type === "oauth2") {
      return {
        headerName: "Authorization",
        scheme: "Bearer",
      }
    }
  }

  return undefined
}

/**
 * Resolves the raw token string from an agent configuration (`token`, `tokenFile`, `tokenEnv`, or `auth.*`).
 */
export function resolveAgentToken(config: A2AAgentConfig, options?: ResolveAuthHeadersOptions): string {
  const env = options?.env ?? process.env
  const auth = config.auth

  if (auth?.type === "none") return ""

  const rawToken = auth?.token ?? config.token
  if (typeof rawToken === "string" && rawToken.trim()) {
    return interpolateConfigValue(rawToken, options).trim()
  }

  const tokenFile = auth?.tokenFile ?? config.tokenFile
  if (typeof tokenFile === "string" && tokenFile.trim()) {
    return readSecretFile(tokenFile, options)
  }

  const tokenEnv = auth?.tokenEnv ?? config.tokenEnv
  if (typeof tokenEnv === "string" && tokenEnv.trim()) {
    return (env[tokenEnv.trim()] ?? "").trim()
  }

  return ""
}

/**
 * Formats a header value given a token and optional scheme/prefix (e.g., `"Bearer"`).
 * Avoids duplicating the prefix if `token` already starts with `<scheme> `.
 */
export function formatAuthHeaderValue(token: string, scheme?: string): string {
  const trimmedToken = token.trim()
  if (!trimmedToken) return ""
  const trimmedScheme = (scheme ?? "").trim()
  if (!trimmedScheme) return trimmedToken
  if (trimmedToken.toLowerCase().startsWith(`${trimmedScheme.toLowerCase()} `)) {
    return trimmedToken
  }
  return `${trimmedScheme} ${trimmedToken}`
}

/**
 * Builds the complete dictionary of authentication and custom HTTP headers for an A2A Agent.
 */
export function resolveAgentHeaders(
  config: A2AAgentConfig,
  card?: Partial<A2AAgentCard> | null,
  options?: ResolveAuthHeadersOptions,
): Record<string, string> {
  const headers: Record<string, string> = {}

  // 1. Interpolate any custom `headers` map first
  if (config.headers && typeof config.headers === "object") {
    for (const [key, rawValue] of Object.entries(config.headers)) {
      if (typeof rawValue !== "string") continue
      const resolvedValue = interpolateConfigValue(rawValue, options).trim()
      if (key.trim() && resolvedValue) {
        headers[key.trim()] = resolvedValue
      }
    }
  }

  // 2. Resolve token from `auth` / `token` / `tokenFile` / `tokenEnv`
  const token = resolveAgentToken(config, options)
  if (!token) return headers

  const auth = config.auth
  const authType = auth?.type ?? "auto"
  if (authType === "none") return headers

  const explicitHeader = (auth?.header ?? config.tokenHeader)?.trim()
  const explicitScheme = auth?.scheme ?? auth?.prefix ?? config.tokenScheme

  let headerName: string
  let scheme: string

  if (explicitHeader) {
    headerName = explicitHeader
    if (explicitScheme !== undefined) {
      scheme = explicitScheme
    } else if (authType === "bearer" || explicitHeader.toLowerCase() === "authorization") {
      scheme = "Bearer"
    } else {
      scheme = ""
    }
  } else if (authType === "bearer") {
    headerName = "Authorization"
    scheme = explicitScheme !== undefined ? explicitScheme : "Bearer"
  } else if (authType === "header" || authType === "apiKey") {
    const inferred = inferSecurityFromCard(card)
    if (!inferred) throw new Error("Header authentication requires an explicit header or a matching Agent Card security scheme.")
    headerName = inferred.headerName
    scheme = explicitScheme !== undefined ? explicitScheme : ""
  } else {
    // "auto": check AgentCard.securitySchemes first, then fall back to Authorization: Bearer
    const inferred = inferSecurityFromCard(card)
    if (inferred) {
      headerName = inferred.headerName
      scheme = explicitScheme !== undefined ? explicitScheme : inferred.scheme
    } else {
      headerName = "Authorization"
      scheme = explicitScheme !== undefined ? explicitScheme : "Bearer"
    }
  }

  const existingKey = Object.keys(headers).find((k) => k.toLowerCase() === headerName.toLowerCase())
  if (!existingKey) {
    headers[headerName] = formatAuthHeaderValue(token, scheme)
  }

  return headers
}
