import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { A2AFetch } from "../src/types.ts"
import plugin, {
  A2AContextStore,
  A2ARestClient,
  DefaultToolNamingStrategy,
  FALLBACK_SKILL_ID,
  FALLBACK_SKILL_TAG,
  MAX_TOOL_NAME_LENGTH,
  applyFallbackSkill,
  buildAgentCardCandidateUrls,
  buildSkillToolDescription,
  buildSkillToolInputSchema,
  inferSecurityFromCard,
  interpolateConfigValue,
  normalizeA2AEventPayload,
  parseSseResponse,
  resolveAgentHeaders,
  resolveAgentSkills,
  resolveRestEndpoint,
  type A2AAgentCard,
  type A2APart,
  type A2ASendMessageRequest,
} from "../src/index.ts"

interface RegisteredTool {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (
    input: Record<string, unknown>,
    context: {
      sessionID?: string
      signal: AbortSignal
      progress: (update: Record<string, unknown>) => Promise<void>
    },
  ) => Promise<{ content: string; metadata?: Record<string, unknown> }>
}

function createMockPluginHost(options: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>()
  let disposed = false

  const ctx = {
    options,
    tool: {
      transform: async (fn: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
        fn({
          add(tool) {
            tools.set(tool.name, tool)
          },
        })
        return {
          dispose: async () => {
            disposed = true
          },
        }
      },
    },
  }

  return {
    ctx,
    tools,
    isDisposed: () => disposed,
  }
}

function createSseResponse(events: Array<{ event?: string; data: unknown }>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of events) {
        const lines: string[] = []
        if (item.event) {
          lines.push(`event: ${item.event}`)
        }
        const json = typeof item.data === "string" ? item.data : JSON.stringify(item.data)
        for (const line of json.split("\n")) {
          lines.push(`data: ${line}`)
        }
        controller.enqueue(encoder.encode(`${lines.join("\r\n")}\r\n\r\n`))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  })
}

