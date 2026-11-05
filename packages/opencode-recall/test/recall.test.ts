import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { resolveLocalPath } from "../src/paths.ts"
import { homedir } from "node:os"
import plugin, {
  DEFAULT_CHUNK_OVERLAP_TOKENS,
  DEFAULT_EMBEDDING_CONTEXT_SIZE,
  DEFAULT_MAX_CHUNK_TOKENS,
  MAX_RESULT_ASSISTANT_CHARS,
  MAX_RESULT_USER_CHARS,
  RecallDatabase,
  RecallIndexer,
  ScopedEmbedder,
  computeContentHash,
  formatSearchResults,
  getSharedRecallInstances,
  splitTextIntoTokenChunks,
  truncateDisplayText,
  type ActiveEmbeddingSession,
} from "../src/index.ts"

type ToolEditor = { list(): unknown[]; get(): undefined; namespace(): void; add(tool: any): void; update(): void; remove(): void }

/**
 * Creates a temporary OpenCode V2 native SQLite database (`opencode.db`)
 * with the exact `session_v2` and `session_message` schema.
 */
function createMockOpencodeDb() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-recall-test-"))
  const opencodeDbPath = join(dir, "opencode.db")
  const recallDbPath = join(dir, "recall.sqlite")
  const ocDb = new DatabaseSync(opencodeDbPath)

  ocDb.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      fork_session_id TEXT,
      fork_boundary TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT,
      version TEXT NOT NULL,
      revert TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );

    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)

  const insertSessionStmt = ocDb.prepare(`
    INSERT INTO session_v2 (
      id, project_id, parent_id, fork_session_id, fork_boundary,
      slug, directory, title, version, revert, time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2.0.0', ?, ?, ?)
  `)

  const insertMessageStmt = ocDb.prepare(`
    INSERT INTO session_message (
      id, session_id, type, seq, time_created, time_updated, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const addSession = (input: {
    id: string
    projectID?: string
    parentID?: string | null
    forkSessionID?: string | null
    forkBoundary?: string | null
    directory?: string
    title?: string
    revertMessageID?: string | null
    timeCreated?: number
    timeUpdated?: number
  }) => {
    const now = input.timeCreated ?? 1761391200000
    insertSessionStmt.run(
      input.id,
      input.projectID ?? "proj_default",
      input.parentID ?? null,
      input.forkSessionID ?? null,
      input.forkBoundary ?? null,
      input.id,
      input.directory ?? join(dir, "default-project"),
      input.title ?? `Session ${input.id}`,
      input.revertMessageID ? JSON.stringify({ messageID: input.revertMessageID }) : null,
      now,
      input.timeUpdated ?? now,
    )
  }

  const addTurn = (input: {
    sessionID: string
    turnNumber: number
    userMessageID?: string
    assistantMessageID?: string
    userSeq?: number
    assistantSeq?: number
    userText: string
    assistantText: string
    reasoningText?: string
  }) => {
    const uSeq = input.userSeq ?? input.turnNumber * 2 - 1
    const aSeq = input.assistantSeq ?? input.turnNumber * 2
    const uId = input.userMessageID ?? `msg_${input.sessionID}_u_${input.turnNumber}`
    const aId = input.assistantMessageID ?? `msg_${input.sessionID}_a_${input.turnNumber}`
    const ts = 1761391200000 + input.turnNumber * 60_000

    insertMessageStmt.run(
      uId,
      input.sessionID,
      "user",
      uSeq,
      ts,
      ts,
      JSON.stringify({ text: input.userText, time: { created: ts } }),
    )

    const content: Array<Record<string, unknown>> = []
    if (input.reasoningText) {
      content.push({ type: "reasoning", text: input.reasoningText })
    }
    content.push({ type: "text", text: input.assistantText })

    insertMessageStmt.run(
      aId,
      input.sessionID,
      "assistant",
      aSeq,
      ts + 1000,
      ts + 1000,
      JSON.stringify({ content, time: { created: ts + 1000, completed: ts + 2000 } }),
    )
  }

  const enableSessionPartTable = () => {
    ocDb.exec(`
      CREATE TABLE IF NOT EXISTS session_part (
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        call_id TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL,
        CONSTRAINT session_part_pk PRIMARY KEY(message_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS session_part_session_message_idx
        ON session_part (session_id, message_id, ordinal);
    `)
  }

  const addPartTurn = (input: {
    sessionID: string
    turnNumber: number
    userMessageID?: string
    assistantMessageID?: string
    userSeq?: number
    assistantSeq?: number
    userText: string
    parts: ReadonlyArray<{
      ordinal?: number
      type: string
      callID?: string | null
      timeCreated?: number
      timeUpdated?: number
      data: Record<string, unknown>
    }>
    inlineAssistantContent?: ReadonlyArray<Record<string, unknown>>
  }) => {
    enableSessionPartTable()
    const uSeq = input.userSeq ?? input.turnNumber * 2 - 1
    const aSeq = input.assistantSeq ?? input.turnNumber * 2
    const uId = input.userMessageID ?? `msg_${input.sessionID}_u_${input.turnNumber}`
    const aId = input.assistantMessageID ?? `msg_${input.sessionID}_a_${input.turnNumber}`
    const ts = 1761391200000 + input.turnNumber * 60_000

    insertMessageStmt.run(
      uId,
      input.sessionID,
      "user",
      uSeq,
      ts,
      ts,
      JSON.stringify({ text: input.userText, time: { created: ts } }),
    )

    insertMessageStmt.run(
      aId,
      input.sessionID,
      "assistant",
      aSeq,
      ts + 1000,
      ts + 1000,
      JSON.stringify({
        content: input.inlineAssistantContent ?? [],
        time: { created: ts + 1000, completed: ts + 2000 },
      }),
    )

    const insertPartStmt = ocDb.prepare(`
      INSERT INTO session_part (
        message_id, session_id, ordinal, type, call_id, time_created, time_updated, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    input.parts.forEach((p, idx) => {
      const ord = p.ordinal ?? idx
      const pCreated = p.timeCreated ?? ts + 1000 + ord * 10
      const pUpdated = p.timeUpdated ?? pCreated
      insertPartStmt.run(
        aId,
        input.sessionID,
        ord,
        p.type,
        p.callID ?? null,
        pCreated,
        pUpdated,
        JSON.stringify(p.data),
      )
    })
  }

  const setRevert = (sessionID: string, messageID: string | null) => {
    ocDb
      .prepare("UPDATE session_v2 SET revert = ? WHERE id = ?")
      .run(messageID ? JSON.stringify({ messageID }) : null, sessionID)
  }

  const commitRevert = (sessionID: string) => {
    const row = ocDb.prepare("SELECT revert FROM session_v2 WHERE id = ?").get(sessionID) as
      | { revert: string | null }
      | undefined
    if (!row?.revert) return
    const parsed = JSON.parse(row.revert) as { messageID: string }
    const msgRow = ocDb
      .prepare("SELECT seq FROM session_message WHERE session_id = ? AND id = ?")
      .get(sessionID, parsed.messageID) as { seq: number } | undefined
    if (msgRow) {
      const hasPartTable = ocDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_part' LIMIT 1")
        .get()
      if (hasPartTable) {
        ocDb
          .prepare(
            `DELETE FROM session_part
             WHERE session_id = ?
               AND message_id IN (
                 SELECT id FROM session_message WHERE session_id = ? AND seq >= ?
               )`,
          )
          .run(sessionID, sessionID, msgRow.seq)
      }
      ocDb
        .prepare("DELETE FROM session_message WHERE session_id = ? AND seq >= ?")
        .run(sessionID, msgRow.seq)
    }
    ocDb.prepare("UPDATE session_v2 SET revert = NULL WHERE id = ?").run(sessionID)
  }

  const cleanup = () => {
    try {
      ocDb.close()
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true })
  }

  return {
    dir,
    opencodeDbPath,
    recallDbPath,
    ocDb,
    addSession,
    addTurn,
    enableSessionPartTable,
    addPartTurn,
    setRevert,
    commitRevert,
    cleanup,
  }
}

/**
 * Deterministic semantic keyword embedder with full lifecycle tracking
 * (`acquireCount`, `disposeCount`, `disposeOrder`, `embeddedTexts`).
 */
function createTrackedEmbedder(options: {
  contextSize?: number
  maxChunkTokens?: number
  chunkOverlapTokens?: number
  onEmbed?: (text: string) => void | Promise<void>
} = {}) {
  const VOCAB = [
    "redis",
    "timeout",
    "cluster",
    "sqlite",
    "wal",
    "compaction",
    "boundary",
    "revert",
    "metal",
    "gpu",
    "llama",
    "fork",
    "dsp",
    "bidder",
    "experiment",
    "turn1",
    "turn2",
    "turn3",
    "turn4",
    "turn5",
    "turn6",
    "turn7",
    "turn8",
    "turn9",
    "turn10",
    "turn11",
    "turn12",
    "alpha",
    "beta",
    "omega",
    "sentinel",
    "quorum",
  ]

  let acquireCount = 0
  let disposeCount = 0
  let currentDisposed = true
  const disposeEvents: string[] = []
  const embeddedTexts: string[] = []

  const textToVector = (text: string): Float32Array => {
    const lower = text.toLowerCase()
    const vec = new Float32Array(VOCAB.length + 4)
    for (let i = 0; i < VOCAB.length; i++) {
      const token = VOCAB[i]!
      // Use regex word boundary so "turn1" doesn't match "turn10"
      const regex = new RegExp(`\\b${token}\\b`, "i")
      if (regex.test(lower)) {
        vec[i] = 1.0
      }
    }
    // Fallback deterministic hash components so every non-empty string has non-zero norm
    let h = 2166136261
    for (let i = 0; i < lower.length; i++) {
      h ^= lower.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    vec[VOCAB.length] = ((h >>> 0) % 100) / 1000 + 0.01
    vec[VOCAB.length + 1] = (((h >>> 8) & 0xff) + 1) / 2550
    return vec
  }

  const embedder = new ScopedEmbedder({
    contextSize: options.contextSize,
    maxChunkTokens: options.maxChunkTokens,
    chunkOverlapTokens: options.chunkOverlapTokens,
    async acquireSession(): Promise<ActiveEmbeddingSession> {
      acquireCount += 1
      currentDisposed = false
      return {
        async embed(text: string) {
          assert.equal(currentDisposed, false, "embed() must not be called on a disposed session")
          if (options.onEmbed) {
            await options.onEmbed(text)
          }
          embeddedTexts.push(text)
          return textToVector(text)
        },
        context: {
          async dispose() {
            disposeEvents.push("context.dispose")
          },
        },
        model: {
          async dispose() {
            disposeEvents.push("model.dispose")
          },
        },
        llama: {
          async dispose() {
            disposeEvents.push("llama.dispose")
            disposeCount += 1
            currentDisposed = true
          },
        },
      }
    },
  })

  return {
    embedder,
    get acquireCount() {
      return acquireCount
    },
    get disposeCount() {
      return disposeCount
    },
    get isCurrentlyDisposed() {
      return currentDisposed
    },
    disposeEvents,
    embeddedTexts,
    resetCounters() {
      acquireCount = 0
      disposeCount = 0
      disposeEvents.length = 0
      embeddedTexts.length = 0
    },
  }
}

test("Test 1: Basic indexing, project/all scope filtering, compaction skipping, and session_search tool output", async () => {
  const env = createMockOpencodeDb()
  const tracked = createTrackedEmbedder()

  try {
    // Session 1 in proj_A
    env.addSession({
      id: "ses_projA_1",
      projectID: "proj_A",
      directory: join(env.dir, "sample-service"),
      title: "Redis Cluster Timeout Troubleshooting",
      timeCreated: 1761391200000,
      timeUpdated: 1761391200000,
    })
    env.addTurn({
      sessionID: "ses_projA_1",
      turnNumber: 1,
      userText: "Why does Redis cluster timeout during slot migration?",
      assistantText: "Redis cluster timeout happens when client pool connections block on MOVED/ASK redirects.",
      reasoningText: "Internal reasoning that should not pollute assistant text.",
    })
    // Insert a compaction checkpoint message and tool-only assistant message to verify they are skipped
    env.ocDb
      .prepare(
        `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
         VALUES ('msg_compact_1', 'ses_projA_1', 'compaction', 3, 1761391300000, 1761391300000, '{"summary":"compacted summary about metal gpu"}')`,
      )
      .run()
    env.addTurn({
      sessionID: "ses_projA_1",
      turnNumber: 2,
      userSeq: 4,
      assistantSeq: 5,
      userText: "How do we fix compact-before boundary revert rendering?",
      assistantText: "Anchor the compaction summary before boundaryMessageID in the TUI node list.",
    })

    // Session 2 in proj_B (different project)
    env.addSession({
      id: "ses_projB_1",
      projectID: "proj_B",
      directory: join(env.dir, "other-repo"),
      title: "SQLite WAL Mode Tuning",
      timeCreated: 1761394800000,
      timeUpdated: 1761394800000,
    })
    env.addTurn({
      sessionID: "ses_projB_1",
      turnNumber: 1,
      userText: "How to configure SQLite WAL mode with read-only ATTACH?",
      assistantText: "Use PRAGMA journal_mode = WAL on the main DB and ATTACH file:...?mode=ro for read-only.",
    })

    // Subagent session (parent_id IS NOT NULL) -> must be ignored
    env.addSession({
      id: "ses_subagent_1",
      projectID: "proj_A",
      parentID: "ses_projA_1",
      directory: join(env.dir, "sample-service"),
      title: "Subagent Redis Task",
    })
    env.addTurn({
      sessionID: "ses_subagent_1",
      turnNumber: 1,
      userText: "Subagent redis timeout check",
      assistantText: "Subagent redis timeout result",
    })

    // Active session calling session_search -> its completed turn IS indexed, while excluded from self-search results via excludeSessionID
    env.addSession({
      id: "ses_active",
      projectID: "proj_A",
      directory: join(env.dir, "sample-service"),
      title: "Current Active Session",
    })
    env.addTurn({
      sessionID: "ses_active",
      turnNumber: 1,
      userText: "Redis timeout in active session",
      assistantText: "Active session reply about redis timeout",
    })

    // Set up via the plugin entrypoint to verify `ctx.tool.transform` registration
    let registeredTool:
      | {
          name: string
          description: string
          input: unknown
          execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string; metadata: Record<string, unknown> }>
        }
      | undefined

    const cleanup = await plugin.setup({
      session: {
        get: async () => ({ projectID: "proj_A", location: { directory: join(env.dir, "sample-service") } }),
      },
      options: {
        dbPath: env.recallDbPath,
        opencodeDbPath: env.opencodeDbPath,
        embedder: tracked.embedder,
      },
      location: {
        directory: join(env.dir, "sample-service"),
        project: {
          id: "proj_A",
          directory: join(env.dir, "sample-service"),
          canonical: join(env.dir, "sample-service"),
        },
      },
      tool: {
        async transform(cb: (editor: ToolEditor) => void) {
          cb({
            list: () => [],
            get: () => undefined,
            namespace: () => {},
            add(tool: any) {
              registeredTool = tool
            },
            update: () => {},
            remove: () => {},
          })
          return { dispose: async () => {} }
        },
      },
    } as any)

    assert.ok(registeredTool, "session_search tool should be registered")
    assert.equal(registeredTool.name, "session_search")

    // Search within current project (`proj_A`), excluding active session `ses_active`
    const resProject = await registeredTool.execute(
      { query: "redis cluster timeout", scope: "project", limit: 5 },
      { sessionID: "ses_active" },
    )

    assert.equal(resProject.metadata.count, 2) // Only the 2 turns in ses_projA_1 (subagent & ses_active & proj_B excluded)
    assert.equal(resProject.metadata.syncedTurns, 4) // 2 turns in ses_projA_1 + 1 turn in ses_projB_1 + 1 completed turn in ses_active
    assert.match(resProject.content, /Found 2 matching turns across 1 session/)
    assert.match(resProject.content, /sessionID: ses_projA_1 \| title: "Redis Cluster Timeout Troubleshooting" \| location: turn #1 \(userMessageID: msg_ses_projA_1_u_1, assistantMessageID: msg_ses_projA_1_a_1\)/)
    // User text is 53 chars -> truncated to 50 chars + "..."
    assert.match(resProject.content, /User: Why does Redis cluster timeout during slot migrati\.\.\./)
    // Assistant text is 88 chars (<= 100 chars) -> not truncated
    assert.match(resProject.content, /Assistant: Redis cluster timeout happens when client pool connections block on MOVED\/ASK redirects\./)
    assert.doesNotMatch(resProject.content, /Internal reasoning/)
    assert.doesNotMatch(resProject.content, /ses_subagent_1/)
    assert.doesNotMatch(resProject.content, /ses_active/)
    assert.doesNotMatch(resProject.content, /ses_projB_1/)

    // Search across all projects (`scope: "all"`) for SQLite WAL
    const resAll = await registeredTool.execute(
      { query: "sqlite wal mode", scope: "all", limit: 5 },
      { sessionID: "ses_active" },
    )
    assert.equal(resAll.metadata.count, 3)
    assert.equal(resAll.metadata.syncedTurns, 0) // Already synced!
    const firstLineBlock = resAll.content.split("\n\n")[1]!
    assert.match(firstLineBlock, /sessionID: ses_projB_1 \| title: "SQLite WAL Mode Tuning" \| location: turn #1/)

    await cleanup?.()
  } finally {
    env.cleanup()
  }
})

test("path resolution and search scope do not target unrelated local data", () => {
  const env = createMockOpencodeDb()
  try {
    assert.equal(resolveLocalPath("~/models"), join(homedir(), "models"))
    assert.equal(resolveLocalPath("index.sqlite", env.dir), join(env.dir, "index.sqlite"))
    assert.throws(() => new RecallDatabase({ dbPath: env.opencodeDbPath, opencodeDbPath: env.opencodeDbPath }), /must differ/)
    const db = new RecallDatabase({ dbPath: env.recallDbPath, opencodeDbPath: env.opencodeDbPath })
    try {
      env.addSession({ id: "example", projectID: "other", directory: join(env.dir, "other"), title: "Other project" })
      env.addTurn({ sessionID: "example", turnNumber: 1, userText: "private", assistantText: "answer" })
      db.reconcileTurns()
      const missing = db.getMissingEmbeddings()[0]!
      db.saveTurnEmbeddings(missing.contentHash, [[1, 0]])
      assert.equal(db.searchTurns({ queryEmbedding: [1, 0], scope: "project" }).length, 0)
      assert.equal(db.searchTurns({ queryEmbedding: [1, 0], scope: "all" }).length, 1)
    } finally { db.close() }
  } finally { env.cleanup() }
})

test("Test 2: Multi-revert scenario (seq 7 -> revert to seq 4 -> chat to seq 11 -> revert to seq 9 -> chat to seq 12)", async () => {
  const env = createMockOpencodeDb()
  const tracked = createTrackedEmbedder()
  const db = new RecallDatabase({
    dbPath: env.recallDbPath,
    opencodeDbPath: env.opencodeDbPath,
  })
  const indexer = new RecallIndexer({
    db,
    embedder: tracked.embedder,
  })

  try {
    env.addSession({
      id: "ses_revert",
      projectID: "proj_A",
      directory: join(env.dir, "opencode-plugins"),
      title: "Multi-revert Session",
    })

    // Step A: Chat turns 1..7
    for (let t = 1; t <= 7; t++) {
      env.addTurn({
        sessionID: "ses_revert",
        turnNumber: t,
        userText: `Question for turn${t}`,
        assistantText: `Answer for turn${t}`,
      })
    }

    const sync1 = await indexer.syncPendingSessions()
    assert.equal(sync1.embeddedCount, 7)
    assert.equal(db.getTurnCount(), 7)
    assert.equal(db.getEmbeddingCount(), 7)
    assert.equal(tracked.acquireCount, 1)
    assert.equal(tracked.disposeCount, 1)

    // Step B: Revert to turn 4 (`msg_ses_revert_u_4`)
    tracked.resetCounters()
    env.setRevert("ses_revert", "msg_ses_revert_u_4")

    // Even before committing revert (while staged in `oc.session_v2.revert`), turns 4..7 are invalidated
    const syncStagedRevert4 = await indexer.syncPendingSessions()
    assert.equal(syncStagedRevert4.reconciled.deletedTurns, 4) // turns 4, 5, 6, 7 deleted
    assert.equal(syncStagedRevert4.reconciled.deletedEmbeddings, 4) // orphan embeddings 4..7 deleted
    assert.equal(syncStagedRevert4.embeddedCount, 0)
    assert.equal(tracked.acquireCount, 0, "No GPU acquire when only deleting reverted turns")
    assert.equal(db.getTurnCount(), 3)
    assert.equal(db.getEmbeddingCount(), 3)

    // Step C: Commit revert at 4 and chat new turns 8..11
    env.commitRevert("ses_revert")
    for (let t = 8; t <= 11; t++) {
      env.addTurn({
        sessionID: "ses_revert",
        turnNumber: t,
        userText: `Question for turn${t}`,
        assistantText: `Answer for turn${t}`,
      })
    }

    tracked.resetCounters()
    const sync2 = await indexer.syncPendingSessions()
    assert.equal(sync2.embeddedCount, 4, "Only new turns 8..11 should be embedded; turns 1..3 must not be re-embedded")
    assert.equal(tracked.embeddedTexts.length, 4)
    for (const text of tracked.embeddedTexts) {
      assert.doesNotMatch(text, /turn[123]\b/, "Surviving turns 1..3 must not be re-embedded")
    }
    assert.equal(db.getTurnCount(), 7) // turns 1, 2, 3, 8, 9, 10, 11
    assert.equal(db.getEmbeddingCount(), 7)

    // Step D: Revert to turn 9 (`msg_ses_revert_u_9`) and chat to turn 12
    env.setRevert("ses_revert", "msg_ses_revert_u_9")
    env.commitRevert("ses_revert")
    env.addTurn({
      sessionID: "ses_revert",
      turnNumber: 12,
      userText: "Question for turn12 with llama gpu",
      assistantText: "Answer for turn12 with metal acceleration",
    })

    tracked.resetCounters()
    const sync3 = await indexer.syncPendingSessions()
    assert.equal(sync3.reconciled.deletedTurns, 3, "Turns 9..11 must be deleted")
    assert.equal(sync3.reconciled.deletedEmbeddings, 3, "Orphan embeddings for turns 9..11 must be deleted")
    assert.equal(sync3.embeddedCount, 1, "Only turn 12 must be embedded; surviving turns 1..3 and 8 must be preserved without re-embedding")
    assert.equal(tracked.embeddedTexts.length, 1)
    assert.match(tracked.embeddedTexts[0]!, /turn12/)

    // Verify final database state: exactly 5 surviving turns (1, 2, 3, 8, 12) with contiguous turn_index 1..5
    const finalTurns = db.db
      .prepare("SELECT user_message_id, turn_index, user_text FROM main.session_turns ORDER BY turn_index ASC")
      .all() as Array<{ user_message_id: string; turn_index: number; user_text: string }>

    assert.deepEqual(
      finalTurns.map((t) => ({ id: t.user_message_id, idx: t.turn_index })),
      [
        { id: "msg_ses_revert_u_1", idx: 1 },
        { id: "msg_ses_revert_u_2", idx: 2 },
        { id: "msg_ses_revert_u_3", idx: 3 },
        { id: "msg_ses_revert_u_8", idx: 4 },
        { id: "msg_ses_revert_u_12", idx: 5 },
      ],
    )
    assert.equal(db.getEmbeddingCount(), 5)

    // Verify search finds turn 12 and surviving turn 8, and does not return reverted turns 4..7 or 9..11
    const search12 = await indexer.searchSessions({ query: "turn12 llama gpu", scope: "all", limit: 5 })
    assert.equal(search12.items[0]?.sessions[0]?.userMessageID, "msg_ses_revert_u_12")
    assert.equal(search12.items[0]?.sessions[0]?.turnIndex, 5)

    const search8 = await indexer.searchSessions({ query: "turn8", scope: "all", limit: 5 })
    assert.equal(search8.items[0]?.sessions[0]?.turnIndex, 4)
    assert.equal(search8.items[0]?.sessions[0]?.userMessageID, "msg_ses_revert_u_8")

    for (const items of [search12.items, search8.items]) {
      for (const item of items) {
        assert.doesNotMatch(item.userText, /turn(?:4|5|6|7|9|10|11)\b/)
      }
    }
  } finally {
    await indexer.dispose()
    env.cleanup()
  }
})

test("Test 3: Fork edge cases (cloned prefix dedup + grouped sessions, source revert/delete survival, and half-cloned boundary turn)", async () => {
  const env = createMockOpencodeDb()
  const tracked = createTrackedEmbedder()
  const db = new RecallDatabase({
    dbPath: env.recallDbPath,
    opencodeDbPath: env.opencodeDbPath,
  })
  const indexer = new RecallIndexer({
    db,
    embedder: tracked.embedder,
  })

  try {
    // 1. Create source session `ses_src` with turns 1..4
    env.addSession({
      id: "ses_src",
      projectID: "proj_dsp",
      directory: join(env.dir, "sample-service"),
      title: "ISSUE-4048 问题说明、正常表现与排查",
      timeCreated: 1761391200000,
      timeUpdated: 1761391200000,
    })

    for (let t = 1; t <= 4; t++) {
      env.addTurn({
        sessionID: "ses_src",
        turnNumber: t,
        userMessageID: `msg_src_u_${t}`,
        assistantMessageID: `msg_src_a_${t}`,
        userText:
          t === 4
            ? "帮我梳理一下 ISSUE-4048 dsp bidder experiment 的正常表现和异常分支"
            : `Source question turn${t}`,
        assistantText:
          t === 4
            ? "在正常路径下，当 dsp bidder 命中 experiment 5184 白名单时返回正常出价。"
            : `Source answer turn${t}`,
      })
    }

    const initialSync = await indexer.syncPendingSessions()
    assert.equal(initialSync.embeddedCount, 4)
    assert.equal(db.getTurnCount(), 4)
    assert.equal(db.getEmbeddingCount(), 4)

    // 2. Fork Case A: Create `ses_fork_1` (fork #1) and `ses_fork_2` (fork #2) cloning turns 1..4
    env.addSession({
      id: "ses_fork_1",
      projectID: "proj_dsp",
      forkSessionID: "ses_src",
      forkBoundary: JSON.stringify({ type: "through", messageID: "msg_src_a_4" }),
      directory: join(env.dir, "sample-service"),
      title: "ISSUE-4048 问题说明、正常表现与排查 (fork #1)",
      timeCreated: 1761392000000,
      timeUpdated: 1761392000000,
    })
    env.addSession({
      id: "ses_fork_2",
      projectID: "proj_dsp",
      forkSessionID: "ses_src",
      forkBoundary: JSON.stringify({ type: "through", messageID: "msg_src_a_4" }),
      directory: join(env.dir, "sample-service"),
      title: "ISSUE-4048 问题说明、正常表现与排查 (fork #2)",
      timeCreated: 1761393000000,
      timeUpdated: 1761393000000,
    })

    for (const [forkID, suffix] of [
      ["ses_fork_1", "f1"],
      ["ses_fork_2", "f2"],
    ] as const) {
      for (let t = 1; t <= 4; t++) {
        env.addTurn({
          sessionID: forkID,
          turnNumber: t,
          userMessageID: `msg_${suffix}_u_${t}`,
          assistantMessageID: `msg_${suffix}_a_${t}`,
          userText:
            t === 4
              ? "帮我梳理一下 ISSUE-4048 dsp bidder experiment 的正常表现和异常分支"
              : `Source question turn${t}`,
          assistantText:
            t === 4
              ? "在正常路径下，当 dsp bidder 命中 experiment 5184 白名单时返回正常出价。"
              : `Source answer turn${t}`,
        })
      }
    }

    tracked.resetCounters()
    const forkSync = await indexer.syncPendingSessions()
    assert.equal(forkSync.reconciled.upsertedTurns, 8, "8 cloned turns across 2 forks should be recorded in session_turns")
    assert.equal(forkSync.embeddedCount, 0, "Cloned fork turns must reuse existing content_hash embeddings with ZERO new embeddings")
    assert.equal(tracked.acquireCount, 0, "GPU embedder must NOT be acquired when all fork turns match existing content_hash")
    assert.equal(tracked.embeddedTexts.length, 0)
    assert.equal(db.getTurnCount(), 12) // 4 turns * 3 sessions
    assert.equal(db.getEmbeddingCount(), 4) // still only 4 unique vectors!

    // Search for turn 4 and verify single grouped result listing source session first, then fork #1, then fork #2
    const groupedSearch = await indexer.searchSessions({
      query: "dsp bidder experiment",
      scope: "project",
      projectID: "proj_dsp",
      limit: 5,
    })

    assert.equal(groupedSearch.items.length, 4, "12 session_turns deduplicate into 4 unique content_hash results")
    const topHit = groupedSearch.items[0]!
    assert.equal(topHit.sessions.length, 3)
    assert.deepEqual(
      topHit.sessions.map((s) => ({
        sessionID: s.sessionID,
        forkSessionID: s.forkSessionID,
        turnIndex: s.turnIndex,
        userMessageID: s.userMessageID,
        assistantMessageID: s.assistantMessageID,
      })),
      [
        {
          sessionID: "ses_src",
          forkSessionID: null,
          turnIndex: 4,
          userMessageID: "msg_src_u_4",
          assistantMessageID: "msg_src_a_4",
        },
        {
          sessionID: "ses_fork_1",
          forkSessionID: "ses_src",
          turnIndex: 4,
          userMessageID: "msg_f1_u_4",
          assistantMessageID: "msg_f1_a_4",
        },
        {
          sessionID: "ses_fork_2",
          forkSessionID: "ses_src",
          turnIndex: 4,
          userMessageID: "msg_f2_u_4",
          assistantMessageID: "msg_f2_a_4",
        },
      ],
    )
    assert.match(groupedSearch.text, /1\. score: [0-9.]+ \| sessions \(3\):/)
    assert.match(groupedSearch.text, /- sessionID: ses_src \| title: "ISSUE-4048 问题说明、正常表现与排查"/)
    assert.match(groupedSearch.text, /- sessionID: ses_fork_1 \(fork of ses_src\) \| title: "ISSUE-4048 问题说明、正常表现与排查 \(fork #1\)"/)
    assert.match(groupedSearch.text, /- sessionID: ses_fork_2 \(fork of ses_src\) \| title: "ISSUE-4048 问题说明、正常表现与排查 \(fork #2\)"/)

    // 3. Fork Case B: Source session `ses_src` reverts to turn 2 (before fork point turn 4), and later is deleted!
    env.setRevert("ses_src", "msg_src_u_2")
    env.commitRevert("ses_src")

    const afterSourceRevert = await indexer.syncPendingSessions()
    assert.equal(afterSourceRevert.reconciled.deletedTurns, 3, "Turns 2..4 of ses_src are deleted from session_turns")
    assert.equal(
      afterSourceRevert.reconciled.deletedEmbeddings,
      0,
      "Shared embeddings for turns 2..4 must NOT be deleted because ses_fork_1 and ses_fork_2 still reference them",
    )
    assert.equal(db.getEmbeddingCount(), 4)

    const searchAfterRevert = await indexer.searchSessions({
      query: "dsp bidder experiment",
      scope: "project",
      projectID: "proj_dsp",
      limit: 5,
    })
    assert.deepEqual(
      searchAfterRevert.items[0]?.sessions.map((s) => s.sessionID),
      ["ses_fork_1", "ses_fork_2"],
    )

    // Delete `ses_src` completely from `oc.session_v2`
    env.ocDb.prepare("DELETE FROM session_message WHERE session_id = 'ses_src'").run()
    env.ocDb.prepare("DELETE FROM session_v2 WHERE id = 'ses_src'").run()

    const afterSourceDelete = await indexer.syncPendingSessions()
    assert.equal(afterSourceDelete.reconciled.deletedTurns, 1) // turn 1 of ses_src
    assert.equal(afterSourceDelete.reconciled.deletedEmbeddings, 0) // forks still hold turns 1..4
    assert.equal(db.getEmbeddingCount(), 4)

    // 4. Fork Case C: Half-cloned turn at fork boundary (cloned user message `msg_..._10` paired with a different assistant reply)
    env.addTurn({
      sessionID: "ses_fork_1",
      turnNumber: 5,
      userMessageID: "msg_f1_u_10",
      assistantMessageID: "msg_f1_a_10",
      userText: "How should we handle boundary fork turn10?",
      assistantText: "In fork 1 we use the alpha strategy with redis cluster.",
    })
    env.addTurn({
      sessionID: "ses_fork_2",
      turnNumber: 5,
      userMessageID: "msg_f2_u_10",
      assistantMessageID: "msg_f2_a_10",
      userText: "How should we handle boundary fork turn10?",
      assistantText: "In fork 2 we use the beta strategy with sqlite wal.",
    })

    const hashFork1 = computeContentHash(
      "How should we handle boundary fork turn10?",
      "In fork 1 we use the alpha strategy with redis cluster.",
    )
    const hashFork2 = computeContentHash(
      "How should we handle boundary fork turn10?",
      "In fork 2 we use the beta strategy with sqlite wal.",
    )
    assert.notEqual(hashFork1, hashFork2, "Same question with different assistant answers must have distinct content_hash")

    const halfCloneSync = await indexer.syncPendingSessions()
    assert.equal(halfCloneSync.embeddedCount, 2, "Both half-cloned boundary turns must be embedded independently")
    assert.equal(db.getEmbeddingCount(), 6)

    const searchAlpha = await indexer.searchSessions({
      query: "turn10 alpha redis",
      scope: "project",
      projectID: "proj_dsp",
      limit: 2,
    })
    assert.equal(searchAlpha.items[0]?.contentHash, hashFork1)
    assert.equal(searchAlpha.items[0]?.sessions[0]?.sessionID, "ses_fork_1")

    const searchBeta = await indexer.searchSessions({
      query: "turn10 beta sqlite",
      scope: "project",
      projectID: "proj_dsp",
      limit: 2,
    })
    assert.equal(searchBeta.items[0]?.contentHash, hashFork2)
    assert.equal(searchBeta.items[0]?.sessions[0]?.sessionID, "ses_fork_2")
  } finally {
    await indexer.dispose()
    env.cleanup()
  }
})

test("Test 4: Strict GPU memory lifecycle (0 acquire on no-op sync, single acquire/dispose on flush-before-query, immediate finally disposal, reference counting)", async () => {
  const env = createMockOpencodeDb()
  const tracked = createTrackedEmbedder()
  const db = new RecallDatabase({
    dbPath: env.recallDbPath,
    opencodeDbPath: env.opencodeDbPath,
  })
  const indexer = new RecallIndexer({
    db,
    embedder: tracked.embedder,
    idleDebounceMs: 25,
  })

  try {
    // 1. Sync when DB is empty -> 0 acquire calls
    const emptySync = await indexer.syncPendingSessions()
    assert.equal(emptySync.embeddedCount, 0)
    assert.equal(tracked.acquireCount, 0)
    assert.equal(tracked.disposeCount, 0)
    assert.equal(tracked.embedder.isActive, false)

    // 2. Add 2 unindexed turns and immediately call `searchSessions` (without prior sync)
    // Must flush the 2 pending turns AND embed the query in a SINGLE acquire/dispose cycle,
    // and dispose BEFORE `searchSessions` returns!
    env.addSession({
      id: "ses_lifecycle",
      projectID: "proj_life",
      directory: join(env.dir, "life"),
      title: "Lifecycle Test Session",
    })
    env.addTurn({
      sessionID: "ses_lifecycle",
      turnNumber: 1,
      userText: "How does metal gpu memory disposal work?",
      assistantText: "It disposes context, model, and llama immediately in finally.",
    })
    env.addTurn({
      sessionID: "ses_lifecycle",
      turnNumber: 2,
      userText: "Does sqlite wal keep embeddings deduplicated?",
      assistantText: "Yes, embeddings are keyed by content_hash.",
    })

    const searchResult = await indexer.searchSessions({
      query: "metal gpu memory",
      scope: "all",
      limit: 5,
    })

    assert.equal(
      tracked.embedder.isActive,
      false,
      "Embedder must already be disposed before searchSessions() returns",
    )
    assert.equal(
      tracked.isCurrentlyDisposed,
      true,
      "Underlying llama session must be disposed before searchSessions() returns",
    )
    assert.equal(
      tracked.acquireCount,
      1,
      "Flushing 2 pending turns + embedding query must happen in a SINGLE acquire cycle",
    )
    assert.equal(tracked.disposeCount, 1, "Must dispose immediately after the single scope finishes")
    assert.deepEqual(tracked.disposeEvents, ["context.dispose", "model.dispose", "llama.dispose"])
    assert.equal(searchResult.syncedTurns, 2)
    assert.equal(searchResult.items.length, 2)
    assert.equal(searchResult.items[0]?.sessions[0]?.turnIndex, 1)

    // 3. Subsequent `syncPendingSessions()` with no new turns -> 0 acquire calls
    tracked.resetCounters()
    const noopSync = await indexer.syncPendingSessions()
    assert.equal(noopSync.embeddedCount, 0)
    assert.equal(tracked.acquireCount, 0)
    assert.equal(tracked.disposeCount, 0)

    // 4. Reference-counted concurrent `withScope` calls share a single acquire/dispose cycle
    tracked.resetCounters()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const p1 = tracked.embedder.withScope(async (embedBatch) => {
      assert.equal(tracked.embedder.isActive, true)
      await firstGate
      return await embedBatch(["redis timeout"])
    })

    const p2 = tracked.embedder.withScope(async (embedBatch) => {
      assert.equal(tracked.embedder.activeUserCount, 2)
      const res = await embedBatch(["sqlite wal"])
      releaseFirst()
      return res
    })

    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(r1.length, 1)
    assert.equal(r2.length, 1)
    assert.equal(tracked.acquireCount, 1, "Concurrent withScope calls must share 1 acquire")
    assert.equal(tracked.disposeCount, 1, "Concurrent withScope calls must dispose once when activeUsers reaches 0")
    assert.equal(tracked.embedder.isActive, false)

    // 5. Idle debounce cancellation on busy/prompt
    indexer.scheduleIdleSync()
    assert.equal(indexer.hasPendingIdleTimer, true)
    indexer.cancelIdleSync()
    assert.equal(indexer.hasPendingIdleTimer, false)
  } finally {
    await indexer.dispose()
    env.cleanup()
  }
})

test("Test 5: Multi-chunk slicing when exceeding 2048 token limit, full-turn searchability, and legacy schema migration", async () => {
  const env = createMockOpencodeDb()
  const tracked = createTrackedEmbedder()

  try {
    assert.equal(DEFAULT_EMBEDDING_CONTEXT_SIZE, 2048)
    assert.equal(DEFAULT_MAX_CHUNK_TOKENS, 2000)
    assert.equal(DEFAULT_CHUNK_OVERLAP_TOKENS, 128)
    assert.equal(tracked.embedder.contextSize, 2048)
    assert.equal(tracked.embedder.maxChunkTokens, 2000)

    // Verify legacy schema migration (`content_hash PRIMARY KEY` -> `(content_hash, chunk_index) PRIMARY KEY`)
    const rawPreDb = new DatabaseSync(env.recallDbPath)
    rawPreDb.exec(`
      CREATE TABLE embeddings (
        content_hash TEXT PRIMARY KEY,
        embedding BLOB NOT NULL
      );
    `)
    rawPreDb.close()

    const db = new RecallDatabase({
      dbPath: env.recallDbPath,
      opencodeDbPath: env.opencodeDbPath,
    })
    const indexer = new RecallIndexer({
      db,
      embedder: tracked.embedder,
    })

    const cols = db.db.prepare("PRAGMA main.table_info(embeddings)").all() as Array<{ name: string; pk: number }>
    assert.ok(cols.some((c) => c.name === "chunk_index" && c.pk > 0), "embeddings table must have chunk_index in PK")

    env.addSession({
      id: "ses_long",
      projectID: "proj_long",
      directory: join(env.dir, "long"),
      title: "Long Turn Multi-Chunk Session",
    })

    // Turn 1: Short turn about sqlite wal
    env.addTurn({
      sessionID: "ses_long",
      turnNumber: 1,
      userText: "Short question about sqlite wal",
      assistantText: "Short answer about sqlite wal",
    })

    // Turn 2: Oversized turn (> 2200 tokens): discusses `alpha` at the beginning and `omega` past token 2100
    const fillerWords = Array.from({ length: 2150 }, (_, i) => `filler${i}`).join(" ")
    const longUserText = "Initial discussion about alpha architecture."
    const longAssistantText = `Here is the detailed log: ${fillerWords} and finally at the very end we solved the omega issue in production.`

    env.addTurn({
      sessionID: "ses_long",
      turnNumber: 2,
      userText: longUserText,
      assistantText: longAssistantText,
    })

    const longHash = computeContentHash(longUserText, longAssistantText)
    const syncRes = await indexer.syncPendingSessions()
    assert.equal(syncRes.embeddedCount, 2, "2 turns should be synced")
    assert.equal(db.getTurnCount(), 2)
    assert.equal(db.getEmbeddingCount(), 2, "2 distinct content_hash entries in embeddings")
    assert.ok(
      db.getEmbeddingChunkCount() >= 3,
      `Expected >= 3 total chunk rows across the 2 turns (1 for short + >=2 for oversized), got ${db.getEmbeddingChunkCount()}`,
    )

    // Verify chunk_index rows 0 and 1 exist for the oversized turn
    const longChunks = db.db
      .prepare("SELECT chunk_index FROM main.embeddings WHERE content_hash = ? ORDER BY chunk_index ASC")
      .all(longHash) as Array<{ chunk_index: number }>
    assert.deepEqual(
      longChunks.map((c) => c.chunk_index),
      [0, 1],
      "Oversized turn must be sliced into chunk_index 0 and 1",
    )

    // Search for `omega` (which only appears in chunk_index = 1, past token 2048!)
    const omegaSearch = await indexer.searchSessions({
      query: "omega",
      scope: "all",
      limit: 5,
    })
    assert.equal(omegaSearch.items.length, 2, "Search results must deduplicate multi-chunk turns by content_hash")
    assert.equal(
      omegaSearch.items[0]?.contentHash,
      longHash,
      "Searching for 'omega' past token 2048 must rank the oversized turn #1 via chunk_index=1 MAX(score)",
    )
    assert.equal(omegaSearch.items[0]?.sessions[0]?.turnIndex, 2)

    // Search for `alpha` (which appears in chunk_index = 0)
    const alphaSearch = await indexer.searchSessions({
      query: "alpha",
      scope: "all",
      limit: 5,
    })
    assert.equal(alphaSearch.items[0]?.contentHash, longHash)
    assert.equal(alphaSearch.items[0]?.sessions[0]?.turnIndex, 2)

    // Verify integer-token `TokenizerAdapter` (matching `node-llama-cpp` model.tokenize / model.detokenize)
    const vocabList: string[] = []
    const mockTokenizer = {
      tokenize(text: string): readonly number[] {
        return text.split(/\s+/).filter(Boolean).map((word) => {
          let idx = vocabList.indexOf(word)
          if (idx === -1) {
            idx = vocabList.length
            vocabList.push(word)
          }
          return idx
        })
      },
      detokenize(tokens: readonly number[]): string {
        return tokens.map((id) => vocabList[id] ?? "").join(" ")
      },
    }
    const tokenChunks = splitTextIntoTokenChunks(
      `alpha ${fillerWords} omega`,
      2000,
      128,
      mockTokenizer,
    )
    assert.equal(tokenChunks.length, 2)
    assert.match(tokenChunks[0]!, /^alpha /)
    assert.doesNotMatch(tokenChunks[0]!, /\bomega\b/)
    assert.match(tokenChunks[1]!, /\bomega$/)

    await indexer.dispose()
  } finally {
    env.cleanup()
  }
})

test("Test 6: One-turn-at-a-time streaming (each turn saved to SQLite before next turn is loaded) and resilient error skipping", async () => {
  const env = createMockOpencodeDb()

  // Track the exact DB embedding count at the moment each turn is passed to `embed()`
  const dbCountBeforeEachEmbed: number[] = []
  let dbRef!: RecallDatabase
  let shouldFailTurn2 = true

  const tracked = createTrackedEmbedder({
    onEmbed(text) {
      dbCountBeforeEachEmbed.push(dbRef.getEmbeddingCount())
      if (shouldFailTurn2 && text.includes("turn2")) {
        throw new Error("Simulated transient embedding failure on turn2")
      }
    },
  })

  const db = new RecallDatabase({
    dbPath: env.recallDbPath,
    opencodeDbPath: env.opencodeDbPath,
  })
  dbRef = db
  const indexer = new RecallIndexer({
    db,
    embedder: tracked.embedder,
  })

  try {
    env.addSession({
      id: "ses_stream",
      projectID: "proj_stream",
      directory: join(env.dir, "stream"),
      title: "Streaming Test Session",
    })

    env.addTurn({
      sessionID: "ses_stream",
      turnNumber: 1,
      userText: "Streaming question turn1",
      assistantText: "Streaming answer turn1",
    })
    env.addTurn({
      sessionID: "ses_stream",
      turnNumber: 2,
      userText: "Streaming question turn2",
      assistantText: "Streaming answer turn2",
    })
    env.addTurn({
      sessionID: "ses_stream",
      turnNumber: 3,
      userText: "Streaming question turn3",
      assistantText: "Streaming answer turn3",
    })

    // 1. Verify reconcileTurns() does NOT load missingEmbeddings array into memory by default
    const reconciledOnly = db.reconcileTurns()
    assert.equal(reconciledOnly.missingEmbeddingCount, 3)
    assert.equal(
      reconciledOnly.missingEmbeddings.length,
      0,
      "reconcileTurns() must not load all missing turn texts into memory at once",
    )

    // 2. Run syncPendingSessions: turn1 succeeds (immediately saved -> count=1), turn2 fails & is skipped, turn3 succeeds (saved -> count=2)
    const sync1 = await indexer.syncPendingSessions()
    assert.equal(sync1.embeddedCount, 2, "turn1 and turn3 should succeed while turn2 is skipped without infinite loop")
    assert.equal(db.getEmbeddingCount(), 2)
    assert.deepEqual(
      dbCountBeforeEachEmbed,
      [0, 1, 1],
      "Turn 1 must already be persisted in SQLite (count=1) before Turn 2/Turn 3 are embedded",
    )

    // 3. Now allow turn2 to succeed on the next sync
    shouldFailTurn2 = false
    dbCountBeforeEachEmbed.length = 0
    const sync2 = await indexer.syncPendingSessions()
    assert.equal(sync2.embeddedCount, 1)
    assert.equal(db.getEmbeddingCount(), 3)
    assert.deepEqual(dbCountBeforeEachEmbed, [2])
  } finally {
    await indexer.dispose()
    env.cleanup()
  }
})

test("Test 7: Search queues for all pending turns and indexes completed turns + in-place updates of currently running sessions", async () => {
  const env = createMockOpencodeDb()
  const tracked = createTrackedEmbedder()
  const db = new RecallDatabase({
    dbPath: env.recallDbPath,
    opencodeDbPath: env.opencodeDbPath,
  })
  const indexer = new RecallIndexer({
    db,
    embedder: tracked.embedder,
  })

  try {
    // Running session `ses_running`:
    // - Turn 1 is completed (discusses `sentinel` and `quorum`)
    // - Turn 2 is currently in progress: user message (seq=3) + assistant message (seq=4) containing ONLY a tool call (no text yet!)
    env.addSession({
      id: "ses_running",
      projectID: "proj_run",
      directory: join(env.dir, "run"),
      title: "Currently Running Session",
    })
    env.addTurn({
      sessionID: "ses_running",
      turnNumber: 1,
      userSeq: 1,
      assistantSeq: 2,
      userText: "How should we configure Redis sentinel failover?",
      assistantText: "Configure sentinel monitor with quorum 2.",
    })

    const ts = 1761391320000
    env.ocDb
      .prepare(
        `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
         VALUES ('msg_run_u_2', 'ses_running', 'user', 3, ?, ?, ?)`,
      )
      .run(ts, ts, JSON.stringify({ text: "What about metal gpu acceleration for bidder?" }))

    // Assistant message row seq=4 already exists while running, but only has a tool_use item (no text reply yet)
    env.ocDb
      .prepare(
        `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
         VALUES ('msg_run_a_2', 'ses_running', 'assistant', 4, ?, ?, ?)`,
      )
      .run(
        ts + 500,
        ts + 500,
        JSON.stringify({
          content: [{ type: "tool_use", name: "grep" }],
          time: { created: ts + 500 },
        }),
      )

    // Search while `ses_running` is still in progress on Turn 2:
    // Must index Turn 1 (the completed history of `ses_running`) and find it!
    const searchDuringRun = await indexer.searchSessions({
      query: "sentinel quorum",
      scope: "all",
      limit: 5,
    })
    assert.equal(searchDuringRun.syncedTurns, 1, "Completed Turn 1 of running session must be synced")
    assert.equal(searchDuringRun.items.length, 1)
    assert.equal(searchDuringRun.items[0]?.sessions[0]?.sessionID, "ses_running")
    assert.equal(searchDuringRun.items[0]?.sessions[0]?.turnIndex, 1)

    // Now Turn 2 in `ses_running` finishes by updating `msg_run_a_2` (seq=4) IN-PLACE (MAX(m.seq) stays 4!)
    env.ocDb
      .prepare("UPDATE session_message SET data = ?, time_updated = ? WHERE id = 'msg_run_a_2'")
      .run(
        JSON.stringify({
          content: [
            { type: "tool_use", name: "grep" },
            { type: "text", text: "Enable metal gpu acceleration in the bidder config." },
          ],
          time: { created: ts + 500, completed: ts + 2500 },
        }),
        ts + 2500,
      )

    // Search for Turn 2's topic (`metal gpu bidder`) -> must detect the in-place message update, sync Turn 2, and return it!
    const searchAfterTurn2Completes = await indexer.searchSessions({
      query: "metal gpu bidder",
      scope: "all",
      limit: 5,
    })
    assert.equal(
      searchAfterTurn2Completes.syncedTurns,
      1,
      "In-place completed Turn 2 of running session must be detected as dirty and synced",
    )
    assert.equal(searchAfterTurn2Completes.items.length, 2)
    assert.equal(searchAfterTurn2Completes.items[0]?.sessions[0]?.sessionID, "ses_running")
    assert.equal(searchAfterTurn2Completes.items[0]?.sessions[0]?.turnIndex, 2)

    // Also verify that calling `searchSessions()` while a background `syncPendingSessions()` is in flight
    // waits in the serial queue for all historical turns to finish before executing the search.
    env.addTurn({
      sessionID: "ses_running",
      turnNumber: 3,
      userSeq: 5,
      assistantSeq: 6,
      userText: "Question for turn3 with redis cluster",
      assistantText: "Answer for turn3 with redis cluster",
    })
    env.addTurn({
      sessionID: "ses_running",
      turnNumber: 4,
      userSeq: 7,
      assistantSeq: 8,
      userText: "Question for turn4 with sqlite wal",
      assistantText: "Answer for turn4 with sqlite wal",
    })

    const bgSyncPromise = indexer.syncPendingSessions()
    const queuedSearchPromise = indexer.searchSessions({
      query: "turn4 sqlite wal",
      scope: "all",
      limit: 5,
    })

    const [bgSyncRes, queuedSearchRes] = await Promise.all([bgSyncPromise, queuedSearchPromise])
    assert.equal(bgSyncRes.embeddedCount, 2)
    assert.equal(queuedSearchRes.items[0]?.sessions[0]?.turnIndex, 4)
  } finally {
    await indexer.dispose()
    env.cleanup()
  }
})

test("Test 8: Search result truncation (User 50 chars / Assistant 100 chars) and multi-workspace process-level singleton sharing", async () => {
  // 1. Verify 50 / 100 char truncation
  assert.equal(MAX_RESULT_USER_CHARS, 50)
  assert.equal(MAX_RESULT_ASSISTANT_CHARS, 100)

  const exact50 = "U".repeat(50)
  const over50 = "U".repeat(51)
  assert.equal(truncateDisplayText(exact50, MAX_RESULT_USER_CHARS), exact50)
  assert.equal(truncateDisplayText(over50, MAX_RESULT_USER_CHARS), `${"U".repeat(50)}...`)

  const exact100 = "A".repeat(100)
  const over100 = "A".repeat(105)
  assert.equal(truncateDisplayText(exact100, MAX_RESULT_ASSISTANT_CHARS), exact100)
  assert.equal(truncateDisplayText(over100, MAX_RESULT_ASSISTANT_CHARS), `${"A".repeat(100)}...`)

  const formatted = formatSearchResults(
    "test query",
    [
      {
        score: 0.95,
        contentHash: "hash_1",
        userText: "12345678901234567890123456789012345678901234567890EXTRA_USER_TEXT",
        assistantText:
          "1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890EXTRA_ASSISTANT_TEXT",
        sessions: [
          {
            sessionID: "ses_1",
            title: "Truncation Test",
            directory: "./proj",
            updatedAt: 1761391200000,
            createdAt: 1761391200000,
            forkSessionID: null,
            turnIndex: 1,
            userMessageID: "msg_u_1",
            assistantMessageID: "msg_a_1",
          },
        ],
      },
    ],
    1,
    12,
  )

  assert.match(
    formatted,
    /   User: 12345678901234567890123456789012345678901234567890\.\.\.\n/,
  )
  assert.doesNotMatch(formatted, /EXTRA_USER_TEXT/)
  assert.match(
    formatted,
    /   Assistant: 1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890\.\.\.$/,
  )
  assert.doesNotMatch(formatted, /EXTRA_ASSISTANT_TEXT/)

  // 2. Verify 4 workspaces calling `plugin.setup(ctx)` share 1 single instance and refCount
  const env = createMockOpencodeDb()
  const tracked = createTrackedEmbedder()

  try {
    const cleanups: Array<() => Promise<void>> = []
    for (let i = 1; i <= 4; i++) {
      const cleanup = await plugin.setup({
        options: {
          dbPath: env.recallDbPath,
          opencodeDbPath: env.opencodeDbPath,
          embedder: tracked.embedder,
        },
        location: {
          directory: join(env.dir, `workspace_${i}`),
          project: {
            id: `proj_${i}`,
            directory: join(env.dir, `workspace_${i}`),
            canonical: join(env.dir, `workspace_${i}`),
          },
        },
        tool: {
          async transform(cb: (editor: ToolEditor) => void) {
            cb({
              list: () => [],
              get: () => undefined,
              namespace: () => {},
              add: () => {},
              update: () => {},
              remove: () => {},
            })
            return { dispose: async () => {} }
          },
        },
      } as any)
      cleanups.push(cleanup as () => Promise<void>)
    }

    const instances = Array.from(getSharedRecallInstances().values()).filter(
      (entry) => entry.db.dbPath === env.recallDbPath,
    )
    assert.equal(instances.length, 1, "All 4 workspaces must share 1 single RecallIndexer/RecallDatabase instance")
    assert.equal(instances[0]?.refCount, 4, "Shared instance refCount must be 4")

    // Disposing first 3 workspaces keeps the shared instance alive
    await cleanups[0]!()
    await cleanups[1]!()
    await cleanups[2]!()
    assert.equal(instances[0]?.refCount, 1)

    // Disposing the 4th workspace removes and disposes the shared instance
    await cleanups[3]!()
    const remaining = Array.from(getSharedRecallInstances().values()).filter(
      (entry) => entry.db.dbPath === env.recallDbPath,
    )
    assert.equal(remaining.length, 0, "Shared instance must be removed after last workspace disposes")
  } finally {
    env.cleanup()
  }
})

test("Test 9: OpenCode 2.2.1+ session_part compatibility (part-only, mixed inline+part, ordinal ordering, inline->part migration with 0 re-embeddings, and same-length part edits)", async () => {
  const env = createMockOpencodeDb()
  const tracked = createTrackedEmbedder()
  const db = new RecallDatabase({
    dbPath: env.recallDbPath,
    opencodeDbPath: env.opencodeDbPath,
  })
  const indexer = new RecallIndexer({
    db,
    embedder: tracked.embedder,
  })

  try {
    // Phase 1: Start BEFORE `session_part` table exists (simulating OpenCode 2.2.0)
    assert.equal(db.hasSessionPartTable(), false)

    env.addSession({
      id: "ses_migrate",
      projectID: "proj_part",
      directory: join(env.dir, "part-project"),
      title: "Inline to SessionPart Migration",
    })
    env.addTurn({
      sessionID: "ses_migrate",
      turnNumber: 1,
      userText: "How does redis cluster handle sentinel quorum?",
      assistantText: "Redis cluster uses gossip while sentinel uses quorum voting.",
      reasoningText: "Thinking about sentinel vs cluster",
    })

    const syncInline = await indexer.syncPendingSessions()
    assert.equal(syncInline.embeddedCount, 1)
    assert.equal(db.getTurnCount(), 1)
    assert.equal(db.getEmbeddingCount(), 1)
    assert.equal(tracked.acquireCount, 1)

    // Phase 2: Migrate `oc` while attached by creating `session_part` and moving Turn 1's assistant content into `session_part`
    // while setting `session_message.data.content` to `[]` (simulating OpenCode 2.2.1+ migration / rewrite).
    env.enableSessionPartTable()
    assert.equal(db.hasSessionPartTable(), true)

    const ts1 = 1761391261000
    env.ocDb
      .prepare(
        `INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data)
         VALUES (?, 'ses_migrate', ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        "msg_ses_migrate_a_1",
        0,
        "reasoning",
        ts1,
        ts1,
        JSON.stringify({ type: "reasoning", text: "Thinking about sentinel vs cluster" }),
      )
    env.ocDb
      .prepare(
        `INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data)
         VALUES (?, 'ses_migrate', ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        "msg_ses_migrate_a_1",
        1,
        "text",
        ts1 + 10,
        ts1 + 10,
        JSON.stringify({ type: "text", text: "Redis cluster uses gossip while sentinel uses quorum voting." }),
      )
    env.ocDb
      .prepare("UPDATE session_message SET data = ? WHERE id = 'msg_ses_migrate_a_1'")
      .run(JSON.stringify({ content: [], time: { created: ts1, completed: ts1 + 1000 } }))

    tracked.resetCounters()
    const syncAfterMigration = await indexer.syncPendingSessions()
    assert.equal(
      syncAfterMigration.reconciled.deletedTurns,
      0,
      "Migrated turn MUST NOT be deleted when inline content moves to session_part",
    )
    assert.equal(
      syncAfterMigration.reconciled.deletedEmbeddings,
      0,
      "Existing embedding MUST NOT be deleted when content_hash is unchanged",
    )
    assert.equal(
      syncAfterMigration.embeddedCount,
      0,
      "Migrated turn with identical text MUST NOT be re-embedded",
    )
    assert.equal(
      tracked.acquireCount,
      0,
      "GPU embedder must NOT be acquired when migrating inline message to session_part with unchanged text",
    )
    assert.equal(db.getTurnCount(), 1)
    assert.equal(db.getEmbeddingCount(), 1)

    // Verify a subsequent reconcile is a complete no-op (`upsertedTurns === 0`, fingerprint stabilized)
    const reconcileNoop = db.reconcileTurns()
    assert.equal(reconcileNoop.deletedTurns, 0)
    assert.equal(reconcileNoop.upsertedTurns, 0, "Fingerprint in oc_bounds must match updated_at in session_turns")
    assert.equal(reconcileNoop.missingEmbeddingCount, 0)

    // Phase 3: Mixed session (Turn 1 inline without session_part rows + Turn 2 stored in session_part with multiple ordinals and stale inline content)
    env.addSession({
      id: "ses_mixed",
      projectID: "proj_part",
      directory: join(env.dir, "part-project"),
      title: "Mixed Inline and Multi-Part Session",
    })
    env.addTurn({
      sessionID: "ses_mixed",
      turnNumber: 1,
      userText: "Question turn1 about sqlite wal",
      assistantText: "Inline answer turn1 about sqlite wal",
    })
    // Insert parts out of order (ordinal 2, then 0, then 1) and include stale inline content to verify:
    // 1. `session_part` takes precedence over inline `session_message.data.content`
    // 2. Parts are ordered by `ordinal ASC`
    // 3. Non-text parts (`reasoning`, `tool_use`) are ignored
    env.addPartTurn({
      sessionID: "ses_mixed",
      turnNumber: 2,
      userText: "Question turn2 about llama metal gpu",
      inlineAssistantContent: [{ type: "text", text: "STALE_INLINE_TEXT_THAT_MUST_BE_IGNORED" }],
      parts: [
        {
          ordinal: 2,
          type: "text",
          data: { type: "text", text: "Second part about metal gpu." },
        },
        {
          ordinal: 0,
          type: "reasoning",
          data: { type: "reasoning", text: "REASONING_PART_THAT_MUST_BE_IGNORED" },
        },
        {
          ordinal: 1,
          type: "text",
          data: { text: "First part about llama." },
        },
        {
          ordinal: 3,
          type: "tool_use",
          callID: "call_1",
          data: { type: "tool_use", name: "bash" },
        },
      ],
    })

    tracked.resetCounters()
    const syncMixed = await indexer.syncPendingSessions()
    assert.equal(syncMixed.embeddedCount, 2)
    assert.equal(db.getTurnCount(), 3)

    const turn2Row = db.db
      .prepare(
        "SELECT assistant_text FROM main.session_turns WHERE session_id = 'ses_mixed' AND turn_index = 2",
      )
      .get() as { assistant_text: string }
    assert.equal(
      turn2Row.assistant_text,
      "First part about llama.\nSecond part about metal gpu.",
      "Parts must be joined in ordinal ASC order and override stale inline content",
    )

    // Verify subsequent reconcile is a no-op
    assert.equal(db.reconcileTurns().upsertedTurns, 0)

    // Phase 4: Same-length text edit inside `session_part` with higher `time_updated` (while `session_message` envelope is unchanged!)
    // Change "First part about llama." (23 chars) -> "First part about alpha." (23 chars, exact same byte/char length!)
    const newUpdatedTs = 1761399999000
    env.ocDb
      .prepare(
        `UPDATE session_part
         SET data = ?, time_updated = ?
         WHERE session_id = 'ses_mixed' AND message_id = 'msg_ses_mixed_a_2' AND ordinal = 1`,
      )
      .run(JSON.stringify({ text: "First part about alpha." }), newUpdatedTs)

    tracked.resetCounters()
    const syncAfterSameLenEdit = await indexer.syncPendingSessions()
    assert.equal(
      syncAfterSameLenEdit.reconciled.upsertedTurns,
      1,
      "Same-length edit in session_part with higher time_updated must be detected as dirty",
    )
    assert.equal(
      syncAfterSameLenEdit.embeddedCount,
      1,
      "Updated turn text in session_part must be re-embedded",
    )
    assert.equal(
      syncAfterSameLenEdit.reconciled.deletedEmbeddings,
      1,
      "Old orphan embedding from before the edit must be cleaned up",
    )

    const searchAlpha = await indexer.searchSessions({
      query: "alpha metal gpu",
      scope: "project",
      projectID: "proj_part",
      limit: 5,
    })
    assert.equal(searchAlpha.items[0]?.sessions[0]?.sessionID, "ses_mixed")
    assert.equal(searchAlpha.items[0]?.sessions[0]?.turnIndex, 2)
    assert.match(searchAlpha.items[0]?.assistantText ?? "", /^First part about alpha\./)
  } finally {
    await indexer.dispose()
    env.cleanup()
  }
})

test("Test 10: Revert, Fork deduplication, and in-place streaming completion with session_part", async () => {
  const env = createMockOpencodeDb()
  env.enableSessionPartTable()
  const tracked = createTrackedEmbedder()
  const db = new RecallDatabase({
    dbPath: env.recallDbPath,
    opencodeDbPath: env.opencodeDbPath,
  })
  const indexer = new RecallIndexer({
    db,
    embedder: tracked.embedder,
  })

  try {
    env.addSession({
      id: "ses_part_src",
      projectID: "proj_pf",
      directory: join(env.dir, "pf"),
      title: "SessionPart Source",
      timeCreated: 1761391200000,
    })

    for (let t = 1; t <= 3; t++) {
      env.addPartTurn({
        sessionID: "ses_part_src",
        turnNumber: t,
        userMessageID: `msg_psrc_u_${t}`,
        assistantMessageID: `msg_psrc_a_${t}`,
        userText: `Question for turn${t} in part source`,
        parts: [
          {
            ordinal: 0,
            type: "text",
            data: {
              type: "text",
              text:
                t === 2
                  ? "Answer for turn2 with dsp bidder experiment."
                  : `Answer for turn${t} in part source.`,
            },
          },
        ],
      })
    }

    const sync1 = await indexer.syncPendingSessions()
    assert.equal(sync1.embeddedCount, 3)
    assert.equal(db.getTurnCount(), 3)
    assert.equal(db.getEmbeddingCount(), 3)

    // Fork `ses_part_src` into `ses_part_fork` (where fork turns are stored in `session_part`)
    env.addSession({
      id: "ses_part_fork",
      projectID: "proj_pf",
      forkSessionID: "ses_part_src",
      directory: join(env.dir, "pf"),
      title: "SessionPart Fork",
      timeCreated: 1761392000000,
    })
    for (let t = 1; t <= 2; t++) {
      env.addPartTurn({
        sessionID: "ses_part_fork",
        turnNumber: t,
        userMessageID: `msg_pfork_u_${t}`,
        assistantMessageID: `msg_pfork_a_${t}`,
        userText: `Question for turn${t} in part source`,
        parts: [
          {
            ordinal: 0,
            type: "text",
            data: {
              type: "text",
              text:
                t === 2
                  ? "Answer for turn2 with dsp bidder experiment."
                  : `Answer for turn${t} in part source.`,
            },
          },
        ],
      })
    }

    tracked.resetCounters()
    const syncFork = await indexer.syncPendingSessions()
    assert.equal(syncFork.reconciled.upsertedTurns, 2)
    assert.equal(syncFork.embeddedCount, 0, "Cloned session_part turns in fork must reuse existing embeddings")
    assert.equal(tracked.acquireCount, 0)
    assert.equal(db.getTurnCount(), 5)
    assert.equal(db.getEmbeddingCount(), 3)

    // Staged revert on `ses_part_src` to turn 2 (`msg_psrc_u_2`): invalidates turns 2 and 3 in `ses_part_src`,
    // while `ses_part_fork` retains turn 2's embedding and turn 3's orphan embedding is deleted.
    env.setRevert("ses_part_src", "msg_psrc_u_2")
    const syncRevert = await indexer.syncPendingSessions()
    assert.equal(syncRevert.reconciled.deletedTurns, 2, "Turns 2 and 3 in ses_part_src must be deleted on revert")
    assert.equal(
      syncRevert.reconciled.deletedEmbeddings,
      1,
      "Turn 3 embedding is deleted while Turn 2 embedding survives via ses_part_fork",
    )
    assert.equal(db.getTurnCount(), 3) // turn 1 in src + turns 1..2 in fork
    assert.equal(db.getEmbeddingCount(), 2)

    // Commit revert on `ses_part_src` and simulate an in-progress streaming turn (initially tool_use part only, then text part appended)
    env.commitRevert("ses_part_src")
    env.addPartTurn({
      sessionID: "ses_part_src",
      turnNumber: 4,
      userSeq: 3,
      assistantSeq: 4,
      userMessageID: "msg_psrc_u_4",
      assistantMessageID: "msg_psrc_a_4",
      userText: "How to tune omega sentinel in production?",
      parts: [
        {
          ordinal: 0,
          type: "tool_use",
          callID: "call_grep",
          data: { type: "tool_use", name: "grep" },
        },
      ],
    })

    const syncStreamingToolOnly = await indexer.syncPendingSessions()
    assert.equal(syncStreamingToolOnly.embeddedCount, 0, "Tool-only session_part turn is not indexed until text part arrives")
    assert.equal(db.getTurnCount(), 3)

    // Now append ordinal=1 text part in `session_part` without modifying `session_message` row at all!
    const tsComplete = 1761395000000
    env.ocDb
      .prepare(
        `INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data)
         VALUES ('msg_psrc_a_4', 'ses_part_src', 1, 'text', NULL, ?, ?, ?)`,
      )
      .run(
        tsComplete,
        tsComplete,
        JSON.stringify({ type: "text", text: "Tune omega sentinel quorum and failover timeout." }),
      )

    const searchAfterPartAppended = await indexer.searchSessions({
      query: "omega sentinel",
      scope: "project",
      projectID: "proj_pf",
      limit: 5,
    })
    assert.equal(
      searchAfterPartAppended.syncedTurns,
      1,
      "Appending text part in session_part (even without touching session_message) must trigger sync",
    )
    assert.equal(searchAfterPartAppended.items[0]?.sessions[0]?.sessionID, "ses_part_src")
    assert.equal(searchAfterPartAppended.items[0]?.sessions[0]?.userMessageID, "msg_psrc_u_4")
    assert.equal(searchAfterPartAppended.items[0]?.sessions[0]?.turnIndex, 2)
  } finally {
    await indexer.dispose()
    env.cleanup()
  }
})
