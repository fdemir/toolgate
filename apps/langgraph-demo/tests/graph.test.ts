import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "@langchain/langgraph";
import { createGate } from "@toolgate/core";
import type { Decision } from "@toolgate/core";
import { createGuardedGraph } from "../src/graph.ts";

for (const decision of ["allow", "block", "review"] satisfies Decision[]) {
  for (const approved of [false, true]) {
    test(`${decision}, approval=${approved}: graph enforces action and resumes without reevaluating`, async () => {
      let checks = 0;
      let executions = 0;
      const graph = createGuardedGraph({
        gate: createGate({
          client: {
            evaluate: async () => {
              checks++;

              return { decision, reason: "fixture", usage: null, resolvedModel: null };
            },
          },
        }),
        given: {
          userRequest: "Send hello",
          toolCall: { name: "send", arguments: { body: "hello" } },
          context: [],
          policies: { instructions: [], tools: {} },
        },
        execute: async () => {
          executions++;
        },
      });
      const config = { configurable: { thread_id: `${decision}-${approved}` } };

      await graph.invoke({}, config);
      assert.equal(executions, decision === "allow" ? 1 : 0);

      if (decision === "review") await graph.invoke(new Command({ resume: { approved } }), config);

      assert.equal(executions, decision === "allow" || (decision === "review" && approved) ? 1 : 0);
      assert.equal(checks, 1);
    });
  }
}
