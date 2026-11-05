import { createHash } from "node:crypto"
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { resolveLocalPath } from "./paths.ts"

export interface RecallDbOptions {
  /** Path to the plugin's own SQLite database (or ":memory:" for tests). */
  dbPath?: string
  /** Path to OpenCode's native SQLite database (`opencode.db`). */
  opencodeDbPath?: string
}

export interface ExtractedTurn {
  sessionID: string
  userMessageID: string
  assistantMessageID: string
  userSeq: number
  endSeq: number
  updatedAt: number
  turnIndex: number
  userText: string
  assistantText: string
  contentHash: string
}

export interface MissingEmbeddingItem {
  contentHash: string
  userText: string
  assistantText: string
}

export interface ReconcileOptions {
  excludeSessionID?: string
  includeMissingEmbeddings?: boolean
}

export interface ReconcileSummary {
  deletedTurns: number
  upsertedTurns: number
  deletedEmbeddings: number
  missingEmbeddingCount: number
  missingEmbeddings: MissingEmbeddingItem[]
}

export interface SearchTurnsOptions {
  queryEmbedding: Float32Array | readonly number[]
  scope?: "project" | "all"
  projectID?: string
  directory?: string
  excludeSessionID?: string
  limit?: number
}

export interface SearchResultSession {
  sessionID: string
  title: string
  directory: string
  updatedAt: number
  createdAt: number
  forkSessionID: string | null
  turnIndex: number
  userMessageID: string
  assistantMessageID: string
}

export interface SearchResultItem {
  score: number
  contentHash: string
  userText: string
  assistantText: string
  sessions: SearchResultSession[]
}

export function getDefaultDataHome(): string {
  const configured = process.env.XDG_DATA_HOME
  return configured && isAbsolute(configured) ? configured : join(homedir(), ".local", "share")
}

export function getDefaultOpencodeDbPath(): string {
  return join(getDefaultDataHome(), "opencode", "opencode.db")
}

export function getDefaultRecallDbPath(): string {
  return join(getDefaultDataHome(), "opencode", "recall", "index.sqlite")
}

export function computeContentHash(userText: string, assistantText: string): string {
  return createHash("sha256")
    .update(`${userText}\0${assistantText}`, "utf8")
    .digest("hex")
}

export function normalizeVector(vec: Float32Array | readonly number[]): Float32Array {
  const out = new Float32Array(vec.length)
  let normSq = 0
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i]!
    normSq += v * v
  }
  const norm = Math.sqrt(normSq)
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      out[i] = vec[i]! / norm
    }
  }
  return out
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < len; i++) {
    sum += a[i]! * b[i]!
  }
  return sum
}

