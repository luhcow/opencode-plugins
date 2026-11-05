import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { getDefaultDataHome, normalizeVector } from "./db.ts"

export const DEFAULT_EMBEDDING_MODEL_URI =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0"

export const DEFAULT_EMBEDDING_CONTEXT_SIZE = 2048
export const DEFAULT_MAX_CHUNK_TOKENS = 2000
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 128

export type EmbedBatchFn = (texts: readonly string[]) => Promise<Float32Array[]>
export type EmbedSlicesFn = (text: string) => Promise<Float32Array[]>

export interface EmbedScope {
  embedBatch: EmbedBatchFn
  embedSlices: EmbedSlicesFn
}

export interface Embedder {
  withScope<T>(fn: (embedBatch: EmbedBatchFn, scope?: EmbedScope) => Promise<T>): Promise<T>
  readonly isActive: boolean
}

export interface DisposableResource {
  dispose(): Promise<void>
}

export interface ActiveEmbeddingSession {
  embed(text: string): Promise<Float32Array | readonly number[]>
  tokenize?(text: string): readonly number[]
  detokenize?(tokens: readonly number[]): string
  context: DisposableResource
  model: DisposableResource
  llama: DisposableResource
}

export interface ScopedEmbedderOptions {
  modelUri?: string
  modelDir?: string
  contextSize?: number
  maxChunkTokens?: number
  chunkOverlapTokens?: number
  /** Optional custom session factory (used in tests to verify strict acquire/dispose lifecycle without downloading GGUF). */
  acquireSession?: () => Promise<ActiveEmbeddingSession>
}

export interface TokenizerAdapter {
  tokenize(text: string): readonly number[]
  detokenize(tokens: readonly number[]): string
}

export function getDefaultModelDir(): string {
  return join(getDefaultDataHome(), "opencode", "recall", "models")
}

/**
 * Splits a text into one or more chunks where each chunk is at most `maxChunkTokens` tokens,
 * with `chunkOverlapTokens` overlap between consecutive chunks so 100% of long turns remain searchable.
 */
export function splitTextIntoTokenChunks(
  text: string,
  maxChunkTokens: number = DEFAULT_MAX_CHUNK_TOKENS,
  chunkOverlapTokens: number = DEFAULT_CHUNK_OVERLAP_TOKENS,
  tokenizer?: TokenizerAdapter,
): string[] {
  const trimmed = text.trim()
  if (!trimmed) return [""]

  const safeMaxTokens = Math.max(1, Math.floor(maxChunkTokens))
  const safeOverlap = Math.max(
    0,
    Math.min(Math.floor(chunkOverlapTokens), Math.floor(safeMaxTokens / 2)),
  )
  const step = Math.max(1, safeMaxTokens - safeOverlap)

  if (tokenizer) {
    const tokens = tokenizer.tokenize(trimmed)
    if (tokens.length <= safeMaxTokens) {
      return [trimmed]
    }
    const chunks: string[] = []
    for (let start = 0; start < tokens.length; start += step) {
      const slice = tokens.slice(start, start + safeMaxTokens)
      const chunkText = tokenizer.detokenize(slice).trim()
      if (chunkText.length > 0) {
        chunks.push(chunkText)
      }
      if (start + safeMaxTokens >= tokens.length) {
        break
      }
    }
    return chunks.length > 0 ? chunks : [trimmed]
  }

  // Fallback lexical tokenizer when running with mock/custom sessions that do not expose GGUF tokenize/detokenize.
  const units = trimmed.match(/\S{1,12}\s*/g) ?? [trimmed]
  if (units.length <= safeMaxTokens) {
    return [trimmed]
  }

  const chunks: string[] = []
  for (let start = 0; start < units.length; start += step) {
    const slice = units.slice(start, start + safeMaxTokens)
    const chunkText = slice.join("").trim()
    if (chunkText.length > 0) {
      chunks.push(chunkText)
    }
    if (start + safeMaxTokens >= units.length) {
      break
    }
  }
  return chunks.length > 0 ? chunks : [trimmed]
}

export class ScopedEmbedder implements Embedder {
  readonly modelUri: string
  readonly modelDir: string
  readonly contextSize: number
  readonly maxChunkTokens: number
  readonly chunkOverlapTokens: number
  private readonly customAcquire?: () => Promise<ActiveEmbeddingSession>

  private activeUsers = 0
  private initPromise: Promise<ActiveEmbeddingSession> | null = null
  private session: ActiveEmbeddingSession | null = null
  private disposePromise: Promise<void> | null = null

  constructor(options: ScopedEmbedderOptions = {}) {
    this.modelUri = options.modelUri ?? DEFAULT_EMBEDDING_MODEL_URI
    this.modelDir = options.modelDir ?? getDefaultModelDir()
    this.contextSize = Math.max(
      64,
      Math.floor(options.contextSize ?? DEFAULT_EMBEDDING_CONTEXT_SIZE),
    )
    const defaultMaxChunk = Math.min(DEFAULT_MAX_CHUNK_TOKENS, Math.max(1, this.contextSize - 8))
    this.maxChunkTokens = Math.max(
      1,
      Math.min(
        Math.floor(options.maxChunkTokens ?? defaultMaxChunk),
        Math.max(1, this.contextSize - 4),
      ),
    )
    this.chunkOverlapTokens = Math.max(
      0,
      Math.min(
        Math.floor(options.chunkOverlapTokens ?? DEFAULT_CHUNK_OVERLAP_TOKENS),
        Math.floor(this.maxChunkTokens / 2),
      ),
    )
    this.customAcquire = options.acquireSession
  }

