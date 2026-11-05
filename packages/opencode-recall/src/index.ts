import { Plugin } from "@opencode/plugin"
import { isAbsolute } from "node:path"
import { resolveLocalPath } from "./paths.ts"
import {
  RecallDatabase,
  computeContentHash,
  dotProduct,
  extractAssistantText,
  extractAssistantTextFromParts,
  extractUserText,
  getDefaultOpencodeDbPath,
  getDefaultRecallDbPath,
  groupMessagesIntoTurns,
  normalizeVector,
  type ExtractedTurn,
  type MissingEmbeddingItem,
  type RawMessageRow,
  type RawSessionPartRow,
  type RecallDbOptions,
  type ReconcileOptions,
  type ReconcileSummary,
  type SearchResultItem,
  type SearchResultSession,
  type SearchTurnsOptions,
} from "./db.ts"
import {
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_EMBEDDING_CONTEXT_SIZE,
  DEFAULT_EMBEDDING_MODEL_URI,
  DEFAULT_MAX_CHUNK_TOKENS,
  ScopedEmbedder,
  getDefaultModelDir,
  splitTextIntoTokenChunks,
  type ActiveEmbeddingSession,
  type DisposableResource,
  type EmbedBatchFn,
  type EmbedScope,
  type EmbedSlicesFn,
  type Embedder,
  type ScopedEmbedderOptions,
  type TokenizerAdapter,
} from "./embedder.ts"
import {
  DEFAULT_IDLE_DEBOUNCE_MS,
  MAX_RESULT_ASSISTANT_CHARS,
  MAX_RESULT_USER_CHARS,
  RecallIndexer,
  formatSearchResults,
  formatTimestamp,
  formatTurnForEmbedding,
  truncateDisplayText,
  type RecallIndexerOptions,
  type SearchSessionsInput,
  type SearchSessionsResult,
  type SyncPendingResult,
} from "./indexer.ts"

export {
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_EMBEDDING_CONTEXT_SIZE,
  DEFAULT_EMBEDDING_MODEL_URI,
  DEFAULT_IDLE_DEBOUNCE_MS,
  DEFAULT_MAX_CHUNK_TOKENS,
  MAX_RESULT_ASSISTANT_CHARS,
  MAX_RESULT_USER_CHARS,
  RecallDatabase,
  RecallIndexer,
  ScopedEmbedder,
  computeContentHash,
  dotProduct,
  extractAssistantText,
  extractAssistantTextFromParts,
  extractUserText,
  formatSearchResults,
  formatTimestamp,
  formatTurnForEmbedding,
  getDefaultModelDir,
  getDefaultOpencodeDbPath,
  getDefaultRecallDbPath,
  groupMessagesIntoTurns,
  normalizeVector,
  splitTextIntoTokenChunks,
  truncateDisplayText,
  type ActiveEmbeddingSession,
  type DisposableResource,
  type EmbedBatchFn,
  type EmbedScope,
  type EmbedSlicesFn,
  type Embedder,
  type ExtractedTurn,
  type MissingEmbeddingItem,
  type RawMessageRow,
  type RawSessionPartRow,
  type RecallDbOptions,
  type RecallIndexerOptions,
  type ReconcileOptions,
  type ReconcileSummary,
  type ScopedEmbedderOptions,
  type SearchResultItem,
  type SearchResultSession,
  type SearchSessionsInput,
  type SearchSessionsResult,
  type SearchTurnsOptions,
  type SyncPendingResult,
  type TokenizerAdapter,
}

export interface RecallPluginOptions {
  dbPath?: string
  opencodeDbPath?: string
  modelUri?: string
  modelDir?: string
  contextSize?: number
  maxChunkTokens?: number
  chunkOverlapTokens?: number
  idleDebounceMs?: number
  embedder?: Embedder
}

export interface SessionSearchToolInput {
  query: string
  scope?: "project" | "all"
  limit?: number
}

