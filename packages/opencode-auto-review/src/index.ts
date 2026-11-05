import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { parseGuardianAssessment } from "./assessment.js"
import { buildGuardianRiskQuestion, parseDecisionsAnswer } from "./decisions.js"
import { KeyedQueue } from "./keyed-queue.js"
import {
  findHumanReviewReason,
  isEligibleAction,
  parseModelRef,
  parseOptions,
  type ReviewerModelRef,
} from "./options.js"
import {
  REJECTION_INSTRUCTIONS,
  TIMEOUT_INSTRUCTIONS,
  renderClassifierInstructions,
  renderGuardianRejection,
  renderReviewerInstructions,
} from "./prompts.js"
import { AutoReview } from "./rpc.js"
import {
  ASYNC_PROFILE,
  SYNC_PROFILE,
  collectGuardianContext,
  type PermissionEvent,
} from "./transcript.js"

const REVIEW_FAILURE_INSTRUCTIONS =
  "The action was not executed because automatic approval review could not be completed. This is a review failure, not a determination that the action is unsafe. Do not bypass the approval check; resolve the error or ask the user for guidance."

type NoticeSeverity = "success" | "info" | "warning" | "error"

type EvaluationVerdict =
  | {
      readonly kind: "allow"
      readonly reason: string
      readonly notices?: readonly string[]
    }
  | {
      readonly kind: "deny"
      readonly rationale: string
      readonly notices?: readonly string[]
    }
  | {
      readonly kind: "elevated_risk"
      readonly reason: string
      readonly notices?: readonly string[]
    }
  | {
      readonly kind: "failure"
      readonly timedOut?: boolean
      readonly message: string
      readonly notices?: readonly string[]
    }

