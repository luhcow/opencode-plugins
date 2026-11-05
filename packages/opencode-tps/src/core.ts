export interface TokenUsageLike {
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly cache?: {
    readonly read?: number
    readonly write?: number
  }
}

export interface HistoryMessageLike {
  readonly id: string
  readonly type: string
  readonly time?: {
    readonly created?: number
    readonly streamed?: number
    readonly completed?: number
  }
  readonly tokens?: TokenUsageLike
}

export interface TpsSnapshot {
  readonly tps: number
  readonly tokens: number
  readonly durationMs: number
  readonly streaming: boolean
  readonly exact: boolean
}

interface StepState {
  readonly id: string
  startedAt: number
  lastEventAt: number
  firstDeltaAt?: number
  streamedAt?: number
  rawEstimatedTokens: number
  toolInputEstimatedByCall: Map<string, number>
  exactTokens?: number
  streaming: boolean
}

interface SessionState {
  running: boolean
  calibration: number
  steps: StepState[]
}

const CJK_REGEX = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g
const MIN_DURATION_MS = 100
const MIN_CALIBRATION = 0.5
const MAX_CALIBRATION = 2.5

/**
 * Estimate LLM tokens from a raw text/JSON fragment.
 * - CJK characters average ~1.3 tokens per character across modern BPE tokenizers.
 * - Non-CJK characters (ASCII code/prose/JSON) average ~1 token per 3.8 characters.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjkMatches = text.match(CJK_REGEX)
  const cjkCount = cjkMatches ? cjkMatches.length : 0
  const nonCjkCount = text.length - cjkCount
  return cjkCount * 1.3 + nonCjkCount / 3.8
}

export function clampCalibration(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1
  return Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, ratio))
}

export function visibleMessages<T extends { readonly id: string }>(
  messages: readonly T[],
  boundaryMessageID?: string,
): readonly T[] {
  if (!boundaryMessageID) return messages
  const idx = messages.findIndex((m) => m.id === boundaryMessageID)
  return idx === -1 ? messages : messages.slice(0, idx)
}

function findTurnInputIndex(messages: readonly HistoryMessageLike[], end: number, isLegacy: boolean): number {
  let input = -1
  for (let index = end - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.type === "idle") return input
    if (message.type !== "user" && message.type !== "synthetic") continue
    if (isLegacy) return index
    input = index
  }
  return input
}

/**
 * Compute the exact tok/s of the latest turn in persisted session history,
 * matching OpenCode's native `SessionTurn.tokensPerSecond` weighting.
 */
export function historyTurnTps(
  rawMessages: readonly HistoryMessageLike[],
  boundaryMessageID?: string,
): TpsSnapshot | undefined {
  const messages = visibleMessages(rawMessages, boundaryMessageID)
  if (messages.length === 0) return undefined

  let lastAssistantIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type === "assistant") {
      const out = (msg.tokens?.output ?? 0) + (msg.tokens?.reasoning ?? 0)
      if (out > 0 && msg.time?.streamed !== undefined && msg.time?.created !== undefined) {
        lastAssistantIndex = i
        break
      }
    }
  }
  if (lastAssistantIndex === -1) return undefined

  const isLegacy = !messages.some((m) => m.type === "idle")
  const end = lastAssistantIndex + 1
  const start = findTurnInputIndex(messages, end, isLegacy)
  const steps = messages.slice(start + 1, end).filter((m) => m.type === "assistant")

  let totalTokens = 0
  let totalDurationMs = 0
  for (const step of steps) {
    const tokens = (step.tokens?.output ?? 0) + (step.tokens?.reasoning ?? 0)
    const created = step.time?.created
    const streamed = step.time?.streamed
    if (tokens <= 0 || created === undefined || streamed === undefined) continue
    const duration = Math.max(0, streamed - created)
    if (duration <= 0) continue
    totalTokens += tokens
    totalDurationMs += duration
  }

  if (totalTokens <= 0 || totalDurationMs <= 0) return undefined

  return {
    tps: totalTokens / (totalDurationMs / 1_000),
    tokens: totalTokens,
    durationMs: totalDurationMs,
    streaming: false,
    exact: true,
  }
}