export const SESSION_SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Natural language query describing the problem, topic, or discussion to search for in historical OpenCode sessions.",
    },
    scope: {
      type: "string",
      enum: ["project", "all"],
      description: "Search within the current project ('project', default) or across all projects ('all').",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "Maximum number of matching turns to return (default: 10).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const

const SHARED_REGISTRY_SYMBOL = Symbol.for("opencode.recall.shared.v1")

export interface SharedRecallEntry {
  key: string
  db: RecallDatabase
  embedder: Embedder
  indexer: RecallIndexer
  refCount: number
}

function getSharedRegistry(): Map<string, SharedRecallEntry> {
  const g = globalThis as Record<symbol, Map<string, SharedRecallEntry> | undefined>
  if (!g[SHARED_REGISTRY_SYMBOL]) {
    g[SHARED_REGISTRY_SYMBOL] = new Map<string, SharedRecallEntry>()
  }
  return g[SHARED_REGISTRY_SYMBOL]!
}

export function getSharedRecallInstances(): ReadonlyMap<string, SharedRecallEntry> {
  return getSharedRegistry()
}

function acquireSharedRecall(options: RecallPluginOptions): {
  indexer: RecallIndexer
  release: () => Promise<void>
} {
  const resolvedDbPath = options.dbPath ?? getDefaultRecallDbPath()
  const resolvedOpencodeDbPath = options.opencodeDbPath ?? getDefaultOpencodeDbPath()
  const resolvedModelUri = options.modelUri ?? DEFAULT_EMBEDDING_MODEL_URI
  const resolvedModelDir = options.modelDir ?? getDefaultModelDir()

  if (resolvedDbPath === ":memory:") {
    const db = new RecallDatabase({
      dbPath: resolvedDbPath,
      opencodeDbPath: resolvedOpencodeDbPath,
    })
    const embedder =
      options.embedder ??
      new ScopedEmbedder({
        modelUri: resolvedModelUri,
        modelDir: resolvedModelDir,
        contextSize: options.contextSize,
        maxChunkTokens: options.maxChunkTokens,
        chunkOverlapTokens: options.chunkOverlapTokens,
      })
    const indexer = new RecallIndexer({
      db,
      embedder,
      idleDebounceMs: options.idleDebounceMs,
    })
    let released = false
    return {
      indexer,
      async release() {
        if (released) return
        released = true
        await indexer.dispose()
      },
    }
  }

  const registry = getSharedRegistry()
  const key = `${resolvedDbPath}\0${resolvedOpencodeDbPath}\0${resolvedModelUri}\0${resolvedModelDir}`
  let entry = registry.get(key)

  if (!entry) {
    const db = new RecallDatabase({
      dbPath: resolvedDbPath,
      opencodeDbPath: resolvedOpencodeDbPath,
    })
    const embedder =
      options.embedder ??
      new ScopedEmbedder({
        modelUri: resolvedModelUri,
        modelDir: resolvedModelDir,
        contextSize: options.contextSize,
        maxChunkTokens: options.maxChunkTokens,
        chunkOverlapTokens: options.chunkOverlapTokens,
      })
    const indexer = new RecallIndexer({
      db,
      embedder,
      idleDebounceMs: options.idleDebounceMs,
    })
    entry = {
      key,
      db,
      embedder,
      indexer,
      refCount: 1,
    }
    registry.set(key, entry)
  } else {
    entry.refCount += 1
  }

  let released = false
  const sharedEntry = entry
  return {
    indexer: sharedEntry.indexer,
    async release() {
      if (released) return
      released = true
      sharedEntry.refCount -= 1
      if (sharedEntry.refCount <= 0) {
        registry.delete(key)
        await sharedEntry.indexer.dispose()
      }
    },
  }
}

function parsePluginOptions(raw: unknown): RecallPluginOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const obj = raw as Record<string, unknown>
  return {
    dbPath: typeof obj.dbPath === "string" && obj.dbPath.trim() ? obj.dbPath.trim() : undefined,
    opencodeDbPath:
      typeof obj.opencodeDbPath === "string" && obj.opencodeDbPath.trim() ? obj.opencodeDbPath.trim() : undefined,
    modelUri: typeof obj.modelUri === "string" && obj.modelUri.trim() ? obj.modelUri.trim() : undefined,
    modelDir: typeof obj.modelDir === "string" && obj.modelDir.trim() ? obj.modelDir.trim() : undefined,
    contextSize:
      typeof obj.contextSize === "number" && Number.isFinite(obj.contextSize) && obj.contextSize >= 64
        ? obj.contextSize
        : undefined,
    maxChunkTokens:
      typeof obj.maxChunkTokens === "number" && Number.isFinite(obj.maxChunkTokens) && obj.maxChunkTokens >= 1
        ? obj.maxChunkTokens
        : undefined,
    chunkOverlapTokens:
      typeof obj.chunkOverlapTokens === "number" &&
      Number.isFinite(obj.chunkOverlapTokens) &&
      obj.chunkOverlapTokens >= 0
        ? obj.chunkOverlapTokens
        : undefined,
    idleDebounceMs:
      typeof obj.idleDebounceMs === "number" && Number.isFinite(obj.idleDebounceMs) && obj.idleDebounceMs >= 0
        ? obj.idleDebounceMs
        : undefined,
    embedder:
      obj.embedder && typeof (obj.embedder as Embedder).withScope === "function"
        ? (obj.embedder as Embedder)
        : undefined,
  }
}

