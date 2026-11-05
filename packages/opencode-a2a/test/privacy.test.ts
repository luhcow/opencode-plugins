import assert from "node:assert/strict"
import { createServer } from "node:http"
import { join } from "node:path"
import test from "node:test"
import { A2ARestClient } from "../src/client.ts"
import { A2AEventAccumulator } from "../src/format.ts"
import { resolveAgentHeaders } from "../src/auth.ts"

test("discovered cards cannot redirect authenticated calls to an unconfigured origin", async () => {
  const calls: string[] = []
  const client = new A2ARestClient({
    agentId: "example",
    config: { url: "https://agent.example.com", token: "test-only-token" },
    fetch: async (url) => {
      calls.push(String(url))
      return Response.json({ name: "Example", supportedInterfaces: [{ url: "https://other.example.com/a2a", protocolBinding: "HTTP+JSON" }] })
    },
  })
  await assert.rejects(client.executeTurn({ text: "private input" }), /unconfigured origin/)
  assert.deepEqual(calls, ["https://agent.example.com/.well-known/agent-card.json"])
})

test("HTTP errors do not return server-echoed credentials or payloads", async () => {
  const client = new A2ARestClient({
    agentId: "example",
    config: { endpoint: "https://agent.example.com/a2a", discover: false },
    fetch: async () => new Response('echoed test-only-token and private input', { status: 401 }),
  })
  await assert.rejects(client.executeTurn({ text: "private input" }), { message: "A2A HTTP 401" })
})

test("custom response metadata is opt-in and the latest standard context ID is retained", async () => {
  for (const mapped of [false, true]) {
    const accumulator = new A2AEventAccumulator({
      agentId: "example", agentName: "Example",
      responseMetadata: mapped ? { contextIdKey: "custom.context" } : undefined,
    })
    await accumulator.addEvent({ task: {
      id: "t1", contextId: "standard-1", status: { state: "working" }, metadata: { "custom.context": "custom-1" },
    } })
    await accumulator.addEvent({ statusUpdate: { taskId: "t1", contextId: "standard-2", status: { state: "completed" } } })
    assert.equal(accumulator.buildResult().contextId, mapped ? "custom-1" : "standard-2")
  }
})

test("header auth has no service-specific default; relative secret files use the configured directory", () => {
  assert.throws(() => resolveAgentHeaders({ auth: { type: "header", token: "test-only-token" } }), /explicit header/)
  let readPath = ""
  const headers = resolveAgentHeaders({ tokenFile: "secret.txt" }, undefined, {
    baseDirectory: process.cwd(),
    readFile: (path) => { readPath = path; return "test-only-token" },
  })
  assert.equal(readPath, join(process.cwd(), "secret.txt"))
  assert.equal(headers.Authorization, "Bearer test-only-token")
})

test("real HTTP redirects do not forward custom credentials; body reads time out", async () => {
  let redirectedRequests = 0
  const server = createServer((req, res) => {
    if (req.url === "/redirect/message:send") {
      res.writeHead(302, { location: "/recipient" }).end()
    } else if (req.url === "/recipient") {
      redirectedRequests++
      res.end("unexpected")
    } else {
      res.writeHead(200, { "content-type": "application/json" })
      res.flushHeaders()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  try {
    const client = (path: string) => new A2ARestClient({
      agentId: "example", config: { endpoint: `http://127.0.0.1:${address.port}/${path}`, discover: false,
        timeoutMs: 100, headers: { "X-API-Key": "test-only-token" } },
    })
    await assert.rejects(client("redirect").executeTurn({ text: "private input" }))
    assert.equal(redirectedRequests, 0)
    await assert.rejects(client("stall").executeTurn({ text: "private input" }))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