const EXAMPLE_AGENT_CARD: A2AAgentCard = {
  name: "Example Agent",
  description:
    "Operate an example observability platform via natural language: query alert events/rules, dashboards, datasources, hosts.",
  version: "1.0.0",
  supportedInterfaces: [
    {
      url: "https://agent.example.com/a2a",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
    },
  ],
  capabilities: {
    streaming: true,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  securityRequirements: [{ schemes: { "x-user-token": [] } }],
  securitySchemes: {
    "x-user-token": {
      apiKeySecurityScheme: {
        description: "Example API token.",
        location: "header",
        name: "X-User-Token",
      },
    },
  },
  skills: [
    {
      id: "create-alert-rule",
      name: "create-alert-rule",
      description: "Create alert rules for Prometheus, Loki, MySQL, and host metrics.",
      tags: ["export", "alerting"],
      examples: [
        "Help me create an alert for CPU usage exceeding 80%",
        "Add a MySQL slow query alert rule",
      ],
    },
    {
      id: "alert-rule-troubleshoot",
      name: "alert-rule-troubleshoot",
      description: "Diagnose why a specific alert rule failed to fire or notify.",
      tags: ["export", "troubleshooting"],
      examples: ["Why didn't alert rule 1024 trigger?"],
    },
    {
      id: "doc-qa",
      name: "doc-qa",
      description: "Answer factual questions about the example service.",
      tags: ["internal"],
    },
  ],
}

test("Token & Header resolution supports file (~/.config/...), {file:...}, {env:...}, custom headers, and AgentCard securitySchemes inference", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "opencode-a2a-auth-"))
  try {
    const secretDir = join(tmpDir, ".config", "opencode", "secrets")
    const tokenFile = join(secretDir, "example-token")
    // Create nested directories and secret file with trailing newline
    writeFileSync(
      join(tmpDir, "example-token"),
      "  example-secret-token-12345\n\n",
      "utf8",
    )

    const authOpts = {
      homedirPath: tmpDir,
      env: {
        EXAMPLE_ENV_TOKEN: "env-token-abc",
        BEARER_TOKEN: "my-jwt-token",
      },
    }

    // 1. Direct tokenFile with ~/ expansion + AgentCard X-User-Token auto-inference
    const headersFromFileAndCard = resolveAgentHeaders(
      {
        tokenFile: "~/example-token",
      },
      EXAMPLE_AGENT_CARD,
      authOpts,
    )
    assert.deepEqual(headersFromFileAndCard, {
      "X-User-Token": "example-secret-token-12345",
    })

    // 2. OpenCode-style `{file:~/...}` in custom headers map
    const headersFromInterpolation = resolveAgentHeaders(
      {
        headers: {
          "X-User-Token": "{file:~/example-token}",
          "X-Env-Header": "{env:EXAMPLE_ENV_TOKEN}",
        },
      },
      null,
      authOpts,
    )
    assert.deepEqual(headersFromInterpolation, {
      "X-User-Token": "example-secret-token-12345",
      "X-Env-Header": "env-token-abc",
    })

    // 3. Bearer token via tokenEnv (defaults to Authorization: Bearer <token> when no apiKey card scheme)
    const bearerHeaders = resolveAgentHeaders(
      {
        tokenEnv: "BEARER_TOKEN",
      },
      null,
      authOpts,
    )
    assert.deepEqual(bearerHeaders, {
      Authorization: "Bearer my-jwt-token",
    })

    // 4. Explicit custom header with custom scheme/prefix
    const customSchemeHeaders = resolveAgentHeaders(
      {
        token: "${EXAMPLE_ENV_TOKEN}",
        tokenHeader: "X-Custom-Auth",
        tokenScheme: "Token",
      },
      null,
      authOpts,
    )
    assert.deepEqual(customSchemeHeaders, {
      "X-Custom-Auth": "Token env-token-abc",
    })

    // 5. v0.3 flat securitySchemes inference
    const v03Security = inferSecurityFromCard({
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
        },
      },
    })
    assert.deepEqual(v03Security, {
      headerName: "X-API-Key",
      scheme: "",
    })

    assert.equal(interpolateConfigValue("$EXAMPLE_ENV_TOKEN", authOpts), "env-token-abc")
    assert.equal(interpolateConfigValue("file://~/example-token", authOpts), "example-secret-token-12345")
    void tokenFile
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test("URL discovery candidates and HTTP+JSON REST endpoint resolution handle root URLs, /a2a URLs, and AgentCard supportedInterfaces", () => {
  const candidatesFromRoot = buildAgentCardCandidateUrls({
    url: "https://agent.example.com",
  })
  assert.deepEqual(candidatesFromRoot, [
    "https://agent.example.com/.well-known/agent-card.json",
    "https://agent.example.com/.well-known/agent.json",
  ])

  const candidatesFromA2aPath = buildAgentCardCandidateUrls({
    url: "https://agent.example.com/a2a",
  })
  assert.equal(
    candidatesFromA2aPath[0],
    "https://agent.example.com/.well-known/agent-card.json",
  )

  const resolvedFromCard = resolveRestEndpoint(
    { url: "https://agent.example.com" },
    EXAMPLE_AGENT_CARD,
  )
  assert.deepEqual(resolvedFromCard, {
    endpoint: "https://agent.example.com/a2a",
    tenant: undefined,
    protocolVersion: "1.0",
  })

  const resolvedFallback = resolveRestEndpoint(
    { url: "https://agent.example.com/.well-known/agent-card.json" },
    null,
  )
  assert.equal(resolvedFallback.endpoint, "https://agent.example.com/a2a")
})