export function formatTpsLabel(snapshot: TpsSnapshot): string {
  const rate = snapshot.tps.toFixed(1)
  if (snapshot.streaming) {
    return snapshot.exact ? `⚡ ${rate} tok/s` : `⚡ ~${rate} tok/s`
  }
  return snapshot.exact ? `${rate} tok/s` : `~${rate} tok/s`
}

export function createTpsTracker() {
  const sessions = new Map<string, SessionState>()

  const getOrCreateSession = (sessionID: string): SessionState => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = {
        running: false,
        calibration: 1,
        steps: [],
      }
      sessions.set(sessionID, state)
    }
    return state
  }

  const getOrCreateStep = (state: SessionState, stepID: string, now: number, startedAt?: number): StepState => {
    let step = state.steps.findLast((s) => s.id === stepID)
    if (!step) {
      // Freeze any earlier open step before starting a new one
      for (const prev of state.steps) {
        if (prev.streaming) {
          prev.streaming = false
          prev.streamedAt ??= now
        }
      }
      step = {
        id: stepID,
        startedAt: startedAt ?? now,
        lastEventAt: Math.max(startedAt ?? now, now),
        rawEstimatedTokens: 0,
        toolInputEstimatedByCall: new Map(),
        streaming: true,
      }
      state.steps.push(step)
    } else {
      if (startedAt !== undefined && step.firstDeltaAt === undefined) {
        step.startedAt = startedAt
      }
      if (now > step.lastEventAt) {
        step.lastEventAt = now
      }
    }
    return step
  }

  return {
    onExecutionStarted(sessionID: string) {
      const state = getOrCreateSession(sessionID)
      state.running = true
      state.steps = []
    },

    onStepStarted(sessionID: string, assistantMessageID: string, startedAt: number, now = Date.now()) {
      const state = getOrCreateSession(sessionID)
      if (!state.running) {
        state.running = true
        state.steps = []
      }
      const step = getOrCreateStep(state, assistantMessageID, now, startedAt > 0 ? startedAt : now)
      step.streaming = true
      step.streamedAt = undefined
    },

    onDelta(sessionID: string, assistantMessageID: string, delta: string, now = Date.now()) {
      if (!delta) return
      const state = getOrCreateSession(sessionID)
      if (!state.running) {
        state.running = true
        state.steps = []
      }
      const step = getOrCreateStep(state, assistantMessageID, now)
      step.firstDeltaAt ??= now
      step.streaming = true
      step.rawEstimatedTokens += estimateTokens(delta)
    },

    onToolInputDelta(sessionID: string, assistantMessageID: string, toolCallID: string, delta: string, now = Date.now()) {
      if (!delta) return
      const state = getOrCreateSession(sessionID)
      if (!state.running) {
        state.running = true
        state.steps = []
      }
      const step = getOrCreateStep(state, assistantMessageID, now)
      step.firstDeltaAt ??= now
      step.streaming = true
      const est = estimateTokens(delta)
      step.rawEstimatedTokens += est
      step.toolInputEstimatedByCall.set(toolCallID, (step.toolInputEstimatedByCall.get(toolCallID) ?? 0) + est)
    },

    onToolInputEnded(sessionID: string, assistantMessageID: string, toolCallID: string, fullText: string, now = Date.now()) {
      if (!fullText) return
      const state = getOrCreateSession(sessionID)
      if (!state.running) {
        state.running = true
        state.steps = []
      }
      const step = getOrCreateStep(state, assistantMessageID, now)
      step.firstDeltaAt ??= now
      const totalEst = estimateTokens(fullText)
      const alreadyCounted = step.toolInputEstimatedByCall.get(toolCallID) ?? 0
      if (totalEst > alreadyCounted) {
        step.rawEstimatedTokens += totalEst - alreadyCounted
        step.toolInputEstimatedByCall.set(toolCallID, totalEst)
      }
    },

    onStepStreamed(sessionID: string, assistantMessageID: string, streamedAt = Date.now()) {
      const state = sessions.get(sessionID)
      if (!state) return
      const step = state.steps.findLast((s) => s.id === assistantMessageID) ?? state.steps.at(-1)
      if (!step) return
      step.streamedAt ??= Math.max(step.startedAt, streamedAt)
      step.streaming = false
    },

    onStepEnded(
      sessionID: string,
      assistantMessageID: string,
      tokens: TokenUsageLike | undefined,
      endedAt = Date.now(),
    ) {
      const state = getOrCreateSession(sessionID)
      const step = getOrCreateStep(state, assistantMessageID, endedAt)
      step.streamedAt ??= Math.max(step.startedAt, endedAt)
      step.streaming = false

      const exactOut = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
      if (exactOut > 0) {
        step.exactTokens = exactOut
        if (step.rawEstimatedTokens >= 8) {
          const observedRatio = exactOut / step.rawEstimatedTokens
          state.calibration = clampCalibration(state.calibration * 0.4 + observedRatio * 0.6)
        }
      }
    },

    onStepFailed(
      sessionID: string,
      assistantMessageID: string,
      tokens: TokenUsageLike | undefined,
      endedAt = Date.now(),
    ) {
      const state = sessions.get(sessionID)
      if (!state) return
      const step = state.steps.findLast((s) => s.id === assistantMessageID) ?? state.steps.at(-1)
      if (!step) return
      step.streamedAt ??= Math.max(step.startedAt, endedAt)
      step.streaming = false
      const exactOut = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
      if (exactOut > 0) {
        step.exactTokens = exactOut
      }
    },

    onExecutionFinished(sessionID: string, endedAt = Date.now()) {
      const state = sessions.get(sessionID)
      if (!state) return
      state.running = false
      for (const step of state.steps) {
        if (step.streaming) {
          step.streaming = false
          step.streamedAt ??= Math.max(step.startedAt, endedAt)
        }
      }
    },

    hasActiveStream(sessionID?: string): boolean {
      if (sessionID) {
        const state = sessions.get(sessionID)
        return Boolean(state?.running && state.steps.some((s) => s.streaming))
      }
      for (const state of sessions.values()) {
        if (state.running && state.steps.some((s) => s.streaming)) return true
      }
      return false
    },

    getSnapshot(
      sessionID: string,
      now = Date.now(),
      historyMessages?: readonly HistoryMessageLike[],
      boundaryMessageID?: string,
      sessionRunning?: boolean,
    ): TpsSnapshot | undefined {
      const state = sessions.get(sessionID)
      const isRunning = sessionRunning ?? state?.running ?? false

      // When idle and persisted history has exact turn stats, prefer canonical history
      if (!isRunning && historyMessages && historyMessages.length > 0) {
        const fromHistory = historyTurnTps(historyMessages, boundaryMessageID)
        if (fromHistory) return fromHistory
      }

      if (state && state.steps.length > 0) {
        let totalTokens = 0
        let totalDurationMs = 0
        let allExact = true
        let anyStreaming = false

        for (const step of state.steps) {
          const stepTokens =
            step.exactTokens !== undefined ? step.exactTokens : step.rawEstimatedTokens * state.calibration
          if (stepTokens <= 0) continue

          if (step.exactTokens === undefined) {
            allExact = false
          }
          if (step.streaming) {
            anyStreaming = true
          }

          const liveEndMs =
            now >= step.lastEventAt && now - step.lastEventAt <= 60_000 ? now : step.lastEventAt
          const endMs = step.streamedAt ?? liveEndMs
          const durationMs = Math.max(MIN_DURATION_MS, endMs - step.startedAt)
          totalTokens += stepTokens
          totalDurationMs += durationMs
        }

        if (totalTokens > 0 && totalDurationMs > 0) {
          return {
            tps: totalTokens / (totalDurationMs / 1_000),
            tokens: Math.round(totalTokens),
            durationMs: totalDurationMs,
            streaming: isRunning || anyStreaming,
            exact: allExact && !anyStreaming,
          }
        }
      }

      if (historyMessages && historyMessages.length > 0) {
        return historyTurnTps(historyMessages, boundaryMessageID)
      }

      return undefined
    },
  }
}