export default Plugin.define({
  id: "opencode-auto-review",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    let enabled = options.enabled
    let humanFallback = options.humanFallback
    const modelController = new AbortController()
    const inFlight = new Map<string, Promise<EvaluationVerdict>>()
    const activeControllers = new Map<AbortController, string>()
    const reviewerQueue = new KeyedQueue()
    let disposed = false

    const diagnose = (data: Record<string, string>) => {
      if (options.debug) console.info(`opencode-auto-review ${JSON.stringify(data)}`)
    }

    let emitState: () => void = () => undefined
    const setEnabled = (next: boolean): boolean => {
      if (disposed) return enabled
      if (enabled === next) return enabled
      enabled = next
      if (!enabled) for (const controller of activeControllers.keys()) controller.abort()
      emitState()
      return enabled
    }

    const setHumanFallback = (next: boolean): boolean => {
      if (disposed) return humanFallback
      if (humanFallback === next) return humanFallback
      humanFallback = next
      emitState()
      return humanFallback
    }

    const rpcRegistration = await ctx.rpc.register(AutoReview, {
      status: async () => ({ enabled, humanFallback }),
      setEnabled: async (input) => {
        const requested = (input as { enabled?: unknown } | undefined)?.enabled
        if (typeof requested === "boolean") setEnabled(requested)
        return { enabled, humanFallback }
      },
      setFallback: async (input) => {
        const requested = (input as { humanFallback?: unknown } | undefined)?.humanFallback
        if (typeof requested === "boolean") setHumanFallback(requested)
        return { enabled, humanFallback }
      },
    })

    emitState = () => {
      void rpcRegistration.events.emit("state", { enabled, humanFallback }).catch(() => undefined)
    }
    const emitNotice = (description: string, severity: NoticeSeverity) => {
      void rpcRegistration.events.emit("notice", { description, severity }).catch(() => undefined)
    }

    const notified = new Set<string>()
    const NOTICE_ORIGIN_TIMEOUT_MS = 1_000
    const noticeOrigins = new Map<string, string | undefined>()

    async function describeOrigin(sessionID: string, request: string): Promise<string | undefined> {
      if (noticeOrigins.has(sessionID)) return noticeOrigins.get(sessionID)
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        const reviewed = await Promise.race([
          ctx.session.get({ sessionID }),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true
              resolve(undefined)
            }, NOTICE_ORIGIN_TIMEOUT_MS)
          }),
        ])
        if (timedOut) {
          diagnose({ action: "notice_route", request, outcome: "timeout" })
          return undefined
        }
        const origin = reviewed?.parentID ? sessionOrigin(reviewed) : undefined
        if (!disposed) {
          noticeOrigins.set(sessionID, origin)
          if (noticeOrigins.size > 256) noticeOrigins.delete(noticeOrigins.keys().next().value!)
        }
        return origin
      } catch (error) {
        diagnose({ action: "notice_route", request, outcome: "failed", reason: describeError(error) })
        return undefined
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const postNotice = (
      request: string,
      description: string,
      sessionID: string,
      severity: NoticeSeverity,
    ): void => {
      if (disposed || notified.has(request)) return
      notified.add(request)
      if (notified.size > 512) notified.delete(notified.values().next().value!)
      void describeOrigin(sessionID, request)
        .then((origin) => {
          if (disposed) return
          emitNotice(origin ? `${description} (from ${origin})` : description, severity)
        })
        .catch((error) => diagnose({ action: "notice", request, outcome: "notice_failed", reason: describeError(error) }))
    }

    const notifyApproval = (sessionID: string, action: string, request: string): void => {
      diagnose({ action, request, outcome: "notice_approved" })
      postNotice(request, `Auto-review approved ${action}.`, sessionID, "success")
    }

    const notifyWarning = (sessionID: string, action: string, request: string, reason: string): void => {
      const detail = `Auto-review notice (${action}): ${reason.trim()}`
      diagnose({ action, request, outcome: "notice", reason: detail })
      postNotice(request, detail, sessionID, "warning")
    }

    const commandRegistration = await ctx.command.transform((draft) => {
      draft.add({
        name: "auto-review",
        description: "Usage: /auto-review [on|off|toggle|status] or /auto-review fallback [on|off|toggle|status]",
        execute: async ({ prompt }) => {
          const [scope, argument] = prompt.text.trim().toLowerCase().split(/\s+/)
          if (scope === "fallback" || scope === "human") {
            const action = argument || "toggle"
            if (action === "on" || action === "enable") setHumanFallback(true)
            else if (action === "off" || action === "disable") setHumanFallback(false)
            else if (action === "toggle") setHumanFallback(!humanFallback)
            else if (action !== "status") {
              emitNotice("Usage: /auto-review fallback [on|off|toggle|status]", "info")
              return
            }
            emitNotice(`Auto-review human fallback is ${humanFallback ? "enabled" : "disabled"}.`, "info")
            return
          }
          const action = scope || "toggle"
          if (action === "on" || action === "enable") setEnabled(true)
          else if (action === "off" || action === "disable") setEnabled(false)
          else if (action === "toggle") setEnabled(!enabled)
          else if (action !== "status") {
            emitNotice("Usage: /auto-review [on|off|toggle|status]", "info")
            return
          }
          emitNotice(`Auto-review is ${enabled ? "enabled" : "disabled"}.`, "info")
        },
      })
    })

    const promptRegistration = await ctx.session.hook("prompt", (event) => {
      for (const [controller, sessionID] of activeControllers) {
        if (sessionID === event.sessionID) controller.abort()
      }
    })

    const registration = await ctx.permission.hook("evaluate", async (event) => {
      if (!enabled || event.effect !== "ask" || disposed) return
      if (!event.source || event.source.type !== "tool") return
      if (event.agent === options.agent) return
      if (!isEligibleAction(event.action, options.actions)) return

      const humanReason = findHumanReviewReason(event.action, event.resources, options.humanReviewRules)
      if (humanReason) {
        diagnose({ action: event.action, outcome: "human_rule" })
        askHuman(event as PermissionEvent, humanReason)
        return
      }

      const controller = new AbortController()
      const deadline = Date.now() + options.timeoutMs
      let deadlineExpired = false
      const timer = setTimeout(() => {
        deadlineExpired = true
        controller.abort()
      }, options.timeoutMs)
      activeControllers.set(controller, event.sessionID)
      const key = requestIdentity(event as PermissionEvent)

      try {
        diagnose({ action: event.action, request: key, outcome: "started" })
        const verdict = await raceWithAbort(
          evaluateRequest(key, event as PermissionEvent, controller.signal, deadline),
          controller.signal,
        )
        if (disposed || !enabled || controller.signal.aborted) return
        if (deadlineExpired || Date.now() >= deadline) {
          const timeoutMsg = "Automatic approval review timed out while evaluating the requested approval."
          notifyWarning(event.sessionID, event.action, key, timeoutMsg)
          concludeTimeout(event as PermissionEvent, timeoutMsg)
          return
        }

        const notices = verdict.notices ?? []
        diagnose({ action: event.action, request: key, outcome: verdict.kind })

        if (verdict.kind === "allow") {
          if (notices.length) notifyWarning(event.sessionID, event.action, key, notices.join("; "))
          else notifyApproval(event.sessionID, event.action, key)
          event.effect = "allow"
          event.message = withNotices(`Auto-review approved: ${verdict.reason}`, notices)
          return
        }

        if (verdict.kind === "deny") {
          notifyWarning(event.sessionID, event.action, key, verdict.rationale)
          event.effect = "deny"
          event.message = withNotices(renderGuardianRejection(verdict.rationale), notices)
          return
        }

        if (verdict.kind === "elevated_risk") {
          // When the fast classifier flags high risk and no secondary synchronous
          // reviewer model is configured, escalate cleanly to human confirmation
          // (or deny if humanFallback is off) without emitting a false failure error.
          if (notices.length) notifyWarning(event.sessionID, event.action, key, notices.join("; "))
          concludeElevatedRisk(event as PermissionEvent, verdict.reason, notices)
          return
        }

        const failureReasons = [...notices, verdict.message].filter(Boolean)
        notifyWarning(event.sessionID, event.action, key, failureReasons.join("; "))
        if (verdict.timedOut) {
          concludeTimeout(event as PermissionEvent, verdict.message, notices)
        } else {
          concludeFailure(event as PermissionEvent, verdict.message, notices)
        }
      } catch {
        if (!disposed) {
          const aborted = controller.signal.aborted
          const timedOut = aborted && (deadlineExpired || Date.now() >= deadline)
          if (aborted && !timedOut) {
            diagnose({ action: event.action, outcome: "cancelled" })
          } else if (timedOut) {
            const timeoutMsg = "Automatic approval review timed out while evaluating the requested approval."
            diagnose({ action: event.action, outcome: "timeout" })
            notifyWarning(event.sessionID, event.action, key, timeoutMsg)
            concludeTimeout(event as PermissionEvent, timeoutMsg)
          } else {
            const failureMsg = "Automatic approval review failed."
            diagnose({ action: event.action, outcome: "failure" })
            notifyWarning(event.sessionID, event.action, key, failureMsg)
            concludeFailure(event as PermissionEvent, failureMsg)
          }
        }
      } finally {
        activeControllers.delete(controller)
        clearTimeout(timer)
      }
    })

    function evaluateRequest(
      key: string,
      event: PermissionEvent,
      signal: AbortSignal,
      deadline: number,
    ): Promise<EvaluationVerdict> {
      const existing = inFlight.get(key)
      if (existing) return existing
      notified.delete(key)
      const task = reviewerQueue.run(event.sessionID, signal, async (): Promise<EvaluationVerdict> => {
        const messages = await loadSessionMessages(event, signal)
        if (!messages) {
          return {
            kind: "failure",
            message: "Automatic approval review failed: could not identify the complete tool request in session context",
          }
        }
        return await runGuardianReview(messages, event, signal, deadline)
      })
      inFlight.set(key, task)
      void task.finally(() => inFlight.delete(key)).catch(() => undefined)
      return task
    }

    async function runGuardianReview(
      messages: readonly unknown[],
      event: PermissionEvent,
      signal: AbortSignal,
      deadline: number,
    ): Promise<EvaluationVerdict> {
      const catalog = await raceWithAbort(ctx.model.list({ types: ["chat", "decision"] }, { signal }), signal)
      const resolved = await raceWithAbort(
        resolvePrimaryModel(messages, event, catalog.data, signal),
        signal,
      )
      const notices = resolved.notices
      if (!resolved.model) {
        return {
          kind: "failure",
          message: "Automatic approval review failed: could not resolve a reviewer model",
          notices,
        }
      }

      const primaryModel = resolved.model
      const info = catalog.data.find(
        (item) => item.providerID === primaryModel.providerID && item.id === primaryModel.id,
      )
      if (!info) {
        return {
          kind: "failure",
          message: `Automatic approval review failed: reviewer model ${primaryModel.providerID}/${primaryModel.id} is not available`,
          notices,
        }
      }
      if (primaryModel.variant && !info.variants.some((v) => v.id === primaryModel.variant)) {
        return {
          kind: "failure",
          message: `Automatic approval review failed: reviewer variant "${primaryModel.variant}" is not available for ${primaryModel.providerID}/${primaryModel.id}`,
          notices,
        }
      }

      const isDecisionModel = (info as { type?: unknown }).type === "decision"
      if (isDecisionModel) {
        const fastResult = await runDecisionsClassifier(messages, event, primaryModel, signal, deadline)
        if (fastResult.kind === "allow") {
          return notices.length ? { ...fastResult, notices } : fastResult
        }

        // Codex Guardian V2 architecture (`codex-rs/ext/guardian-v2/src/async_scorer/approval.rs`
        // + `codex-rs/ext/guardian-reviewer/src/model.rs`):
        // When the fast `/v1/decisions` classifier returns `"high"` (`ElevatedRisk`) or fails
        // (`ScoringFailure`), escalate to the synchronous chat reviewer. Unless `reviewModel`
        // is explicitly set to `"none"`/`"off"`, it defaults to inheriting the parent
        // conversation model (preferring its `#low` reasoning variant when available).
        const syncModel = await selectSyncReviewModel(
          options.reviewModel,
          messages,
          event,
          catalog.data,
          signal,
        )
        if (syncModel) {
          return await runSynchronousReviewer(messages, event, syncModel, signal, deadline, notices)
        }

        return notices.length ? { ...fastResult, notices } : fastResult
      }

      return await runSynchronousReviewer(messages, event, primaryModel, signal, deadline, notices)
    }

    async function runDecisionsClassifier(
      messages: readonly unknown[],
      event: PermissionEvent,
      model: ReviewerModelRef,
      signal: AbortSignal,
      deadline: number,
    ): Promise<EvaluationVerdict> {
      const decisionsFn = ctx.experimental?.generate?.decisions
      if (typeof decisionsFn !== "function") {
        return {
          kind: "failure",
          message: `Automatic approval review failed: host does not support decision model ${model.providerID}/${model.id}`,
        }
      }

      const collected = collectGuardianContext(messages, event, ASYNC_PROFILE)
      if (!collected) {
        return {
          kind: "failure",
          message: "Automatic approval review failed: could not build transcript context",
        }
      }

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return {
          kind: "failure",
          timedOut: true,
          message: "Automatic approval review timed out while evaluating the requested approval.",
        }
      }

      const timeoutMs = Math.min(options.decisionTimeoutMs, remainingMs)
      const stepController = new AbortController()
      const onParentAbort = () => stepController.abort()
      signal.addEventListener("abort", onParentAbort, { once: true })
      let stepTimedOut = false
      const timer = setTimeout(() => {
        stepTimedOut = true
        stepController.abort()
      }, timeoutMs)

      try {
        const instructions = renderClassifierInstructions(options.extraPolicy)
        const question = buildGuardianRiskQuestion(instructions)
        const response = await raceWithAbort(
          decisionsFn(
            {
              model,
              input: [{ type: "text", text: collected.text }],
              questions: [
                {
                  type: question.type,
                  name: question.name,
                  instructions: question.instructions,
                  choices: question.choices.map((c) => ({ ...c })),
                },
              ],
            },
            { signal: stepController.signal },
          ),
          stepController.signal,
        )

        const parsed = parseDecisionsAnswer(response.answers)
        if (!parsed.ok) {
          return {
            kind: "failure",
            message: `Automatic approval review failed: ${parsed.error}`,
          }
        }

        if (parsed.risk === "low") {
          return {
            kind: "allow",
            reason: "Approved using a low-risk Guardian classification.",
          }
        }

        return {
          kind: "elevated_risk",
          reason: "Guardian classified action risk as high.",
        }
      } catch (error) {
        if (signal.aborted && !stepTimedOut) throw error
        if (stepTimedOut || Date.now() >= deadline) {
          return {
            kind: "failure",
            timedOut: true,
            message: "Automatic approval review timed out while evaluating the requested approval.",
          }
        }
        return {
          kind: "failure",
          message: `Automatic approval review failed: ${describeError(error)}`,
        }
      } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", onParentAbort)
      }
    }

    async function runSynchronousReviewer(
      messages: readonly unknown[],
      event: PermissionEvent,
      model: ReviewerModelRef,
      signal: AbortSignal,
      deadline: number,
      notices: readonly string[],
    ): Promise<EvaluationVerdict> {
      const collected = collectGuardianContext(messages, event, SYNC_PROFILE)
      if (!collected) {
        return {
          kind: "failure",
          message: "Automatic approval review failed: could not build transcript context",
          notices,
        }
      }

      if (Date.now() >= deadline) {
        return {
          kind: "failure",
          timedOut: true,
          message: "Automatic approval review timed out while evaluating the requested approval.",
          notices,
        }
      }

      const instructions = renderReviewerInstructions(options.extraPolicy)
      const prompt = `${instructions}\n${collected.text}`

      try {
        const generateText = ctx.experimental?.generate?.text ?? ctx.generate?.text
        if (typeof generateText !== "function") {
          throw new Error("host does not support text generation")
        }
        const response = await raceWithAbort(
          generateText({ prompt, model }, { signal }),
          signal,
        )
        const parsed = parseGuardianAssessment(response.text)
        if (!parsed.ok) {
          return {
            kind: "failure",
            message: `Automatic approval review failed: ${parsed.error}`,
            notices,
          }
        }
        if (parsed.assessment.outcome === "allow") {
          return {
            kind: "allow",
            reason: parsed.assessment.rationale,
            notices,
          }
        }
        return {
          kind: "deny",
          rationale: parsed.assessment.rationale,
          notices,
        }
      } catch (error) {
        if (signal.aborted && Date.now() < deadline) throw error
        if (Date.now() >= deadline) {
          return {
            kind: "failure",
            timedOut: true,
            message: "Automatic approval review timed out while evaluating the requested approval.",
            notices,
          }
        }
        return {
          kind: "failure",
          message: `Automatic approval review failed: ${describeError(error)}`,
          notices,
        }
      }
    }

    async function selectSyncReviewModel(
      configuredOverride: string | undefined,
      messages: readonly unknown[],
      event: PermissionEvent,
      catalog: ReadonlyArray<{
        providerID: string
        id: string
        type?: unknown
        variants?: ReadonlyArray<{ id: string }>
      }>,
      signal: AbortSignal,
    ): Promise<ReviewerModelRef | undefined> {
      if (configuredOverride === "none" || configuredOverride === "off") return undefined
      if (configuredOverride) {
        const parsed = parseModelRef(configuredOverride)
        if (!parsed) return undefined
        return applyPreferredLowVariant(parsed, catalog, Boolean(parsed.variant))
      }

      return await resolveConversationModel(ctx, messages, event, catalog, signal)
    }

    async function resolvePrimaryModel(
      messages: readonly unknown[],
      event: PermissionEvent,
      catalog: ReadonlyArray<{
        providerID: string
        id: string
        type?: unknown
        variants?: ReadonlyArray<{ id: string }>
      }>,
      signal: AbortSignal,
    ): Promise<{ model: ReviewerModelRef | undefined; notices: string[] }> {
      if (options.model) {
        return { model: parseModelRef(options.model), notices: [] }
      }

      const notices: string[] = []
      const conversationModel = await resolveConversationModel(ctx, messages, event, catalog, signal)
      if (conversationModel) {
        notices.push(
          `no reviewer model configured; inheriting conversation model ${conversationModel.providerID}/${conversationModel.id}`,
        )
        return { model: conversationModel, notices }
      }

      return { model: undefined, notices }
    }

    async function loadSessionMessages(
      event: PermissionEvent,
      signal: AbortSignal,
    ): Promise<readonly unknown[] | undefined> {
      for (let attempt = 0; attempt < 4; attempt++) {
        const context = (await raceWithAbort(
          ctx.session.context({ sessionID: event.sessionID }, { signal }),
          signal,
        )) as unknown
        const messages = Array.isArray(context)
          ? context
          : context && typeof context === "object" && Array.isArray((context as { data?: unknown }).data)
            ? (context as { data: readonly unknown[] }).data
            : undefined
        if (messages && collectGuardianContext(messages, event, ASYNC_PROFILE)) {
          return messages
        }
        if (attempt < 3) await delay(25 * 2 ** attempt, signal)
      }
      return undefined
    }

    function askHuman(event: PermissionEvent, reason: string, notices: readonly string[] = []): void {
      event.effect = "ask"
      event.message = withNotices(`Auto-review requires human confirmation: ${reason.trim()}`, notices)
    }

    function concludeElevatedRisk(event: PermissionEvent, reason: string, notices: readonly string[] = []): void {
      if (humanFallback) {
        askHuman(event, reason, notices)
      } else {
        event.effect = "deny"
        event.message = withNotices(`${reason.trim()}\n${REJECTION_INSTRUCTIONS}`, notices)
      }
    }

    function concludeTimeout(event: PermissionEvent, reason: string, notices: readonly string[] = []): void {
      if (humanFallback) {
        askHuman(event, reason, notices)
      } else {
        event.effect = "deny"
        event.message = withNotices(`${reason.trim()}\n${TIMEOUT_INSTRUCTIONS}`, notices)
      }
    }

    function concludeFailure(event: PermissionEvent, reason: string, notices: readonly string[] = []): void {
      if (humanFallback) {
        askHuman(event, reason, notices)
      } else {
        event.effect = "deny"
        event.message = withNotices(`${reason.trim()}\n${REVIEW_FAILURE_INSTRUCTIONS}`, notices)
      }
    }

    return async () => {
      disposed = true
      modelController.abort()
      inFlight.clear()
      for (const controller of activeControllers.keys()) controller.abort()
      reviewerQueue.clear()
      noticeOrigins.clear()
      notified.clear()
      await registration.dispose()
      await commandRegistration.dispose()
      await promptRegistration.dispose()
      await rpcRegistration.dispose()
    }
  },
})

