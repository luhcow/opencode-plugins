import type {
  RecallDatabase,
  ReconcileSummary,
  SearchResultItem,
} from "./db.ts"
import {
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_MAX_CHUNK_TOKENS,
  splitTextIntoTokenChunks,
  type EmbedBatchFn,
  type EmbedScope,
  type Embedder,
} from "./embedder.ts"

export const DEFAULT_IDLE_DEBOUNCE_MS = 30_000
export const MAX_RESULT_USER_CHARS = 50
export const MAX_RESULT_ASSISTANT_CHARS = 100

export interface RecallIndexerOptions {
  db: RecallDatabase
  embedder: Embedder
  idleDebounceMs?: number
}

export interface SyncPendingResult {
  reconciled: ReconcileSummary
  embeddedCount: number
  durationMs: number
}

export interface SearchSessionsInput {
  query: string
  scope?: "project" | "all"
  projectID?: string
  directory?: string
  excludeSessionID?: string
  limit?: number
}

export interface SearchSessionsResult {
  items: SearchResultItem[]
  text: string
  syncedTurns: number
  durationMs: number
}

export function formatTurnForEmbedding(userText: string, assistantText: string): string {
  return `User: ${userText}\nAssistant: ${assistantText}`
}

export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown"
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function truncateDisplayText(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) {
    return text
  }
  return `${chars.slice(0, maxChars).join("")}...`
}

export function formatSearchResults(
  query: string,
  items: readonly SearchResultItem[],
  syncedTurns: number,
  durationMs: number,
): string {
  if (items.length === 0) {
    return `No matching turns found for query "${query}".`
  }

  const uniqueSessionIDs = new Set<string>()
  for (const item of items) {
    for (const s of item.sessions) {
      uniqueSessionIDs.add(s.sessionID)
    }
  }

  const turnWord = items.length === 1 ? "turn" : "turns"
  const sessionWord = uniqueSessionIDs.size === 1 ? "session" : "sessions"
  const syncSuffix =
    syncedTurns > 0
      ? ` (synced ${syncedTurns} pending ${syncedTurns === 1 ? "turn" : "turns"} in ${Math.round(durationMs)}ms)`
      : ` (${Math.round(durationMs)}ms)`

  const blocks: string[] = [
    `Found ${items.length} matching ${turnWord} across ${uniqueSessionIDs.size} ${sessionWord}${syncSuffix}`,
  ]

  items.forEach((item, index) => {
    const sessionLines = item.sessions.map((s) => {
      const forkTag = s.forkSessionID ? ` (fork of ${s.forkSessionID})` : ""
      const title = JSON.stringify(s.title || "Untitled")
      const updated = formatTimestamp(s.updatedAt)
      return `   - sessionID: ${s.sessionID}${forkTag} | title: ${title} | location: turn #${s.turnIndex} (userMessageID: ${s.userMessageID}, assistantMessageID: ${s.assistantMessageID}) | directory: ${s.directory} | updated: ${updated}`
    })

    const displayUser = truncateDisplayText(item.userText, MAX_RESULT_USER_CHARS)
    const displayAssistant = truncateDisplayText(item.assistantText, MAX_RESULT_ASSISTANT_CHARS)

    blocks.push(
      [
        `${index + 1}. score: ${item.score.toFixed(2)} | sessions (${item.sessions.length}):`,
        ...sessionLines,
        `   User: ${displayUser}`,
        `   Assistant: ${displayAssistant}`,
      ].join("\n"),
    )
  })

  return blocks.join("\n\n")
}

export class RecallIndexer {
  readonly db: RecallDatabase
  readonly embedder: Embedder
  readonly idleDebounceMs: number

  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private syncQueue: Promise<unknown> = Promise.resolve()
  private activeTasks = 0
  private disposed = false

