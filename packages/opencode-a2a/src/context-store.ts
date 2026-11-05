export interface StoredA2AContext {
  sessionKey: string
  agentId: string
  contextId: string
  lastTaskId?: string
  updatedAt: number
}

/**
 * Tracks multi-turn A2A `contextId` (and latest `taskId`) per OpenCode `sessionID` + `agentId`.
 * Uses bounded LRU-style eviction so long-running OpenCode sessions never leak memory.
 */
export class A2AContextStore {
  private readonly maxEntries: number
  private readonly entries = new Map<string, StoredA2AContext>()

  constructor(maxEntries = 1000) {
    this.maxEntries = Math.max(10, maxEntries)
  }

  private buildKey(sessionKey: string, agentId: string): string {
    return `${sessionKey}\0${agentId}`
  }

  get(sessionKey: string | undefined, agentId: string): StoredA2AContext | undefined {
    const normalizedSession = sessionKey?.trim()
    const normalizedAgent = agentId.trim()
    if (!normalizedSession || !normalizedAgent) return undefined

    const key = this.buildKey(normalizedSession, normalizedAgent)
    const entry = this.entries.get(key)
    if (!entry) return undefined

    // Refresh insertion order for LRU
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(
    sessionKey: string | undefined,
    agentId: string,
    update: { contextId?: string; taskId?: string },
  ): StoredA2AContext | undefined {
    const normalizedSession = sessionKey?.trim()
    const normalizedAgent = agentId.trim()
    if (!normalizedSession || !normalizedAgent) return undefined

    const key = this.buildKey(normalizedSession, normalizedAgent)
    const existing = this.entries.get(key)
    const contextId = update.contextId?.trim() || existing?.contextId
    if (!contextId) return existing

    const next: StoredA2AContext = {
      sessionKey: normalizedSession,
      agentId: normalizedAgent,
      contextId,
      lastTaskId: update.taskId?.trim() || existing?.lastTaskId,
      updatedAt: Date.now(),
    }

    this.entries.delete(key)
    this.entries.set(key, next)

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }

    return next
  }

  delete(sessionKey: string | undefined, agentId?: string): void {
    const normalizedSession = sessionKey?.trim()
    if (!normalizedSession) return

    if (agentId) {
      this.entries.delete(this.buildKey(normalizedSession, agentId.trim()))
      return
    }

    const prefix = `${normalizedSession}\0`
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key)
      }
    }
  }

  clear(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }
}
