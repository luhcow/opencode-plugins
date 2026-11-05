import { Plugin } from "@opencode/plugin/tui"
import { createElement, effect, insert, insertNode, setProp } from "@opentui/solid"
import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { createTpsTracker, formatTpsLabel, type HistoryMessageLike, type TpsSnapshot } from "./core.ts"

export default Plugin.define({
  id: "tps.tui",
  setup(context) {
    const tracker = createTpsTracker()
    const [tick, setTick] = createSignal(Date.now())
    let timer: ReturnType<typeof setInterval> | undefined

    const syncTimer = () => {
      if (tracker.hasActiveStream()) {
        if (!timer) {
          timer = setInterval(() => {
            if (!tracker.hasActiveStream()) {
              clearInterval(timer)
              timer = undefined
              return
            }
            setTick(Date.now())
          }, 100)
        }
      } else if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    }

    const bump = (timestamp?: number) => {
      setTick(timestamp && timestamp > 0 ? Math.max(timestamp, Date.now()) : Date.now())
      syncTimer()
    }

    const subscriptions = [
      context.data.on("session.execution.started", (event) => {
        tracker.onExecutionStarted(event.data.sessionID)
        bump(event.created)
      }),
      context.data.on("session.step.started", (event) => {
        tracker.onStepStarted(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.started,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.text.delta", (event) => {
        tracker.onDelta(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.delta,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.reasoning.delta", (event) => {
        tracker.onDelta(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.delta,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.tool.input.delta", (event) => {
        tracker.onToolInputDelta(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.id,
          event.data.delta,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.tool.input.ended", (event) => {
        tracker.onToolInputEnded(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.id,
          event.data.text,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.tool.called", (event) => {
        tracker.onStepStreamed(event.data.sessionID, event.data.assistantMessageID, event.created)
        bump(event.created)
      }),
      context.data.on("session.step.streamed", (event) => {
        tracker.onStepStreamed(event.data.sessionID, event.data.assistantMessageID, event.created)
        bump(event.created)
      }),
      context.data.on("session.step.ended", (event) => {
        tracker.onStepEnded(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.tokens,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.step.failed", (event) => {
        tracker.onStepFailed(
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.tokens,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.compaction.started", (event) => {
        tracker.onStepStarted(
          event.data.sessionID,
          "compaction",
          event.created,
          event.created,
        )
        bump(event.created)
      }),
      context.data.on("session.compaction.delta", (event) => {
        tracker.onDelta(event.data.sessionID, "compaction", event.data.text, event.created)
        bump(event.created)
      }),
      context.data.on("session.compaction.ended", (event) => {
        tracker.onStepEnded(event.data.sessionID, "compaction", event.data.tokens, event.created)
        bump(event.created)
      }),
      context.data.on("session.compaction.failed", (event) => {
        tracker.onStepFailed(event.data.sessionID, "compaction", event.data.tokens, event.created)
        bump(event.created)
      }),
      context.data.on("session.execution.succeeded", (event) => {
        tracker.onExecutionFinished(event.data.sessionID, event.created)
        bump(event.created)
      }),
      context.data.on("session.execution.failed", (event) => {
        tracker.onExecutionFinished(event.data.sessionID, event.created)
        bump(event.created)
      }),
      context.data.on("session.execution.interrupted", (event) => {
        tracker.onExecutionFinished(event.data.sessionID, event.created)
        bump(event.created)
      }),
    ]

    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const snapshot = createMemo(() => {
          const now = tick()
          const sessionID = props.sessionID
          if (!sessionID) return undefined
          const status = context.data.session.status(sessionID)
          const session = context.data.session.get(sessionID)
          const messages = context.data.session.message.list(sessionID) as unknown as readonly HistoryMessageLike[]
          return tracker.getSnapshot(
            sessionID,
            now,
            messages,
            session?.revert?.messageID,
            status === "running",
          )
        })

        return Show({
          get when() {
            return props.mode === "normal" && props.showDetails ? snapshot() : undefined
          },
          children: (value: () => TpsSnapshot) => {
            const box = createElement("box")
            setProp(box, "flexShrink", 0)
            const text = createElement("text")
            setProp(text, "wrapMode", "none")
            effect((prev) =>
              setProp(
                text,
                "fg",
                value().streaming ? context.theme.hue.accent[500] : context.theme.text.muted,
                prev,
              ),
            )
            insert(text, () => formatTpsLabel(value()))
            insertNode(box, text)
            // OpenTUI accepts native renderables; Solid's shared JSX type is DOM-oriented.
            return box as unknown as JSX.Element
          },
        })
      },
    })

    return () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      subscriptions.forEach((unsubscribe) => unsubscribe())
    }
  },
})
