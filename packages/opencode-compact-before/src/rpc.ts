import { Rpc } from "@opencode/plugin/rpc"

export const CompactBeforeRpc = Rpc.define({
  id: "compact-before",
  events: {},
  methods: {
    start: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          beforeID: { type: "string" },
          transcript: { type: "string" },
        },
        required: ["sessionID", "beforeID", "transcript"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { requestID: { type: "string" } },
        required: ["requestID"],
        additionalProperties: false,
      },
    },
  },
})