test("a2a-mcp-skillmap tool naming, description injection (description + tags + examples), and fallback skill synthesis", () => {
  const naming = new DefaultToolNamingStrategy({ style: "double_underscore" })
  assert.equal(naming.deriveName("example", "create-alert-rule"), "example__create-alert-rule")
  assert.equal(naming.isValid("example__create-alert-rule"), true)

  const prefixNaming = new DefaultToolNamingStrategy({ style: "a2a_prefix", prefix: "a2a" })
  assert.equal(
    prefixNaming.deriveName("example", "create-alert-rule"),
    "a2a_example_create_alert_rule",
  )

  // Long name deterministic hash truncation within 64 chars
  const veryLongSkill = "very-long-skill-name-that-exceeds-the-sixty-four-character-limit-by-far"
  const truncated = naming.deriveName("my-enterprise-observability-agent", veryLongSkill)
  assert.equal(truncated.length <= MAX_TOOL_NAME_LENGTH, true)
  assert.equal(naming.isValid(truncated), true)
  assert.equal(truncated, naming.deriveName("my-enterprise-observability-agent", veryLongSkill))

  // Namespace collision disambiguation
  const nsName1 = naming.deriveNameWithNamespace("https://a.example.com", "agent", "search")
  const nsName2 = naming.deriveNameWithNamespace("https://b.example.com", "agent", "search")
  assert.notEqual(nsName1, nsName2)
  assert.match(nsName1, /^ns[0-9a-f]{8}__agent__search$/)

  // Rich description injection
  const skill = EXAMPLE_AGENT_CARD.skills![0]!
  const desc = buildSkillToolDescription(
    { id: "example", name: "Example Agent", description: EXAMPLE_AGENT_CARD.description },
    skill,
  )
  assert.match(desc, /Example Agent \(example\)/)
  assert.match(desc, /Skill: create-alert-rule/)
  assert.match(desc, /Create alert rules for Prometheus/)
  assert.match(desc, /Tags: export, alerting/)
  assert.match(desc, /Help me create an alert for CPU usage exceeding 80%/)
  assert.match(desc, /Add a MySQL slow query alert rule/)

  // Fallback skill synthesis when agent has 0 skills
  const withFallback = applyFallbackSkill(
    {
      id: "empty-agent",
      name: "Empty Agent",
      description: "A minimalist A2A agent",
      skills: [],
    },
    "message",
  )
  assert.equal(withFallback.length, 1)
  assert.equal(withFallback[0]!.id, FALLBACK_SKILL_ID)
  assert.equal(withFallback[0]!.tags?.includes(FALLBACK_SKILL_TAG), true)
  assert.match(withFallback[0]!.description ?? "", /Empty Agent — A minimalist A2A agent/)

  // Skill filtering by "export" tag
  const filtered = resolveAgentSkills(
    { exposeSkills: "export" },
    EXAMPLE_AGENT_CARD,
  )
  assert.equal(filtered.allSkills.length, 3)
  assert.deepEqual(
    filtered.exposedSkills.map((s) => s.id),
    ["create-alert-rule", "alert-rule-troubleshoot"],
  )
})