  constructor(options: RecallIndexerOptions) {
    this.db = options.db
    this.embedder = options.embedder
    this.idleDebounceMs = options.idleDebounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.activeTasks += 1
    const run = async () => {
      try {
        return await task()
      } finally {
        this.activeTasks -= 1
      }
    }
    const next = this.syncQueue.then(run, run)
    this.syncQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  scheduleIdleSync(excludeSessionID?: string): void {
    if (this.disposed) return
    this.cancelIdleSync()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.disposed) return
      void this.syncPendingSessions({ excludeSessionID }).catch(() => {
        // Ignore background idle sync errors
      })
    }, this.idleDebounceMs)
  }

  cancelIdleSync(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  get hasPendingIdleTimer(): boolean {
    return this.idleTimer !== null
  }

  /**
   * Streams missing turns from SQLite one item at a time (`LIMIT 1`), slices oversized turns
   * into multiple chunks, computes embeddings, and immediately persists each turn's slices to SQLite
   * before loading the next turn into memory.
   */
  private async streamMissingTurns(
    embedBatch: EmbedBatchFn,
    scope?: EmbedScope,
  ): Promise<number> {
    let embeddedCount = 0
    const failedHashes = new Set<string>()

    while (!this.disposed) {
      const item = this.db.getNextMissingEmbedding(failedHashes)
      if (!item) break

      try {
        const formatted = formatTurnForEmbedding(item.userText, item.assistantText)
        const sliceVectors = scope?.embedSlices
          ? await scope.embedSlices(formatted)
          : await embedBatch(
              splitTextIntoTokenChunks(
                formatted,
                DEFAULT_MAX_CHUNK_TOKENS,
                DEFAULT_CHUNK_OVERLAP_TOKENS,
              ),
            )
        this.db.saveTurnEmbeddings(item.contentHash, sliceVectors)
        embeddedCount += 1
      } catch (error) {
        failedHashes.add(item.contentHash)
        console.warn(
          `[opencode-recall] Failed to embed turn ${item.contentHash}, skipping:`,
          error,
        )
      }
    }

    return embeddedCount
  }

  /**
   * Reconciles SQL turns across all sessions (including completed history of running sessions)
   * and computes embeddings one turn at a time ONLY if there are missing `content_hash` entries.
   * When `missingEmbeddingCount === 0`, `embedder.withScope` is NEVER called (0 GPU/memory allocation).
   */
  syncPendingSessions(options: { excludeSessionID?: string } = {}): Promise<SyncPendingResult> {
    this.cancelIdleSync()
    return this.enqueue(async () => {
      if (this.disposed) {
        return {
          reconciled: {
            deletedTurns: 0,
            upsertedTurns: 0,
            deletedEmbeddings: 0,
            missingEmbeddingCount: 0,
            missingEmbeddings: [],
          },
          embeddedCount: 0,
          durationMs: 0,
        }
      }

      const start = performance.now()
      const reconciled = this.db.reconcileTurns({ excludeSessionID: options.excludeSessionID })

      if (reconciled.missingEmbeddingCount === 0) {
        return {
          reconciled,
          embeddedCount: 0,
          durationMs: performance.now() - start,
        }
      }

      const embeddedCount = await this.embedder.withScope(async (embedBatch, scope) => {
        return await this.streamMissingTurns(embedBatch, scope)
      })

      return {
        reconciled,
        embeddedCount,
        durationMs: performance.now() - start,
      }
    })
  }

  /**
   * Queues on the serial sync pipeline, reconciles all completed turns (including running sessions),
   * streams any pending turns one-by-one into SQLite, and embeds the search query within a SINGLE
   * `embedder.withScope` lifecycle before releasing GPU resources and running SQLite similarity search.
   */
  searchSessions(input: SearchSessionsInput): Promise<SearchSessionsResult> {
    this.cancelIdleSync()
    return this.enqueue(async () => {
      const start = performance.now()
      const query = input.query.trim()
      if (!query || this.disposed) {
        return {
          items: [],
          text: `No matching turns found for query "${query}".`,
          syncedTurns: 0,
          durationMs: 0,
        }
      }

      // Reconcile all sessions (do NOT pass excludeSessionID here so completed turns of running/active sessions are indexed)
      this.db.reconcileTurns()

      let syncedTurns = 0
      const queryVector = await this.embedder.withScope(async (embedBatch, scope) => {
        if (this.db.getMissingEmbeddingCount() > 0) {
          syncedTurns = await this.streamMissingTurns(embedBatch, scope)
        }
        const [qVec] = await embedBatch([query])
        return qVec!
      })

      // At this point `withScope` has exited and GPU resources are already disposed.
      const items = this.db.searchTurns({
        queryEmbedding: queryVector,
        scope: input.scope,
        projectID: input.projectID,
        directory: input.directory,
        excludeSessionID: input.excludeSessionID,
        limit: input.limit,
      })

      const durationMs = performance.now() - start
      const text = formatSearchResults(query, items, syncedTurns, durationMs)

      return {
        items,
        text,
        syncedTurns,
        durationMs,
      }
    })
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.cancelIdleSync()
    if (this.activeTasks === 0) {
      this.db.close()
      return Promise.resolve()
    }
    const finalize = () => {
      this.db.close()
    }
    return this.syncQueue.then(finalize, finalize)
  }
}