function sessionOrigin(session: { agent?: string; title?: string } | undefined): string {
  const agent = typeof session?.agent === "string" && session.agent.trim() ? session.agent.trim() : undefined
  const title = typeof session?.title === "string" && session.title.trim() ? session.title.trim() : undefined
  return [agent ? `${agent} subagent` : "subagent", title ? `"${title}"` : undefined].filter(Boolean).join(" ")
}

function withNotices(message: string, notices: readonly string[]): string {
  const unique = [...new Set(notices.map((notice) => notice.trim()).filter(Boolean))]
  return unique.length ? `${message} [auto-review fallback: ${unique.join("; ")}]` : message
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const clean = raw.replace(/\s+/g, " ").trim().slice(0, 300)
  return clean || "unknown error"
}

function requestIdentity(event: PermissionEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.sessionID,
        event.source?.messageID,
        event.source?.id,
        event.action,
        event.resources,
      ]),
    )
    .digest("hex")
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("automatic review aborted")
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(new Error("automatic review aborted"))
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("automatic review aborted"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("automatic review aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

async function resolveConversationModel(
  ctx: Plugin.Context,
  messages: readonly unknown[],
  event: PermissionEvent,
  catalog: ReadonlyArray<{
    providerID: string
    id: string
    type?: unknown
    variants?: ReadonlyArray<{ id: string }>
  }>,
  signal: AbortSignal,
): Promise<ReviewerModelRef | undefined> {
  const inheritedFromMessages = extractConversationModel(messages, event.source?.messageID)
  if (inheritedFromMessages) {
    const resolved = applyPreferredLowVariant(inheritedFromMessages, catalog, false)
    if (resolved) return resolved
  }

  try {
    const session = (await raceWithAbort(
      ctx.session.get({ sessionID: event.sessionID }),
      signal,
    )) as { model?: unknown } | undefined
    const sessionModel = extractModelRefObject(session?.model)
    if (sessionModel) {
      const resolved = applyPreferredLowVariant(sessionModel, catalog, false)
      if (resolved) return resolved
    }
  } catch {
    // Ignore session lookup failure and fall through
  }

  return undefined
}

function copyModelRef(model: ReviewerModelRef): ReviewerModelRef {
  return {
    providerID: model.providerID,
    id: model.id,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

function extractConversationModel(
  messages: readonly unknown[],
  sourceMessageID: string | undefined,
): ReviewerModelRef | undefined {
  if (sourceMessageID) {
    const exact = messages.find(
      (msg) => isRecordObject(msg) && msg.type === "assistant" && msg.id === sourceMessageID,
    )
    if (isRecordObject(exact)) {
      const model = extractModelRefObject(exact.model)
      if (model) return model
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (isRecordObject(msg) && msg.type === "assistant") {
      const model = extractModelRefObject(msg.model)
      if (model) return model
    }
  }
  return undefined
}

function extractModelRefObject(value: unknown): ReviewerModelRef | undefined {
  if (!isRecordObject(value)) return undefined
  if (typeof value.providerID !== "string" || !value.providerID) return undefined
  if (typeof value.id !== "string" || !value.id) return undefined
  const variant = typeof value.variant === "string" && value.variant ? value.variant : undefined
  return {
    providerID: value.providerID,
    id: value.id,
    ...(variant ? { variant } : {}),
  }
}

/**
 * Matches Codex's `select_review_model` (`codex-rs/ext/guardian-reviewer/src/model.rs`):
 * Verifies the candidate is an available chat model and prefers `variant: "low"` when
 * advertised by the model preset unless an explicit override variant was supplied.
 */
function applyPreferredLowVariant(
  candidate: ReviewerModelRef,
  catalog: ReadonlyArray<{
    providerID: string
    id: string
    type?: unknown
    variants?: ReadonlyArray<{ id: string }>
  }>,
  keepExplicitVariant: boolean,
): ReviewerModelRef | undefined {
  const info = catalog.find(
    (item) => item.providerID === candidate.providerID && item.id === candidate.id,
  )
  if (!info || info.type === "decision") return undefined
  const variants = info.variants ?? []
  if (keepExplicitVariant && candidate.variant) {
    return variants.some((v) => v.id === candidate.variant) ? candidate : undefined
  }
  if (variants.some((v) => v.id === "low")) {
    return { providerID: candidate.providerID, id: candidate.id, variant: "low" }
  }
  if (candidate.variant && variants.some((v) => v.id === candidate.variant)) {
    return candidate
  }
  return { providerID: candidate.providerID, id: candidate.id }
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
