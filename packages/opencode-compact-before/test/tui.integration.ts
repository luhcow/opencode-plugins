import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { NATIVE_SUMMARY_PROMPT } from "../src/prompt.ts"

const source = process.env.OPENCODE_SOURCE_DIR
if (!source) throw new Error("Set OPENCODE_SOURCE_DIR to an OpenCode 2.2.x checkout")
const { createAppFixture } = await import(pathToFileURL(path.join(source, "packages/tui/test/fixture/app.ts")).href)
const plugin = path.resolve(import.meta.dirname, "..")

test("summary instructions are the unmodified native prompt", async () => {
  const native = await import(pathToFileURL(path.join(source, "packages/core/src/session/compaction.ts")).href)
  expect(NATIVE_SUMMARY_PROMPT).toBe(native.buildPrompt(false))
})

test("one Enter opens the slash selector; keyboard works; full history loads only after selection", async () => {
  const sessionID = "ses_compact_before_ui"
  const directory = "/project"
  const session = {
    id: sessionID,
    title: "Compact before UI",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const users = [
    { id: "msg_earlier", type: "user", text: "Earlier request", time: { created: 0 } },
    { id: "msg_selected", type: "user", text: "Selected request", time: { created: 1 } },
  ]
  let fullReads = 0
  let contextReads = 0
  const pagination: Array<{ cursor: string | null; order: string | null }> = []
  const submitted = Promise.withResolvers<unknown>()
  const json = (body: unknown) => Response.json(body)
  await using setup = await createAppFixture({
    width: 110,
    height: 32,
    args: { sessionID },
    config: { animations: false, tabs: { enabled: false }, plugins: [plugin] },
    fetch: async (url: URL, request: Request) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/context`) {
        contextReads++
        return json({ data: users })
      }
      if (url.pathname === `/api/session/${sessionID}/message`) {
        const cursor = url.searchParams.get("cursor")
        const order = url.searchParams.get("order")
        if (cursor && order) {
          return Response.json(
            { _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" },
            { status: 400 },
          )
        }
        if (url.searchParams.get("type") === "user") {
          pagination.push({ cursor, order })
          if (cursor === "users-end") return json({ data: [], cursor: {} })
          if (cursor === "users-page-2") return json({ data: [users[1]], cursor: { next: "users-end" } })
          return json({ data: [users[0]], cursor: { next: "users-page-2" } })
        }
        if (order === "asc" || cursor?.startsWith("history-")) {
          fullReads++
          pagination.push({ cursor, order })
          if (cursor === "history-end") return json({ data: [], cursor: {} })
          if (cursor === "history-page-2") return json({ data: [users[1]], cursor: { next: "history-end" } })
          return json({ data: [users[0]], cursor: { next: "history-page-2" } })
        }
        return json({ data: [...users].reverse(), cursor: {} })
      }
      if (url.pathname === `/api/session/${sessionID}/message/msg_selected`) return json({ data: users[1] })
      if (url.pathname === "/api/rpc/compact-before/start") {
        submitted.resolve(await request.json())
        return json({ output: { requestID: "msg_compaction" } })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame: string) => frame.includes("Selected request"))
  await setup.mockInput.typeText("/compact-before")
  await setup.waitForFrame((frame: string) => frame.includes("Compact history before a message"))
  expect(setup.captureCharFrame()).not.toContain("/compact-before-at")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame: string) => frame.includes("压缩所选消息之前") && frame.includes("#2"))
  expect(fullReads).toBe(0)
  expect(contextReads).toBe(0)

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame: string) => !frame.includes("压缩所选消息之前"))
  setup.mockInput.pressKey("c", { ctrl: true, meta: true })
  await setup.waitForFrame((frame: string) => frame.includes("压缩所选消息之前") && frame.includes("#2"))
  setup.mockInput.pressEnter()
  const body = await submitted.promise
  expect(body).toEqual({ input: { sessionID, beforeID: "msg_selected", transcript: "[User]: Earlier request" } })
  await setup.waitForFrame((frame: string) => frame.includes("已提交原生压缩"))
  expect(fullReads).toBe(3)
  expect(contextReads).toBe(0)
  expect(pagination.filter((request) => request.cursor).length).toBeGreaterThan(0)
  expect(pagination.every((request) => !request.cursor || request.order === null)).toBe(true)
})

test("staged revert uses the visible prefix and delegates its commit to native compaction", async () => {
  const sessionID = "ses_compact_before_revert"
  let committed = false
  const mutations: string[] = []
  const submitted = Promise.withResolvers<unknown>()
  const users = [
    { id: "msg_old", type: "user", text: "Older request", time: { created: 0 } },
    { id: "msg_keep", type: "user", text: "Kept request", time: { created: 1 } },
    { id: "msg_undo", type: "user", text: "Undone request", time: { created: 2 } },
  ]
  const session = () => ({
    id: sessionID,
    title: "Staged revert",
    projectID: "proj_test",
    location: { directory: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    ...(committed ? {} : { revert: { messageID: "msg_undo", files: [] } }),
  })
  await using setup = await createAppFixture({
    width: 110,
    height: 32,
    args: { sessionID },
    config: { animations: false, tabs: { enabled: false }, plugins: [plugin] },
    fetch: async (url: URL, request: Request) => {
      if (url.pathname === "/api/session") return Response.json({ data: [session()], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return Response.json({ data: session() })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return Response.json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/message`) {
        const visible = committed ? users.slice(0, 2) : users
        return Response.json({
          data: url.searchParams.get("order") === "asc" ? visible : [...visible].reverse(),
          cursor: {},
        })
      }
      if (url.pathname === `/api/session/${sessionID}/message/msg_keep`) return Response.json({ data: users[1] })
      if (url.pathname === `/api/session/${sessionID}/revert/commit`) {
        mutations.push("commit")
        committed = true
        return new Response(null, { status: 204 })
      }
      if (url.pathname === `/api/session/${sessionID}/context`) {
        mutations.push("context")
        return Response.json({ data: committed ? users.slice(0, 2) : users })
      }
      if (url.pathname === "/api/rpc/compact-before/start") {
        mutations.push("start")
        submitted.resolve(await request.json())
        return Response.json({ output: { requestID: "msg_compaction" } })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame: string) => frame.includes("Kept request"))
  setup.mockInput.pressKey("c", { ctrl: true, meta: true })
  await setup.waitForFrame((frame: string) => frame.includes("按撤销后的历史压缩") && frame.includes("#2"))
  expect(setup.captureCharFrame()).not.toContain("#3")
  expect(mutations).toEqual([])
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame: string) => !frame.includes("按撤销后的历史压缩"))
  expect(committed).toBe(false)
  setup.mockInput.pressKey("c", { ctrl: true, meta: true })
  await setup.waitForFrame((frame: string) => frame.includes("按撤销后的历史压缩"))
  setup.mockInput.pressEnter()
  expect(await submitted.promise).toEqual({
    input: { sessionID, beforeID: "msg_keep", transcript: "[User]: Older request" },
  })
  expect(mutations).toEqual(["start"])
})