export function float32ArrayToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function blobToFloat32Array(blob: Uint8Array): Float32Array {
  if (blob.byteOffset % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
  }
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

export function extractUserText(rawData: string): string {
  try {
    const parsed = JSON.parse(rawData) as {
      text?: unknown
      content?: unknown
    }
    if (typeof parsed?.text === "string") {
      return parsed.text.trim()
    }
    if (Array.isArray(parsed?.content)) {
      const parts: string[] = []
      for (const item of parsed.content) {
        if (
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          const text = ((item as { text: string }).text).trim()
          if (text) parts.push(text)
        }
      }
      return parts.join("\n").trim()
    }
  } catch {
    // Ignore malformed JSON
  }
  return ""
}

export function extractAssistantText(rawData: string): string {
  try {
    const parsed = JSON.parse(rawData) as {
      content?: unknown
      text?: unknown
    }
    if (Array.isArray(parsed?.content)) {
      const parts: string[] = []
      for (const item of parsed.content) {
        if (
          item &&
          typeof item === "object" &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          const text = ((item as { text: string }).text).trim()
          if (text) parts.push(text)
        }
      }
      return parts.join("\n").trim()
    }
    if (typeof parsed?.text === "string") {
      return parsed.text.trim()
    }
  } catch {
    // Ignore malformed JSON
  }
  return ""
}

export interface RawSessionPartRow {
  message_id?: string
  ordinal?: number
  type?: string
  time_updated?: number
  data_len?: number
  data: string
}

export interface RawMessageRow {
  session_id: string
  id: string
  type: string
  seq: number
  time_updated?: number
  data_len?: number
  data: string
  parts?: readonly RawSessionPartRow[]
}

export function extractAssistantTextFromParts(parts: readonly RawSessionPartRow[]): string {
  if (parts.length === 0) return ""
  let ordered = parts
  for (let i = 1; i < parts.length; i++) {
    if ((parts[i]!.ordinal ?? i) < (parts[i - 1]!.ordinal ?? i - 1)) {
      ordered = [...parts].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
      break
    }
  }
  const texts: string[] = []
  for (const part of ordered) {
    try {
      const parsed = JSON.parse(part.data) as {
        type?: unknown
        text?: unknown
      }
      if (!parsed || typeof parsed !== "object") continue
      const parsedType = typeof parsed.type === "string" ? parsed.type : undefined
      const rowType = typeof part.type === "string" && part.type.length > 0 ? part.type : undefined
      const isTextPart =
        (rowType === "text" && (parsedType === undefined || parsedType === "text")) ||
        (rowType === undefined && parsedType === "text")
      if (isTextPart && typeof parsed.text === "string") {
        const text = parsed.text.trim()
        if (text) texts.push(text)
      }
    } catch {
      // Ignore malformed JSON
    }
  }
  return texts.join("\n").trim()
}

export function groupMessagesIntoTurns(rows: readonly RawMessageRow[]): ExtractedTurn[] {
  const turns: ExtractedTurn[] = []

  let currentSessionID: string | null = null
  let sessionTurnCount = 0
  let sessionMaxSeq = 0
  let sessionMaxUpdatedAt = 0
  let sessionDataLenSum = 0
  let sessionMsgCount = 0
  let sessionPartDataLenSum = 0
  let sessionPartCount = 0
  let sessionPartTimeModSum = 0
  let pendingUserMessageID: string | null = null
  let pendingUserSeq = 0
  let pendingEndSeq = 0
  let pendingUserText = ""
  let pendingAssistantTexts: string[] = []
  let lastAssistantMessageID: string | null = null

  const flushPendingTurn = () => {
    if (
      currentSessionID !== null &&
      pendingUserMessageID !== null &&
      pendingUserText.length > 0 &&
      pendingAssistantTexts.length > 0 &&
      lastAssistantMessageID !== null
    ) {
      const assistantText = pendingAssistantTexts.join("\n").trim()
      if (assistantText.length > 0) {
        sessionTurnCount += 1
        turns.push({
          sessionID: currentSessionID,
          userMessageID: pendingUserMessageID,
          assistantMessageID: lastAssistantMessageID,
          userSeq: pendingUserSeq,
          endSeq: pendingEndSeq,
          updatedAt: 0,
          turnIndex: sessionTurnCount,
          userText: pendingUserText,
          assistantText,
          contentHash: computeContentHash(pendingUserText, assistantText),
        })
      }
    }
    pendingUserMessageID = null
    pendingUserSeq = 0
    pendingEndSeq = 0
    pendingUserText = ""
    pendingAssistantTexts = []
    lastAssistantMessageID = null
  }

  const finalizeSessionMaxSeq = () => {
    if (turns.length > 0 && currentSessionID !== null) {
      const lastTurn = turns[turns.length - 1]!
      if (lastTurn.sessionID === currentSessionID) {
        if (sessionMaxSeq > lastTurn.endSeq) {
          lastTurn.endSeq = sessionMaxSeq
        }
        lastTurn.updatedAt =
          sessionMaxUpdatedAt +
          sessionDataLenSum * 31 +
          sessionMsgCount * 17 +
          sessionPartDataLenSum * 37 +
          sessionPartCount * 13 +
          sessionPartTimeModSum
      }
    }
  }

  for (const row of rows) {
    if (row.session_id !== currentSessionID) {
      flushPendingTurn()
      finalizeSessionMaxSeq()
      currentSessionID = row.session_id
      sessionTurnCount = 0
      sessionMaxSeq = 0
      sessionMaxUpdatedAt = 0
      sessionDataLenSum = 0
      sessionMsgCount = 0
      sessionPartDataLenSum = 0
      sessionPartCount = 0
      sessionPartTimeModSum = 0
    }
    if (row.seq > sessionMaxSeq) {
      sessionMaxSeq = row.seq
    }
    const rowUpdated = Number(row.time_updated ?? 0)
    if (rowUpdated > sessionMaxUpdatedAt) {
      sessionMaxUpdatedAt = rowUpdated
    }
    sessionDataLenSum += Number(row.data_len ?? row.data.length)
    sessionMsgCount += 1

    if (row.type === "assistant" && row.parts && row.parts.length > 0) {
      for (const part of row.parts) {
        const partUpdated = Number(part.time_updated ?? 0)
        if (partUpdated > sessionMaxUpdatedAt) {
          sessionMaxUpdatedAt = partUpdated
        }
        sessionPartDataLenSum += Number(part.data_len ?? part.data.length)
        sessionPartCount += 1
        sessionPartTimeModSum += partUpdated % 1000000000
      }
    }

    if (row.type === "user") {
      flushPendingTurn()
      const userText = extractUserText(row.data)
      if (userText.length > 0) {
        pendingUserMessageID = row.id
        pendingUserSeq = row.seq
        pendingEndSeq = row.seq
        pendingUserText = userText
      }
    } else if (row.type === "assistant") {
      if (pendingUserMessageID !== null && pendingUserText.length > 0) {
        pendingEndSeq = row.seq
        const assistantText =
          row.parts && row.parts.length > 0
            ? extractAssistantTextFromParts(row.parts)
            : extractAssistantText(row.data)
        if (assistantText.length > 0) {
          pendingAssistantTexts.push(assistantText)
          lastAssistantMessageID = row.id
        }
      }
    }
  }

  flushPendingTurn()
  finalizeSessionMaxSeq()
  return turns
}

export class RecallDatabase {
  readonly db: DatabaseSync
  readonly dbPath: string
  readonly opencodeDbPath: string
  private closed = false

  constructor(options: RecallDbOptions = {}) {
    this.dbPath = options.dbPath === ":memory:" ? ":memory:" : resolveLocalPath(options.dbPath ?? getDefaultRecallDbPath())
    this.opencodeDbPath = resolveLocalPath(options.opencodeDbPath ?? getDefaultOpencodeDbPath())

    const canonical = (path: string) => existsSync(path) ? realpathSync(path) : path
    if (this.dbPath !== ":memory:" && canonical(this.dbPath) === canonical(this.opencodeDbPath)) {
      throw new Error("Recall dbPath must differ from the read-only OpenCode database path.")
    }

    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 })
      closeSync(openSync(this.dbPath, "a", 0o600))
      chmodSync(this.dbPath, 0o600)
    }

    this.db = new DatabaseSync(this.dbPath)
    this.db.exec("PRAGMA busy_timeout = 5000;")
    if (this.dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
    }

    const attachUri = `${pathToFileURL(this.opencodeDbPath).href}?mode=ro`
    this.db.prepare("ATTACH DATABASE ? AS oc").run(attachUri)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS main.session_turns (
        session_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        user_seq INTEGER NOT NULL,
        end_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        turn_index INTEGER NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (session_id, user_message_id)
      );

      CREATE INDEX IF NOT EXISTS main.idx_session_turns_hash
        ON session_turns(content_hash);
    `)

    const turnCols = this.db
      .prepare("PRAGMA main.table_info(session_turns)")
      .all() as Array<{ name: string }>
    if (!turnCols.some((c) => c.name === "updated_at")) {
      this.db.exec(
        "ALTER TABLE main.session_turns ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;",
      )
    }

    const embCols = this.db
      .prepare("PRAGMA main.table_info(embeddings)")
      .all() as Array<{ name: string }>
    if (embCols.length > 0 && !embCols.some((c) => c.name === "chunk_index")) {
      this.db.exec(`
        ALTER TABLE main.embeddings RENAME TO embeddings_legacy_v1;
        CREATE TABLE main.embeddings (
          content_hash TEXT NOT NULL,
          chunk_index INTEGER NOT NULL DEFAULT 0,
          embedding BLOB NOT NULL,
          PRIMARY KEY (content_hash, chunk_index)
        );
        INSERT OR IGNORE INTO main.embeddings (content_hash, chunk_index, embedding)
        SELECT content_hash, 0, embedding FROM main.embeddings_legacy_v1;
        DROP TABLE main.embeddings_legacy_v1;
      `)
    } else {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS main.embeddings (
          content_hash TEXT NOT NULL,
          chunk_index INTEGER NOT NULL DEFAULT 0,
          embedding BLOB NOT NULL,
          PRIMARY KEY (content_hash, chunk_index)
        );
      `)
    }
  }

  hasSessionPartTable(): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS present FROM oc.sqlite_master WHERE type = 'table' AND name = 'session_part' LIMIT 1",
      )
      .get() as { present?: number } | undefined
    return row?.present === 1
  }

  /**
   * Executes the cross-DB reconciliation pipeline against `oc.session_v2`, `oc.session_message`,
   * and (when present in OpenCode 2.2.1+) `oc.session_part`:
   * 1. Delete stale/reverted turns in `main.session_turns`.
   * 2. Upsert completed `(user, assistant)` turns from `oc` into `main.session_turns` (including running sessions' completed history).
   * 3. Delete orphan embeddings in `main.embeddings` no longer referenced by any row in `main.session_turns`.
   * 4. Count distinct missing `content_hash` items without loading all full texts into memory at once.
   */
  reconcileTurns(options: ReconcileOptions = {}): ReconcileSummary {
    const excludeSessionID = options.excludeSessionID ?? null
    const hasSessionPart = this.hasSessionPartTable()

    this.db.exec("BEGIN IMMEDIATE")
    try {
      // Step 1a: Pure SQL cleanup of turns belonging to deleted sessions or messages invalidated by revert / physical deletion.
      const deleteInvalidStmt = this.db.prepare(`
        WITH valid_sessions AS (
          SELECT
            s.id AS session_id,
            CASE
              WHEN s.revert IS NOT NULL AND json_valid(s.revert) THEN (
                SELECT rm.seq
                FROM oc.session_message rm
                WHERE rm.session_id = s.id
                  AND rm.id = json_extract(s.revert, '$.messageID')
              )
              ELSE NULL
            END AS revert_seq
          FROM oc.session_v2 s
          WHERE s.parent_id IS NULL
        ),
        valid_messages AS (
          SELECT m.session_id, m.id, m.type, m.seq
          FROM oc.session_message m
          JOIN valid_sessions vs ON vs.session_id = m.session_id
          WHERE m.type IN ('user', 'assistant')
            AND (vs.revert_seq IS NULL OR m.seq < vs.revert_seq)
        )
        DELETE FROM main.session_turns
        WHERE session_id NOT IN (SELECT session_id FROM valid_sessions)
           OR (
             (? IS NULL OR session_id != ?)
             AND (
               NOT EXISTS (
                 SELECT 1 FROM valid_messages vm
                 WHERE vm.session_id = main.session_turns.session_id
                   AND vm.id = main.session_turns.user_message_id
                   AND vm.type = 'user'
               )
               OR NOT EXISTS (
                 SELECT 1 FROM valid_messages vm
                 WHERE vm.session_id = main.session_turns.session_id
                   AND vm.id = main.session_turns.assistant_message_id
                   AND vm.type = 'assistant'
               )
             )
           )
        RETURNING session_id
      `)
      const deletedRows = deleteInvalidStmt.all(excludeSessionID, excludeSessionID) as Array<{
        session_id: string
      }>
      let deletedTurns = deletedRows.length
      const invalidatedSessions = new Set(deletedRows.map((r) => r.session_id))

      // Identify sessions whose valid message boundary or message fingerprint in `oc` differs from `main.session_turns`
      const candidateSessionsSql = hasSessionPart
        ? `
          WITH target_sessions AS (
            SELECT
              s.id AS session_id,
              CASE
                WHEN s.revert IS NOT NULL AND json_valid(s.revert) THEN (
                  SELECT rm.seq
                  FROM oc.session_message rm
                  WHERE rm.session_id = s.id
                    AND rm.id = json_extract(s.revert, '$.messageID')
                )
                ELSE NULL
              END AS revert_seq
            FROM oc.session_v2 s
            WHERE s.parent_id IS NULL
              AND (? IS NULL OR s.id != ?)
          ),
          part_agg AS (
            SELECT
              p.session_id,
              p.message_id,
              COALESCE(MAX(p.time_updated), 0) AS max_part_updated,
              COALESCE(SUM(LENGTH(p.data)), 0) AS part_data_len,
              COUNT(p.ordinal) AS part_count,
              COALESCE(SUM(COALESCE(p.time_updated, 0) % 1000000000), 0) AS part_time_mod
            FROM target_sessions ts
            JOIN oc.session_part p ON p.session_id = ts.session_id
            GROUP BY p.session_id, p.message_id
          ),
          oc_bounds AS (
            SELECT
              ts.session_id,
              ts.revert_seq,
              COALESCE(MAX(m.seq), 0) AS max_valid_seq,
              COALESCE(
                MAX(
                  CASE
                    WHEN m.id IS NULL THEN 0
                    ELSE MAX(COALESCE(m.time_updated, 0), COALESCE(pa.max_part_updated, 0))
                  END
                ),
                0
              )
                + COALESCE(SUM(LENGTH(m.data)), 0) * 31
                + COUNT(m.id) * 17
                + COALESCE(SUM(pa.part_data_len), 0) * 37
                + COALESCE(SUM(pa.part_count), 0) * 13
                + COALESCE(SUM(pa.part_time_mod), 0) AS session_fingerprint
            FROM target_sessions ts
            LEFT JOIN oc.session_message m
              ON m.session_id = ts.session_id
              AND m.type IN ('user', 'assistant')
              AND (ts.revert_seq IS NULL OR m.seq < ts.revert_seq)
            LEFT JOIN part_agg pa
              ON pa.session_id = m.session_id
              AND pa.message_id = m.id
              AND m.type = 'assistant'
            GROUP BY ts.session_id
          ),
          st_bounds AS (
            SELECT
              session_id,
              MAX(end_seq) AS max_end_seq,
              MAX(updated_at) AS max_updated_at
            FROM main.session_turns
            GROUP BY session_id
          )
          SELECT
            ob.session_id,
            ob.revert_seq,
            ob.max_valid_seq,
            ob.session_fingerprint,
            COALESCE(sb.max_end_seq, 0) AS max_end_seq,
            COALESCE(sb.max_updated_at, 0) AS max_updated_at
          FROM oc_bounds ob
          LEFT JOIN st_bounds sb ON sb.session_id = ob.session_id
        `
        : `
          WITH target_sessions AS (
            SELECT
              s.id AS session_id,
              CASE
                WHEN s.revert IS NOT NULL AND json_valid(s.revert) THEN (
                  SELECT rm.seq
                  FROM oc.session_message rm
                  WHERE rm.session_id = s.id
                    AND rm.id = json_extract(s.revert, '$.messageID')
                )
                ELSE NULL
              END AS revert_seq
            FROM oc.session_v2 s
            WHERE s.parent_id IS NULL
              AND (? IS NULL OR s.id != ?)
          ),
          oc_bounds AS (
            SELECT
              ts.session_id,
              ts.revert_seq,
              COALESCE(MAX(m.seq), 0) AS max_valid_seq,
              COALESCE(MAX(m.time_updated), 0) + COALESCE(SUM(LENGTH(m.data)), 0) * 31 + COUNT(m.id) * 17 AS session_fingerprint
            FROM target_sessions ts
            LEFT JOIN oc.session_message m
              ON m.session_id = ts.session_id
              AND m.type IN ('user', 'assistant')
              AND (ts.revert_seq IS NULL OR m.seq < ts.revert_seq)
            GROUP BY ts.session_id
          ),
          st_bounds AS (
            SELECT
              session_id,
              MAX(end_seq) AS max_end_seq,
              MAX(updated_at) AS max_updated_at
            FROM main.session_turns
            GROUP BY session_id
          )
          SELECT
            ob.session_id,
            ob.revert_seq,
            ob.max_valid_seq,
            ob.session_fingerprint,
            COALESCE(sb.max_end_seq, 0) AS max_end_seq,
            COALESCE(sb.max_updated_at, 0) AS max_updated_at
          FROM oc_bounds ob
          LEFT JOIN st_bounds sb ON sb.session_id = ob.session_id
        `

      const candidateSessions = this.db
        .prepare(candidateSessionsSql)
        .all(excludeSessionID, excludeSessionID) as Array<{
        session_id: string
        revert_seq: number | null
        max_valid_seq: number
        session_fingerprint: number
        max_end_seq: number
        max_updated_at: number
      }>

      const dirtySessions = candidateSessions.filter(
        (s) =>
          invalidatedSessions.has(s.session_id) ||
          (s.max_valid_seq > 0 &&
            (s.max_valid_seq !== s.max_end_seq || s.session_fingerprint !== s.max_updated_at)),
      )

      let upsertedTurns = 0
      if (dirtySessions.length > 0) {
        const fetchSessionMessagesStmt = this.db.prepare(`
          SELECT
            m.session_id,
            m.id,
            m.type,
            m.seq,
            m.time_updated,
            LENGTH(m.data) AS data_len,
            m.data
          FROM oc.session_message m
          WHERE m.session_id = ?
            AND m.type IN ('user', 'assistant')
            AND (? IS NULL OR m.seq < ?)
          ORDER BY m.seq ASC
        `)

        const fetchSessionPartsStmt = hasSessionPart
          ? this.db.prepare(`
              SELECT
                p.message_id,
                p.ordinal,
                p.type,
                p.time_updated,
                LENGTH(p.data) AS data_len,
                p.data
              FROM oc.session_part p
              JOIN oc.session_message m
                ON m.session_id = p.session_id
                AND m.id = p.message_id
              WHERE p.session_id = ?
                AND m.type = 'assistant'
                AND (? IS NULL OR m.seq < ?)
              ORDER BY m.seq ASC, p.ordinal ASC
            `)
          : null

        const existingForSessionStmt = this.db.prepare(`
          SELECT user_message_id, assistant_message_id
          FROM main.session_turns
          WHERE session_id = ?
        `)

        const deleteByPkStmt = this.db.prepare(`
          DELETE FROM main.session_turns
          WHERE session_id = ? AND user_message_id = ?
        `)

        const upsertStmt = this.db.prepare(`
          INSERT INTO main.session_turns (
            session_id,
            user_message_id,
            assistant_message_id,
            user_seq,
            end_seq,
            updated_at,
            turn_index,
            user_text,
            assistant_text,
            content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, user_message_id) DO UPDATE SET
            assistant_message_id = excluded.assistant_message_id,
            user_seq = excluded.user_seq,
            end_seq = excluded.end_seq,
            updated_at = excluded.updated_at,
            turn_index = excluded.turn_index,
            user_text = excluded.user_text,
            assistant_text = excluded.assistant_text,
            content_hash = excluded.content_hash
          WHERE main.session_turns.assistant_message_id != excluded.assistant_message_id
             OR main.session_turns.user_seq != excluded.user_seq
             OR main.session_turns.end_seq != excluded.end_seq
             OR main.session_turns.updated_at != excluded.updated_at
             OR main.session_turns.turn_index != excluded.turn_index
             OR main.session_turns.content_hash != excluded.content_hash
        `)

        for (const dirty of dirtySessions) {
          const rows = fetchSessionMessagesStmt.all(
            dirty.session_id,
            dirty.revert_seq,
            dirty.revert_seq,
          ) as unknown as RawMessageRow[]

          if (fetchSessionPartsStmt) {
            const partRows = fetchSessionPartsStmt.all(
              dirty.session_id,
              dirty.revert_seq,
              dirty.revert_seq,
            ) as unknown as RawSessionPartRow[]
            if (partRows.length > 0) {
              const partsByMessageID = new Map<string, RawSessionPartRow[]>()
              for (const part of partRows) {
                if (!part.message_id) continue
                let list = partsByMessageID.get(part.message_id)
                if (!list) {
                  list = []
                  partsByMessageID.set(part.message_id, list)
                }
                list.push(part)
              }
              for (const row of rows) {
                if (row.type === "assistant") {
                  const parts = partsByMessageID.get(row.id)
                  if (parts && parts.length > 0) {
                    row.parts = parts
                  }
                }
              }
            }
          }

          const validTurns = groupMessagesIntoTurns(rows)
          const validTurnKeySet = new Set(
            validTurns.map((t) => `${t.userMessageID}\0${t.assistantMessageID}`),
          )

          const existingRows = existingForSessionStmt.all(dirty.session_id) as Array<{
            user_message_id: string
            assistant_message_id: string
          }>
          for (const row of existingRows) {
            if (!validTurnKeySet.has(`${row.user_message_id}\0${row.assistant_message_id}`)) {
              const res = deleteByPkStmt.run(dirty.session_id, row.user_message_id)
              deletedTurns += Number(res.changes ?? 0)
            }
          }

          for (const turn of validTurns) {
            const res = upsertStmt.run(
              turn.sessionID,
              turn.userMessageID,
              turn.assistantMessageID,
              turn.userSeq,
              turn.endSeq,
              turn.updatedAt,
              turn.turnIndex,
              turn.userText,
              turn.assistantText,
              turn.contentHash,
            )
            upsertedTurns += Number(res.changes ?? 0)
          }
        }
      }

      // Step 3: Delete orphan embeddings
      const deleteOrphansResult = this.db
        .prepare(
          `
          DELETE FROM main.embeddings
          WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM main.session_turns)
        `,
        )
        .run()
      const deletedEmbeddings = Number(deleteOrphansResult.changes ?? 0)

      // Step 4: Count missing `content_hash` entries (avoid loading all texts into memory unless explicitly requested)
      const missingEmbeddingCount = this.getMissingEmbeddingCount()
      const missingEmbeddings = options.includeMissingEmbeddings
        ? this.getMissingEmbeddings()
        : []

      this.db.exec("COMMIT")
      return {
        deletedTurns,
        upsertedTurns,
        deletedEmbeddings,
        missingEmbeddingCount,
        missingEmbeddings,
      }
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Ignore rollback errors
      }
      throw error
    }
  }

  /**
   * Returns the count of distinct `content_hash` entries present in `main.session_turns`
   * that do not yet have any slice vector in `main.embeddings`.
   */
  getMissingEmbeddingCount(): number {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(DISTINCT st.content_hash) AS count
        FROM main.session_turns st
        LEFT JOIN main.embeddings e ON e.content_hash = st.content_hash
        WHERE e.content_hash IS NULL
      `,
      )
      .get() as { count: number }
    return Number(row.count)
  }

  /**
   * Streams at most ONE missing `content_hash` entry (`LIMIT 1`) from SQLite into memory.
   */
  getNextMissingEmbedding(excludeHashes?: ReadonlySet<string>): MissingEmbeddingItem | null {
    if (!excludeHashes || excludeHashes.size === 0) {
      const row = this.db
        .prepare(
          `
          SELECT
            st.content_hash AS contentHash,
            st.user_text AS userText,
            st.assistant_text AS assistantText
          FROM main.session_turns st
          LEFT JOIN main.embeddings e ON e.content_hash = st.content_hash
          WHERE e.content_hash IS NULL
          GROUP BY st.content_hash
          ORDER BY MIN(st.user_seq) ASC, st.content_hash ASC
          LIMIT 1
        `,
        )
        .get() as unknown as MissingEmbeddingItem | undefined
      return row ?? null
    }

    const placeholders = Array.from({ length: excludeHashes.size }, () => "?").join(", ")
    const row = this.db
      .prepare(
        `
        SELECT
          st.content_hash AS contentHash,
          st.user_text AS userText,
          st.assistant_text AS assistantText
        FROM main.session_turns st
        LEFT JOIN main.embeddings e ON e.content_hash = st.content_hash
        WHERE e.content_hash IS NULL
          AND st.content_hash NOT IN (${placeholders})
        GROUP BY st.content_hash
        ORDER BY MIN(st.user_seq) ASC, st.content_hash ASC
        LIMIT 1
      `,
      )
      .get(...Array.from(excludeHashes)) as unknown as MissingEmbeddingItem | undefined
    return row ?? null
  }

  /**
   * Returns all distinct `content_hash` entries present in `main.session_turns`
   * that do not yet have a vector in `main.embeddings`.
   */
  getMissingEmbeddings(): MissingEmbeddingItem[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          st.content_hash AS contentHash,
          st.user_text AS userText,
          st.assistant_text AS assistantText
        FROM main.session_turns st
        LEFT JOIN main.embeddings e ON e.content_hash = st.content_hash
        WHERE e.content_hash IS NULL
        GROUP BY st.content_hash
        ORDER BY MIN(st.user_seq) ASC, st.content_hash ASC
      `,
      )
      .all() as unknown as MissingEmbeddingItem[]
    return rows
  }

  /**
   * Atomically saves all slice vectors (`chunk_index = 0..N-1`) for a single turn's `content_hash`.
   */
  saveTurnEmbeddings(
    contentHash: string,
    sliceVectors: ReadonlyArray<Float32Array | readonly number[]>,
  ): void {
    if (sliceVectors.length === 0) return
    this.db.exec("BEGIN IMMEDIATE")
    try {
      this.db.prepare("DELETE FROM main.embeddings WHERE content_hash = ?").run(contentHash)
      const insertStmt = this.db.prepare(`
        INSERT INTO main.embeddings (content_hash, chunk_index, embedding)
        VALUES (?, ?, ?)
      `)
      for (let chunkIndex = 0; chunkIndex < sliceVectors.length; chunkIndex++) {
        const normalized = normalizeVector(sliceVectors[chunkIndex]!)
        insertStmt.run(contentHash, chunkIndex, float32ArrayToBlob(normalized))
      }
      this.db.exec("COMMIT")
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Ignore rollback errors
      }
      throw error
    }
  }

  /**
   * Saves normalized embedding vectors keyed by `(content_hash, chunk_index)`.
   */
  saveEmbeddings(
    entries: ReadonlyArray<{
      contentHash: string
      chunkIndex?: number
      embedding: Float32Array | readonly number[]
    }>,
  ): void {
    if (entries.length === 0) return
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const insertStmt = this.db.prepare(`
        INSERT INTO main.embeddings (content_hash, chunk_index, embedding)
        VALUES (?, ?, ?)
        ON CONFLICT(content_hash, chunk_index) DO UPDATE SET embedding = excluded.embedding
      `)
      for (const entry of entries) {
        const normalized = normalizeVector(entry.embedding)
        insertStmt.run(
          entry.contentHash,
          entry.chunkIndex ?? 0,
          float32ArrayToBlob(normalized),
        )
      }
      this.db.exec("COMMIT")
    } catch (error) {
      try {
        this.db.exec("ROLLBACK")
      } catch {
        // Ignore rollback errors
      }
      throw error
    }
  }

  /**
   * Performs cosine similarity search over `main.embeddings` scoped to matching sessions in `main.session_turns` + `oc.session_v2`,
   * aggregating multi-chunk turns by `MAX(score)` per `content_hash`, selecting Top-K distinct `content_hash` items,
   * and attaching all matching sessions (source session first, then forks).
   */
  searchTurns(options: SearchTurnsOptions): SearchResultItem[] {
    const scope = options.scope ?? "project"
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)))
    const excludeSessionID = options.excludeSessionID ?? null
    const projectID = options.projectID && options.projectID !== "global" ? options.projectID : null
    const directory = options.directory ?? null
    if (scope !== "all" && projectID === null && directory === null) return []
    const useProjectFilter = scope !== "all"

    const queryVec = normalizeVector(options.queryEmbedding)

    // 1. Fetch candidate (content_hash, chunk_index, embedding) slices in scope
    const candidateRows = this.db
      .prepare(
        `
        SELECT DISTINCT
          e.content_hash AS content_hash,
          e.chunk_index AS chunk_index,
          e.embedding AS embedding
        FROM main.embeddings e
        JOIN main.session_turns st ON st.content_hash = e.content_hash
        JOIN oc.session_v2 s ON s.id = st.session_id
        WHERE s.parent_id IS NULL
          AND (? IS NULL OR s.id != ?)
          AND (
            ? = 0
            OR (? IS NOT NULL AND s.project_id = ?)
            OR (? IS NULL AND ? IS NOT NULL AND s.directory = ?)
          )
      `,
      )
      .all(
        excludeSessionID,
        excludeSessionID,
        useProjectFilter ? 1 : 0,
        projectID,
        projectID,
        projectID,
        directory,
        directory,
      ) as Array<{ content_hash: string; chunk_index: number; embedding: Uint8Array }>

    if (candidateRows.length === 0) return []

    // 2. Score every chunk slice and aggregate by `content_hash` using MAX(score)
    const bestScoreByHash = new Map<string, number>()
    for (const row of candidateRows) {
      const vec = blobToFloat32Array(row.embedding)
      const score = dotProduct(queryVec, vec)
      const prev = bestScoreByHash.get(row.content_hash)
      if (prev === undefined || score > prev) {
        bestScoreByHash.set(row.content_hash, score)
      }
    }

    const scored = Array.from(bestScoreByHash.entries(), ([contentHash, score]) => ({
      contentHash,
      score,
    }))

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.contentHash.localeCompare(b.contentHash)
    })

    const topK = scored.slice(0, limit)

    // 3. For each Top-K `content_hash`, fetch all matching sessions ordered with source session first, then forks by creation time
    const sessionLookupStmt = this.db.prepare(`
      SELECT
        st.session_id AS sessionID,
        COALESCE(s.title, '') AS title,
        s.directory AS directory,
        s.time_updated AS updatedAt,
        s.time_created AS createdAt,
        s.fork_session_id AS forkSessionID,
        st.turn_index AS turnIndex,
        st.user_message_id AS userMessageID,
        st.assistant_message_id AS assistantMessageID,
        st.user_text AS userText,
        st.assistant_text AS assistantText
      FROM main.session_turns st
      JOIN oc.session_v2 s ON s.id = st.session_id
      WHERE st.content_hash = ?
        AND s.parent_id IS NULL
        AND (? IS NULL OR s.id != ?)
        AND (
          ? = 0
          OR (? IS NOT NULL AND s.project_id = ?)
          OR (? IS NULL AND ? IS NOT NULL AND s.directory = ?)
        )
      ORDER BY (s.fork_session_id IS NOT NULL) ASC, s.time_created ASC, s.id ASC, st.turn_index ASC
    `)

    const results: SearchResultItem[] = []
    for (const item of topK) {
      const rows = sessionLookupStmt.all(
        item.contentHash,
        excludeSessionID,
        excludeSessionID,
        useProjectFilter ? 1 : 0,
        projectID,
        projectID,
        projectID,
        directory,
        directory,
      ) as Array<{
        sessionID: string
        title: string
        directory: string
        updatedAt: number
        createdAt: number
        forkSessionID: string | null
        turnIndex: number
        userMessageID: string
        assistantMessageID: string
        userText: string
        assistantText: string
      }>

      if (rows.length === 0) continue
      const first = rows[0]!
      results.push({
        score: item.score,
        contentHash: item.contentHash,
        userText: first.userText,
        assistantText: first.assistantText,
        sessions: rows.map((r) => ({
          sessionID: r.sessionID,
          title: r.title,
          directory: r.directory,
          updatedAt: r.updatedAt,
          createdAt: r.createdAt,
          forkSessionID: r.forkSessionID ?? null,
          turnIndex: r.turnIndex,
          userMessageID: r.userMessageID,
          assistantMessageID: r.assistantMessageID,
        })),
      })
    }

    return results
  }

  getTurnCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM main.session_turns")
      .get() as { count: number }
    return Number(row.count)
  }

  getEmbeddingCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT content_hash) AS count FROM main.embeddings")
      .get() as { count: number }
    return Number(row.count)
  }

  getEmbeddingChunkCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM main.embeddings")
      .get() as { count: number }
    return Number(row.count)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // Ignore close errors
    }
  }
}
