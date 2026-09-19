import { test } from "node:test";
import assert from "node:assert/strict";
import { runScenario, scenarios } from "../src/scenarios.ts";

for (const scenario of scenarios) {
  test(`AI SDK demo ${scenario.id} enforces ${scenario.expected}`, async () => {
    const outcome = await runScenario(scenario, {
      evaluate: async () => ({
        decision: scenario.expected,
        reason: "fixture",
        usage: null,
        resolvedModel: null,
      }),
    });

    assert.equal(outcome.sent.length, scenario.expected === "allow" ? 1 : 0);
    assert.equal(
      outcome.content.some((part) => part.type === "tool-error"),
      scenario.expected !== "allow",
    );
  });
}

test("demo executes review only after affirmative application approval", async () => {
  const outcome = await runScenario(
    scenarios[2]!,
    {
      evaluate: async () => ({
        decision: "review",
        reason: "fixture",
        usage: null,
        resolvedModel: null,
      }),
    },
    async () => true,
  );

  assert.equal(outcome.sent.length, 1);
});
