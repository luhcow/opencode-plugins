import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"

const source = process.env.OPENCODE_SOURCE_DIR!
const { createAppFixture } = await import(pathToFileURL(path.join(source, "packages/tui/test/fixture/app.ts")).href)
const plugin = path.resolve(import.meta.dirname, "..")

async function fixture(attachment = false, paged = false) {
  const sessionID = "ses_boundary_view"
  const session = {
    id: sessionID,
    title: "Boundary view",
    projectID: "proj_test",
    location: { directory: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const messages = [
    { id: "msg_001", type: "user", text: "Archived request", time: { created: 1 } },
    {
      id: "msg_002",
      type: "user",
      text: attachment ? "" : "Kept boundary request",
      time: { created: 2 },
      ...(attachment
        ? {
            files: [
              { type: "file", mime: "text/plain", name: "boundary.txt", data: "aGk=", source: { type: "inline" } },
            ],
          }
        : {}),
    },
    { id: "msg_003", type: "user", text: "Later retained request", time: { created: 3 } },
    {
      id: "msg_004",
      type: "compaction",
      status: "completed",
      summary: "## Objective\nBOUNDARY_CHECKPOINT_TEXT",
      metadata: { keepID: "msg_002", compactBefore: { beforeID: "msg_002", requestID: "msg_004" } },
      time: { created: 4 },
    },
  ]
  const original = JSON.stringify(messages)
  const requests: string[] = []
  const setup = await createAppFixture({
    width: 120,
    height: 55,
    args: { sessionID },
    config: { animations: false, tabs: { enabled: false }, plugins: [plugin] },
    fetch: async (url: URL, request: Request) => {
      if (url.pathname === "/api/session") return Response.json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${sessionID}`) return Response.json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return Response.json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/message`) {
        const type = url.searchParams.get("type")
        if (paged && !type && !url.searchParams.has("cursor"))
          return Response.json({
            data: [{ id: "msg_005", type: "user", text: "Newest request", time: { created: 5 } }],
            cursor: { next: "older" },
          })
        const result = type ? messages.filter((message) => message.type === type) : messages
        return Response.json({ data: [...result].reverse(), cursor: {} })
      }
      if (request.method !== "GET") requests.push(`${request.method} ${url.pathname}`)
    },
  })
  return { ...setup, messages, original, requests }
}

async function waitForBoundary(setup: Awaited<ReturnType<typeof fixture>>, before = "Kept boundary request") {
  await setup.waitForFrame(
    (frame: string) =>
      frame.includes("以上历史已总结") &&
      frame.includes("BOUNDARY_CHECKPOINT_TEXT") &&
      frame.indexOf("BOUNDARY_CHECKPOINT_TEXT") < frame.indexOf(before) &&
      frame.split("BOUNDARY_CHECKPOINT_TEXT").length === 2,
  )
}

test("summary renders once before the kept message, and disabling restores the native timeline", async () => {
  await using setup = await fixture()
  await setup.ready
  await waitForBoundary(setup)
  const frame = setup.captureCharFrame()
  expect(frame.indexOf("Archived request")).toBeLessThan(frame.indexOf("BOUNDARY_CHECKPOINT_TEXT"))
  expect(frame.indexOf("BOUNDARY_CHECKPOINT_TEXT")).toBeLessThan(frame.indexOf("Kept boundary request"))
  expect(frame.indexOf("Kept boundary request")).toBeLessThan(frame.indexOf("Later retained request"))
  expect(frame.split("BOUNDARY_CHECKPOINT_TEXT").length - 1).toBe(1)
  expect(JSON.stringify(setup.messages)).toBe(setup.original)
  expect(setup.requests.filter((request: string) => request.includes("/api/session/"))).toEqual([])

  await setup.mockInput.typeText("/plugins")
  await setup.waitForFrame((frame: string) => frame.includes("/plugins"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame: string) => frame.includes("compact-before.tui"))
  await setup.mockInput.typeText("compact-before")
  await setup.waitForFrame((frame: string) => frame.includes("disable"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame: string) => frame.includes("inactive"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame(
    (frame: string) => !frame.includes("以上历史已总结") && frame.includes("BOUNDARY_CHECKPOINT_TEXT"),
  )
  const restored = setup.captureCharFrame()
  expect(restored.indexOf("Later retained request")).toBeLessThan(restored.indexOf("BOUNDARY_CHECKPOINT_TEXT"))

  await setup.mockInput.typeText("/plugins")
  await setup.waitForFrame((frame: string) => frame.includes("/plugins"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame: string) => frame.includes("compact-before.tui"))
  await setup.mockInput.typeText("compact-before")
  await setup.waitForFrame((frame: string) => frame.includes("inactive"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame: string) => frame.includes("disable"))
  setup.mockInput.pressEscape()
  await waitForBoundary(setup)
  expect(setup.captureCharFrame().split("BOUNDARY_CHECKPOINT_TEXT").length - 1).toBe(1)
})

test("attachment-only boundary uses its position among native user rows", async () => {
  await using setup = await fixture(true)
  await setup.ready
  await waitForBoundary(setup, "boundary.txt")
  const frame = setup.captureCharFrame()
  expect(frame.indexOf("Archived request")).toBeLessThan(frame.indexOf("BOUNDARY_CHECKPOINT_TEXT"))
  expect(frame.indexOf("BOUNDARY_CHECKPOINT_TEXT")).toBeLessThan(frame.indexOf("boundary.txt"))
  expect(frame.indexOf("boundary.txt")).toBeLessThan(frame.indexOf("Later retained request"))
  expect(frame.split("BOUNDARY_CHECKPOINT_TEXT").length - 1).toBe(1)
})

test("a checkpoint outside the initial page renders when its history is loaded", async () => {
  await using setup = await fixture(false, true)
  await setup.ready
  await setup.waitForFrame((frame: string) => frame.includes("Newest request"))
  setup.mockInput.pressKey("HOME")
  await waitForBoundary(setup)
  const frame = setup.captureCharFrame()
  expect(frame.indexOf("BOUNDARY_CHECKPOINT_TEXT")).toBeLessThan(frame.indexOf("Kept boundary request"))
  expect(frame.split("BOUNDARY_CHECKPOINT_TEXT").length - 1).toBe(1)
})

test("a newly completed checkpoint moves the boundary and a later native compaction clears it", async () => {
  await using setup = await fixture()
  await setup.ready
  await waitForBoundary(setup)
  const finish = (id: string, text: string, seq: number, beforeID?: string) => {
    setup.events.emit({
      id: `evt_start_${seq}`,
      created: seq,
      type: "session.compaction.started",
      durable: { aggregateID: "ses_boundary_view", seq: String(seq), version: 1 },
      data: { sessionID: "ses_boundary_view", reason: "manual", inputID: id },
    })
    setup.messages.push({
      id,
      type: "compaction",
      status: "completed",
      summary: text,
      time: { created: seq + 1 },
      metadata: beforeID ? { keepID: beforeID, compactBefore: { beforeID, requestID: id } } : undefined,
    })
    setup.events.emit({
      id: `evt_end_${seq}`,
      created: seq + 1,
      type: "session.compaction.ended",
      durable: { aggregateID: "ses_boundary_view", seq: String(seq + 1), version: 1 },
      data: { sessionID: "ses_boundary_view", reason: "manual", text },
    })
  }
  finish("msg_005", "SECOND_CHECKPOINT_TEXT", 5, "msg_003")
  await setup.waitForFrame(
    (frame: string) =>
      frame.includes("SECOND_CHECKPOINT_TEXT") &&
      frame.includes("以上历史已总结") &&
      frame.indexOf("SECOND_CHECKPOINT_TEXT") < frame.indexOf("Later retained request"),
  )
  expect(setup.renderer.root.findDescendantById("compact-before-boundary:msg_004")).toBeUndefined()
  expect(setup.renderer.root.findDescendantById("compact-before-boundary:msg_005")?.parent?.id).toBe("msg_003")
  const frame = setup.captureCharFrame()
  expect(frame.indexOf("Kept boundary request")).toBeLessThan(frame.indexOf("SECOND_CHECKPOINT_TEXT"))
  expect(frame.indexOf("SECOND_CHECKPOINT_TEXT")).toBeLessThan(frame.indexOf("Later retained request"))
  expect(frame.split("SECOND_CHECKPOINT_TEXT").length - 1).toBe(1)

  finish("msg_006", "NATIVE_CHECKPOINT_TEXT", 7)
  await setup.waitForFrame(
    (frame: string) => frame.includes("NATIVE_CHECKPOINT_TEXT") && !frame.includes("以上历史已总结"),
  )
  expect(setup.renderer.root.findDescendantById("compact-before-boundary:msg_005")).toBeUndefined()
})

test("new sessions do not request checkpoints while native optimistic creation is pending", async () => {
  const location = {
    directory: "/tmp/opencode/packages/tui",
    project: { id: "proj_test", directory: "/tmp/opencode", canonical: "/tmp/opencode" },
  }
  const creates: Array<{ id: string; release: () => void }> = []
  const sessions = new Map<string, object>()
  const checkpointReads: string[] = []
  const prompts: string[] = []
  await using setup = await createAppFixture({
    args: { newSessionID: "ses_new_boundary" },
    config: { animations: false, tabs: { enabled: false }, keybinds: { "session.new": "f6" }, plugins: [plugin] },
    fetch: async (url: URL, request: Request) => {
      if (url.pathname === "/api/agent")
        return Response.json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return Response.json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return Response.json({
          location,
          data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }],
        })
      if (url.pathname === "/api/session" && request.method === "POST") {
        const input = await request.json()
        const gate = Promise.withResolvers<void>()
        creates.push({ id: input.id, release: gate.resolve })
        await gate.promise
        const info = {
          ...input,
          projectID: "proj_test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
        }
        sessions.set(input.id, info)
        return Response.json({ data: info })
      }
      const sessionID = url.pathname.split("/")[3]!
      if (/^\/api\/session\/[^/]+\/message$/.test(url.pathname)) {
        if (url.searchParams.get("type") === "compaction") checkpointReads.push(sessionID)
        return sessions.has(sessionID)
          ? Response.json({ data: [], cursor: {} })
          : Response.json({ message: `Session not found: ${sessionID}` }, { status: 404 })
      }
      if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
        prompts.push(sessionID)
        return Response.json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/inbox$/.test(url.pathname)) return Response.json({ data: [] })
      if (/^\/api\/session\/[^/]+\/(agent|model)$/.test(url.pathname)) return new Response(null, { status: 204 })
      if (/^\/api\/session\/[^/]+$/.test(url.pathname)) return Response.json({ data: sessions.get(sessionID) })
    },
  })
  try {
    await setup.ready
    await setup.waitForFrame((frame: string) => frame.includes("Demo Model"))
    for (let index = 0; index < 2; index++) {
      if (index) {
        setup.mockInput.pressKey("F6")
        await setup.renderOnce()
      }
      await setup.mockInput.typeText(`New request ${index + 1}`)
      setup.mockInput.pressEnter()
      await setup.waitForFrame(
        (frame: string) => creates.length === index + 1 && frame.includes(`New request ${index + 1}`),
      )
      expect(prompts).toHaveLength(index)
      creates[index]!.release()
      await setup.waitForFrame(() => prompts.length === index + 1)
      expect(checkpointReads).toEqual([])
      expect(setup.captureCharFrame()).not.toContain("Session not found")
    }
  } finally {
    creates.forEach((create) => create.release())
  }
})