  get isActive(): boolean {
    return this.activeUsers > 0 || this.session !== null || this.initPromise !== null
  }

  get activeUserCount(): number {
    return this.activeUsers
  }

  async withScope<T>(fn: (embedBatch: EmbedBatchFn, scope: EmbedScope) => Promise<T>): Promise<T> {
    this.activeUsers += 1
    try {
      if (!this.initPromise) {
        const pendingDispose = this.disposePromise
        this.initPromise = (async () => {
          if (pendingDispose) {
            await pendingDispose.catch(() => {})
          }
          const acquired = await this.acquire()
          this.session = acquired
          return acquired
        })()
      }
      const activeSession = await this.initPromise
      const embedBatch: EmbedBatchFn = (texts) => this.embedAll(activeSession, texts)
      const embedSlices: EmbedSlicesFn = (text) => this.embedDocumentSlices(activeSession, text)
      return await fn(embedBatch, { embedBatch, embedSlices })
    } finally {
      this.activeUsers -= 1
      if (this.activeUsers === 0) {
        const currentInit = this.initPromise
        const currentSession = this.session
        this.session = null
        this.initPromise = null

        const prevDispose = this.disposePromise
        const nextDispose = (async () => {
          await prevDispose?.catch(() => {})
          const resolved = currentSession ?? (await currentInit?.catch(() => null))
          if (resolved) {
            await resolved.context.dispose().catch(() => {})
            await resolved.model.dispose().catch(() => {})
            await resolved.llama.dispose().catch(() => {})
          }
        })()
        this.disposePromise = nextDispose
        await nextDispose
        if (this.disposePromise === nextDispose) {
          this.disposePromise = null
        }
      }
    }
  }

  private async acquire(): Promise<ActiveEmbeddingSession> {
    if (this.customAcquire) {
      return await this.customAcquire()
    }

    mkdirSync(this.modelDir, { recursive: true })
    const { getLlama, resolveModelFile } = await import("node-llama-cpp")
    const modelPath = await resolveModelFile(this.modelUri, {
      directory: this.modelDir,
      cli: false,
    })

    const llama = await getLlama()
    try {
      const model = await llama.loadModel({
        modelPath,
        gpuLayers: {
          fitContext: {
            contextSize: this.contextSize,
            embeddingContext: true,
          },
        },
      })
      try {
        const context = await model.createEmbeddingContext({
          contextSize: this.contextSize,
        })
        const maxSafeTokens = Math.max(1, this.contextSize - 4)
        return {
          embed: async (text: string) => {
            const tokens = model.tokenize(text)
            const safeTokens =
              tokens.length > maxSafeTokens ? tokens.slice(0, maxSafeTokens) : tokens
            const embedding = await context.getEmbeddingFor(safeTokens)
            return embedding.vector
          },
          tokenize: (text: string) => model.tokenize(text) as unknown as readonly number[],
          detokenize: (tokens: readonly number[]) => model.detokenize(tokens as never),
          context,
          model,
          llama,
        }
      } catch (error) {
        await model.dispose().catch(() => {})
        throw error
      }
    } catch (error) {
      await llama.dispose().catch(() => {})
      throw error
    }
  }

  private getSessionTokenizer(session: ActiveEmbeddingSession): TokenizerAdapter | undefined {
    if (typeof session.tokenize === "function" && typeof session.detokenize === "function") {
      return {
        tokenize: (text: string) => session.tokenize!(text),
        detokenize: (tokens: readonly number[]) => session.detokenize!(tokens),
      }
    }
    return undefined
  }

  private async embedDocumentSlices(
    session: ActiveEmbeddingSession,
    text: string,
  ): Promise<Float32Array[]> {
    const chunks = splitTextIntoTokenChunks(
      text,
      this.maxChunkTokens,
      this.chunkOverlapTokens,
      this.getSessionTokenizer(session),
    )
    const sliceVectors: Float32Array[] = []
    for (const chunk of chunks) {
      const raw = await session.embed(chunk)
      sliceVectors.push(normalizeVector(raw))
    }
    return sliceVectors
  }

  private async embedAll(
    session: ActiveEmbeddingSession,
    texts: readonly string[],
  ): Promise<Float32Array[]> {
    const vectors: Float32Array[] = []
    for (const text of texts) {
      const slices = await this.embedDocumentSlices(session, text)
      if (slices.length === 1) {
        vectors.push(slices[0]!)
      } else {
        const dim = slices[0]?.length ?? 0
        const avg = new Float32Array(dim)
        for (const slice of slices) {
          for (let i = 0; i < dim; i++) {
            avg[i] = avg[i]! + slice[i]!
          }
        }
        vectors.push(normalizeVector(avg))
      }
    }
    return vectors
  }
}