test("Full plugin lifecycle: multi-agent discovery, skill tool routing (message.metadata.skillId & request.metadata.skillId), SSE streaming, contextId multi-turn, and tasks/{id} get/cancel", async () => {
  const capturedRequests: Array<{
    url: string
    method: string
    headers: Record<string, string>
    body?: Record<string, unknown>
  }> = []

  const researchCard: A2AAgentCard = {
    name: "Research Agent",
    description: "Searches papers and summarizes articles.",
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: "https://research.example.com/a2a",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
    },
    skills: [
      {
        id: "search",
        name: "Web Search",
        description: "Search for papers and articles on a topic.",
        tags: ["research", "web"],
        examples: ["Search for A2A protocol specification"],
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Search query" },
            maxResults: { type: "integer", description: "Max results to return" },
          },
          required: ["message"],
        },
      },
    ],
  }

  let exampleTurnCounter = 0

  const mockFetch: A2AFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? "GET"
    const headersObj: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v
      })
    }
    const rawBody = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    capturedRequests.push({ url, method, headers: headersObj, body: rawBody })

    // 1. Agent Card discovery endpoints
    if (url === "https://agent.example.com/.well-known/agent-card.json") {
      return new Response(JSON.stringify(EXAMPLE_AGENT_CARD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (url === "https://research.example.com/.well-known/agent-card.json") {
      return new Response(JSON.stringify(researchCard), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }

    // 2. Example streaming endpoint: POST /a2a/message:stream
    if (url === "https://agent.example.com/a2a/message:stream" && method === "POST") {
      assert.equal(headersObj["x-user-token"], "example-token-xyz")
      assert.equal(headersObj["accept"], "text/event-stream")
      exampleTurnCounter += 1
      const req = rawBody as unknown as A2ASendMessageRequest
      const incomingContextId = req.message.contextId
      const realChatId = incomingContextId || "example-chat-001"
      const taskId = `task-example-${exampleTurnCounter}`

      return createSseResponse([
        {
          data: {
            task: {
              id: taskId,
              contextId: `sdk-ctx-${exampleTurnCounter}`,
              status: { state: "TASK_STATE_SUBMITTED" },
              metadata: {
                "example.context_id": realChatId,
                "example.sequence": exampleTurnCounter,
              },
            },
          },
        },
        {
          data: {
            statusUpdate: {
              taskId,
              contextId: `sdk-ctx-${exampleTurnCounter}`,
              status: {
                state: "TASK_STATE_WORKING",
                message: {
                  messageId: "step-1",
                  role: "ROLE_AGENT",
                  parts: [{ text: "Querying Prometheus datasource..." }],
                },
              },
            },
          },
        },
        {
          data: {
            artifactUpdate: {
              taskId,
              contextId: `sdk-ctx-${exampleTurnCounter}`,
              artifact: {
                artifactId: "art-thought-1",
                parts: [{ text: "Checking CPU metrics first.", metadata: { adk_thought: true } }],
              },
            },
          },
        },
        // Trace artifact should be suppressed by isTraceArtifact
        {
          data: {
            artifactUpdate: {
              taskId,
              contextId: `sdk-ctx-${exampleTurnCounter}`,
              artifact: {
                artifactId: "art-trace-1",
                extensions: ["urn:x-a2a:trace:v1"],
                parts: [{ text: "INTERNAL_TRACE_SHOULD_NOT_APPEAR" }],
              },
            },
          },
        },
        {
          data: {
            artifactUpdate: {
              taskId,
              contextId: `sdk-ctx-${exampleTurnCounter}`,
              artifact: {
                artifactId: "art-ans-1",
                parts: [{ text: `Turn ${exampleTurnCounter} answer (chat=${realChatId}): ` }],
              },
            },
          },
        },
        {
          data: {
            artifactUpdate: {
              taskId,
              contextId: `sdk-ctx-${exampleTurnCounter}`,
              append: true,
              artifact: {
                artifactId: "art-ans-1",
                parts: [{ text: `skill=${String(req.message.metadata?.skillId ?? "none")}` }],
              },
            },
          },
        },
        {
          data: {
            statusUpdate: {
              taskId,
              contextId: `sdk-ctx-${exampleTurnCounter}`,
              status: {
                state: "TASK_STATE_COMPLETED",
              },
            },
          },
        },
      ])
    }

    // 3. Example task get & cancel endpoints
    if (url.startsWith("https://agent.example.com/a2a/tasks/task-example-1:cancel") && method === "POST") {
      return new Response(
        JSON.stringify({
          id: "task-example-1",
          contextId: "example-chat-001",
          status: {
            state: "TASK_STATE_CANCELED",
            message: {
              messageId: "m-cancel",
              role: "ROLE_AGENT",
              parts: [{ text: "Task canceled by user." }],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    if (url.startsWith("https://agent.example.com/a2a/tasks/task-example-1") && method === "GET") {
      return new Response(
        JSON.stringify({
          id: "task-example-1",
          contextId: "example-chat-001",
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [
            {
              artifactId: "art-ans-1",
              parts: [{ text: "Recovered task result from TaskStore" }],
            },
          ],
          metadata: { "example.context_id": "example-chat-001" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    // 4. Research synchronous endpoint: POST /a2a/message:send
    if (url === "https://research.example.com/a2a/message:send" && method === "POST") {
      assert.equal(headersObj["authorization"], "Bearer research-bearer-secret")
      const req = rawBody as unknown as A2ASendMessageRequest
      const text = (req.message.parts[0] as A2APart)?.text ?? ""
      return new Response(
        JSON.stringify({
          task: {
            id: "task-res-1",
            contextId: req.message.contextId || "ctx-research-99",
            status: { state: "TASK_STATE_COMPLETED" },
            artifacts: [
              {
                artifactId: "res-art-1",
                parts: [
                  {
                    text: `[research/${String(req.metadata?.skillId)}] Found results for: ${text} (maxResults=${String((req.metadata?.args as Record<string, unknown> | undefined)?.maxResults ?? "default")})`,
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    return new Response("Not Found", { status: 404 })
  }

  const host = createMockPluginHost({
    fetch: mockFetch,
    agents: {
      example: {
        url: "https://agent.example.com",
        token: "example-token-xyz",
        responseMetadata: { contextIdKey: "example.context_id" },
        defaultMetadata: { lang: "zh_CN" },
      },
      research: {
        url: "https://research.example.com",
        auth: {
          type: "bearer",
          token: "research-bearer-secret",
        },
      },
    },
  })

  const cleanup = await plugin.setup(host.ctx as never)

  // Verify discovered skill tools and unified agent tools are registered
  assert.equal(host.tools.has("a2a_example"), true)
  assert.equal(host.tools.has("a2a_example_task"), true)
  assert.equal(host.tools.has("example__create-alert-rule"), true)
  assert.equal(host.tools.has("example__alert-rule-troubleshoot"), true)
  assert.equal(host.tools.has("example__doc-qa"), true)
  assert.equal(host.tools.has("a2a_research"), true)
  assert.equal(host.tools.has("research__search"), true)

  // Verify skill tool description contains injected description, tags, and examples
  const createRuleTool = host.tools.get("example__create-alert-rule")!
  assert.match(createRuleTool.description, /Create alert rules for Prometheus/)
  assert.match(createRuleTool.description, /Tags: export, alerting/)
  assert.match(createRuleTool.description, /Help me create an alert for CPU usage exceeding 80%/)

  // Turn 1 on Example via skill tool `example__create-alert-rule`
  const progressUpdates: Array<Record<string, unknown>> = []
  const turn1 = await createRuleTool.execute(
    {
      message: "帮我创建一条 CPU > 80% 的告警规则",
    },
    {
      sessionID: "opencode_ses_1",
      signal: new AbortController().signal,
      progress: async (u) => {
        progressUpdates.push(u)
      },
    },
  )

  // Check that message.metadata.skillId AND request.metadata.skillId were sent
  const exampleStreamReq1 = capturedRequests.find(
    (r) => r.url === "https://agent.example.com/a2a/message:stream",
  )!
  assert.ok(exampleStreamReq1)
  const sentBody1 = exampleStreamReq1.body as unknown as A2ASendMessageRequest
  assert.equal(sentBody1.metadata?.skillId, "create-alert-rule")
  assert.equal(sentBody1.metadata?.skill, "create-alert-rule")
  assert.equal(sentBody1.metadata?.lang, "zh_CN")
  assert.equal(sentBody1.message.metadata?.skillId, "create-alert-rule")
  assert.equal(sentBody1.message.metadata?.skill, "create-alert-rule")
  assert.equal(sentBody1.message.contextId, undefined)

  // Check streaming output & suppressed trace artifact & hidden thoughts (by default)
  assert.match(turn1.content, /Turn 1 answer \(chat=example-chat-001\): skill=create-alert-rule/)
  assert.match(turn1.content, /Querying Prometheus datasource\.\.\./)
  assert.equal(turn1.content.includes("INTERNAL_TRACE_SHOULD_NOT_APPEAR"), false)
  assert.equal(turn1.content.includes("Checking CPU metrics first."), false)
  assert.equal(turn1.metadata?.contextId, "example-chat-001")
  assert.equal(turn1.metadata?.sessionId, "example-chat-001")
  assert.equal(turn1.metadata?.taskId, "task-example-1")
  assert.equal(progressUpdates.length > 0, true)

  // Turn 2 in the SAME OpenCode session (`opencode_ses_1`) automatically reuses `example-chat-001`!
  const troubleshootTool = host.tools.get("example__alert-rule-troubleshoot")!
  const turn2 = await troubleshootTool.execute(
    {
      message: "再检查一下为什么这条规则没触发",
    },
    {
      sessionID: "opencode_ses_1",
      signal: new AbortController().signal,
      progress: async () => {},
    },
  )

  const exampleStreamReqs = capturedRequests.filter(
    (r) => r.url === "https://agent.example.com/a2a/message:stream",
  )
  assert.equal(exampleStreamReqs.length, 2)
  const sentBody2 = exampleStreamReqs[1]!.body as unknown as A2ASendMessageRequest
  assert.equal(sentBody2.message.contextId, "example-chat-001")
  assert.equal(sentBody2.metadata?.skillId, "alert-rule-troubleshoot")
  assert.equal(sentBody2.message.metadata?.skillId, "alert-rule-troubleshoot")
  assert.match(turn2.content, /Turn 2 answer \(chat=example-chat-001\): skill=alert-rule-troubleshoot/)

  // Test task retrieval and cancellation through the generic task tool.
  const exampleTaskTool = host.tools.get("a2a_example_task")!
  const gotTask = await exampleTaskTool.execute(
    { action: "get", taskId: "task-example-1", historyLength: 5 },
    {
      sessionID: "opencode_ses_1",
      signal: new AbortController().signal,
      progress: async () => {},
    },
  )
  assert.match(gotTask.content, /Recovered task result from TaskStore/)
  assert.ok(
    capturedRequests.some(
      (r) => r.url === "https://agent.example.com/a2a/tasks/task-example-1?historyLength=5" && r.method === "GET",
    ),
  )

  const canceledTask = await exampleTaskTool.execute(
    { action: "cancel", taskId: "task-example-1", metadata: { reason: "user_abort" } },
    {
      sessionID: "opencode_ses_1",
      signal: new AbortController().signal,
      progress: async () => {},
    },
  )
  assert.equal(canceledTask.metadata?.state, "TASK_STATE_CANCELED")
  assert.match(canceledTask.content, /Task canceled by user\./)

  // Test Research agent skill tool with custom `inputSchema` (`maxResults`) over `POST /a2a/message:send`
  const researchSearchTool = host.tools.get("research__search")!
  const researchRes = await researchSearchTool.execute(
    {
      message: "Google A2A HTTP+JSON binding",
      maxResults: 3,
    },
    {
      sessionID: "opencode_ses_1",
      signal: new AbortController().signal,
      progress: async () => {},
    },
  )
  assert.match(
    researchRes.content,
    /\[research\/search\] Found results for: Google A2A HTTP\+JSON binding \(maxResults=3\)/,
  )
  assert.equal(researchRes.metadata?.contextId, "ctx-research-99")

  if (typeof cleanup === "function") {
    await cleanup()
  }
  assert.equal(host.isDisposed(), true)
})

test("Handles TASK_STATE_INPUT_REQUIRED and opt-in structured metadata payloads", async () => {
  const mockFetch: A2AFetch = async () =>
    createSseResponse([
      {
        data: {
          task: {
            id: "task-ir-1",
            contextId: "chat-ir-1",
            status: { state: "TASK_STATE_SUBMITTED" },
          },
        },
      },
      {
        data: {
          artifactUpdate: {
            taskId: "task-ir-1",
            contextId: "chat-ir-1",
            artifact: {
              artifactId: "art-form",
              parts: [
                {
                  text: JSON.stringify({
                    fields: [{ key: "group_id", label: "Group" }],
                  }),
                  metadata: { example_content_type: "form_select" },
                },
              ],
            },
          },
        },
      },
      {
        data: {
          statusUpdate: {
            taskId: "task-ir-1",
            contextId: "chat-ir-1",
            status: {
              state: "TASK_STATE_INPUT_REQUIRED",
              message: {
                messageId: "msg-ir",
                role: "ROLE_AGENT",
                parts: [{ text: "Please select a group (group_id)." }],
              },
            },
          },
        },
      },
    ])

  const client = new A2ARestClient({
    agentId: "example",
    config: {
      endpoint: "https://agent.example.com/a2a",
      responseMetadata: { contentTypeKey: "example_content_type" },
      discover: false,
      streaming: true,
    },
    fetch: mockFetch,
  })

  const result = await client.executeTurn({
    text: "创建 Linux 监控仪表盘",
    skillId: "create-dashboard",
  })

  assert.equal(result.inputRequired, true)
  assert.equal(result.state, "TASK_STATE_INPUT_REQUIRED")
  assert.equal(result.contextId, "chat-ir-1")
  assert.equal(result.structuredPayloads.length, 1)
  assert.equal(result.structuredPayloads[0]!.contentType, "form_select")
})

test("A2AContextStore maintains per-session multi-turn contextId with LRU eviction", () => {
  const store = new A2AContextStore(10)
  for (let i = 1; i <= 12; i++) {
    store.set(`ses_${i}`, "example", { contextId: `ctx_${i}`, taskId: `task_${i}` })
  }
  assert.equal(store.size(), 10)
  assert.equal(store.get("ses_1", "example"), undefined)
  assert.equal(store.get("ses_12", "example")?.contextId, "ctx_12")

  store.delete("ses_12", "example")
  assert.equal(store.get("ses_12", "example"), undefined)
})

test("SSE parser and payload normalizer handle CRLF, multi-line data, comments, and v0.3/v1.0 shapes", async () => {
  const rawSse = [
    ": keep-alive comment",
    "event: message",
    'data: {"task":{"id":"t1",',
    'data: "contextId":"c1","status":{"state":"TASK_STATE_WORKING"}}}',
    "",
    'data: {"kind":"message","messageId":"m1","role":"agent","parts":[{"kind":"text","text":"hello v0.3"}]}',
    "",
  ].join("\r\n")

  const response = new Response(rawSse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })

  const frames: Array<{ type: string; data: string }> = []
  for await (const frame of parseSseResponse(response)) {
    frames.push(frame)
  }

  assert.equal(frames.length, 2)
  const ev1 = normalizeA2AEventPayload(JSON.parse(frames[0]!.data))
  assert.equal(ev1.task?.id, "t1")

  const ev2 = normalizeA2AEventPayload(JSON.parse(frames[1]!.data))
  assert.equal(ev2.message?.messageId, "m1")

  const schema = buildSkillToolInputSchema({
    id: "custom",
    name: "Custom",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string" },
      },
      required: ["env"],
    },
  })
  assert.deepEqual(schema.required, ["env"])
})

test("Zero-skill AgentCard synthesizes <agent>__message fallback tool without injecting skillId, and supports namingStyle='both' & fallback /.well-known/agent.json", async () => {
  const sentBodies: A2ASendMessageRequest[] = []
  let cardRequests: string[] = []

  const mockFetch: A2AFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith("/.well-known/agent-card.json")) {
      cardRequests.push(url)
      return new Response("Not Found", { status: 404 })
    }
    if (url.endsWith("/.well-known/agent.json")) {
      cardRequests.push(url)
      return new Response(
        JSON.stringify({
          name: "Minimal Agent",
          description: "Agent with zero skills served at legacy agent.json",
          version: "1.0.0",
          url: "https://minimal.example.com/a2a",
          skills: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    if (url === "https://minimal.example.com/a2a/message:send") {
      const body = JSON.parse(String(init?.body)) as A2ASendMessageRequest
      sentBodies.push(body)
      return new Response(
        JSON.stringify({
          message: {
            messageId: "m-reply-1",
            role: "ROLE_AGENT",
            contextId: "ctx-min-1",
            parts: [{ text: "Minimal reply" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }
    return new Response("Not Found", { status: 404 })
  }

  const host = createMockPluginHost({
    fetch: mockFetch,
    namingStyle: "both",
    agents: [
      {
        id: "minimal",
        url: "https://minimal.example.com",
      },
    ],
  })

  await plugin.setup(host.ctx as never)

  // Legacy /.well-known/agent.json was probed after /.well-known/agent-card.json returned 404
  assert.deepEqual(cardRequests, [
    "https://minimal.example.com/.well-known/agent-card.json",
    "https://minimal.example.com/.well-known/agent.json",
  ])

  // Both double_underscore and a2a_prefix fallback skill tools are registered
  assert.equal(host.tools.has("minimal__message"), true)
  assert.equal(host.tools.has("a2a_minimal_message"), true)

  const fallbackTool = host.tools.get("minimal__message")!
  const res = await fallbackTool.execute(
    { message: "Hello minimal agent" },
    {
      sessionID: "ses_min",
      signal: new AbortController().signal,
      progress: async () => {},
    },
  )

  assert.match(res.content, /Minimal reply/)
  assert.equal(sentBodies.length, 1)
  // Fallback skill must NOT inject skillId: "message"
  assert.equal(sentBodies[0]!.metadata?.skillId, undefined)
  assert.equal(sentBodies[0]!.message.metadata?.skillId, undefined)
})

test("AbortSignal during SSE stream automatically triggers POST /tasks/{id}:cancel when autoCancelOnAbort is enabled", async () => {
  const cancelCalls: string[] = []
  const abortController = new AbortController()

  const mockFetch: A2AFetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.endsWith(":cancel")) {
      cancelCalls.push(url)
      return new Response(
        JSON.stringify({
          id: "task-stream-abort-1",
          contextId: "ctx-abort-1",
          status: { state: "TASK_STATE_CANCELED" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const firstEvent = JSON.stringify({
          task: {
            id: "task-stream-abort-1",
            contextId: "ctx-abort-1",
            status: { state: "TASK_STATE_WORKING" },
          },
        })
        controller.enqueue(encoder.encode(`data: ${firstEvent}\n\n`))
        // Trigger caller abort right after task ID is known
        setTimeout(() => {
          abortController.abort(new Error("user cancelled tool"))
          controller.error(new Error("stream aborted"))
        }, 10)
      },
    })

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })
  }

  const client = new A2ARestClient({
    agentId: "example",
    config: {
      endpoint: "https://agent.example.com/a2a",
      discover: false,
      streaming: true,
      autoCancelOnAbort: true,
    },
    fetch: mockFetch,
  })

  await assert.rejects(
    () =>
      client.executeTurn({
        text: "Long query",
        signal: abortController.signal,
      }),
  )

  // Allow microtask for best-effort cancelTask to complete
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(cancelCalls, [
    "https://agent.example.com/a2a/tasks/task-stream-abort-1:cancel",
  ])
})