export default Plugin.define({
  id: "opencode-recall",
  async setup(ctx) {
    const options = parsePluginOptions(ctx.options)
    const baseDirectory = ctx.location?.directory
    if (options.dbPath && options.dbPath !== ":memory:") options.dbPath = resolveLocalPath(options.dbPath, baseDirectory)
    if (options.opencodeDbPath) options.opencodeDbPath = resolveLocalPath(options.opencodeDbPath, baseDirectory)
    if (options.modelDir) options.modelDir = resolveLocalPath(options.modelDir, baseDirectory)
    if (options.modelUri && (options.modelUri.startsWith("~") || !/^[a-z][a-z0-9+.-]*:/i.test(options.modelUri) || isAbsolute(options.modelUri))) {
      options.modelUri = resolveLocalPath(options.modelUri, baseDirectory)
    }
    const { indexer, release } = acquireSharedRecall(options)

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.add({
        name: "session_search",
        description:
          "Search historical OpenCode sessions by semantic similarity. Returns matching user/assistant conversation turns grouped by content with all associated session IDs (including forks) and turn locations.",
        input: SESSION_SEARCH_INPUT_SCHEMA as never,
        async execute(rawInput, toolContext) {
          const input = (rawInput ?? {}) as SessionSearchToolInput
          const query = typeof input.query === "string" ? input.query : ""
          const scope = input.scope === "all" ? "all" : "project"
          const limit = typeof input.limit === "number" ? input.limit : 10

          const session = toolContext?.sessionID ? await ctx.session.get({ sessionID: toolContext.sessionID }) : undefined
          const location = session?.location ?? ctx.location
          const result = await indexer.searchSessions({
            query,
            scope,
            limit,
            projectID: session?.projectID ?? ctx.location?.project?.id,
            directory: location?.directory,
            excludeSessionID: toolContext?.sessionID,
          })

          return {
            content: result.text,
            metadata: {
              count: result.items.length,
              syncedTurns: result.syncedTurns,
              durationMs: Math.round(result.durationMs),
            },
          }
        },
      })
    })

    const promptRegistration = await ctx.session?.hook?.("prompt", () => {
      indexer.cancelIdleSync()
    })

    const controller = new AbortController()
    if (ctx.event?.subscribe) {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            const ev = event as {
              type?: string
              data?: { sessionID?: string; status?: { type?: string } }
              properties?: { sessionID?: string; status?: { type?: string } }
            }
            const statusType = ev.data?.status?.type ?? ev.properties?.status?.type
            if (
              ev.type === "session.idle" ||
              ev.type === "session.execution.succeeded" ||
              (ev.type === "session.status" && statusType === "idle")
            ) {
              indexer.scheduleIdleSync()
            } else if (
              ev.type === "session.busy" ||
              ev.type === "session.prompt" ||
              ev.type === "session.execution.started" ||
              (ev.type === "session.status" && statusType === "busy")
            ) {
              indexer.cancelIdleSync()
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error("[opencode-recall] event loop error", error)
          }
        }
      })()
    }

    return async () => {
      controller.abort()
      await promptRegistration?.dispose?.()
      await toolRegistration?.dispose?.()
      await release()
    }
  },
})
