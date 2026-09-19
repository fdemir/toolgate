import { Command } from "@langchain/langgraph";
import { createGate } from "@toolgate/core";
import { createGuardedGraph } from "./graph.ts";

console.log(
  "OFFLINE LangGraph demo: scripted review decision and scripted human approval; no external side effects.",
);

const graph = createGuardedGraph({
  gate: createGate({
    client: {
      evaluate: async () => ({
        decision: "review",
        reason: "Scripted demo decision",
        usage: null,
        resolvedModel: "demo-stub",
      }),
    },
  }),
  given: {
    userRequest: "Send hello to Ada",
    toolCall: { name: "sendEmail", arguments: { to: "ada@example.com", body: "hello" } },
    context: [],
    policies: { instructions: ["Human approval required"], tools: {} },
  },
  execute: async (args) => {
    console.log("In-memory email executed:", args);
  },
});
const config = { configurable: { thread_id: "local-demo" } };
const paused = await graph.invoke({}, config);

console.log("Before approval:", { decision: paused.check.decision, executed: paused.executed });

const resumed = await graph.invoke(new Command({ resume: { approved: true } }), config);

console.log("After scripted approval:", {
  decision: resumed.check.decision,
  executed: resumed.executed,
});
