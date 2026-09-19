import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate } from "../src/gate.ts";
import type { Decision, GuardInput, GuardResult } from "../src/schema.ts";

const given = (): GuardInput => ({
  userRequest: "Send hello to Ada",
  toolCall: { name: "send", arguments: { to: "ada@example.com", body: "hello" } },
  context: [],
  policies: { instructions: [], tools: {} },
});
const result = (decision: Decision): GuardResult => ({
  decision,
  reason: "test",
  usage: null,
  resolvedModel: "test",
});

for (const decision of ["allow", "block", "review"] as const) {
  test(`${decision} enforces execution and review boundaries`, async () => {
    let calls = 0;
    let approvals = 0;
    const gate = createGate({ client: { evaluate: async () => result(decision) } });
    const outcome = await gate.execute(given(), async () => ++calls, {
      onReview: async () => {
        approvals++;

        return true;
      },
    });

    assert.equal(calls, decision === "block" ? 0 : 1);
    assert.equal(approvals, decision === "review" ? 1 : 0);
    assert.equal(outcome.status, decision === "block" ? "blocked" : "executed");
  });
}

test("review never executes without explicit approval, including rejection and UI errors", async () => {
  const gate = createGate({ client: { evaluate: async () => result("review") } });

  for (const options of [
    {},
    { onReview: async () => false },
    {
      onReview: async () => {
        throw new Error("UI failed");
      },
    },
  ]) {
    const outcome = await gate.execute(given(), async () => assert.fail("executed"), options);

    assert.equal(outcome.status, "review");
  }
});

test("provider exceptions and deadlines cannot be overridden by approval", async () => {
  for (const evaluate of [
    async () => {
      throw new Error("SECRET");
    },
    () => new Promise<GuardResult>(() => {}),
  ]) {
    const gate = createGate({ client: { evaluate }, timeoutMs: 5 });
    const outcome = await gate.execute(given(), async () => assert.fail("executed"), {
      onReview: async () => assert.fail("approval requested"),
    });

    assert.equal(outcome.status, "error");
    assert.equal(JSON.stringify(outcome).includes("SECRET"), false);
  }
});

test("approval deadline returns without executing even if UI ignores cancellation", async () => {
  const gate = createGate({
    client: { evaluate: async () => result("review") },
    reviewTimeoutMs: 5,
  });
  const outcome = await gate.execute(given(), async () => assert.fail("executed"), {
    onReview: () => new Promise<boolean>(() => {}),
  });

  assert.equal(outcome.status, "review");
});

test("caller, evaluator and approval UI cannot substitute checked arguments", async () => {
  const input = given();
  const gate = createGate({
    client: {
      evaluate: async (snapshot) => {
        snapshot.toolCall.arguments.to = "attacker@example.com";

        return result("review");
      },
    },
  });
  const pending = gate.execute(input, async (args) => args.to, {
    onReview: async ({ given: snapshot }) => {
      assert.equal(snapshot.toolCall.arguments.to, "ada@example.com");
      assert.throws(() => {
        snapshot.toolCall.arguments.to = "attacker@example.com";
      });

      return true;
    },
  });

  input.toolCall.arguments.to = "changed@example.com";

  const outcome = await pending;

  assert.equal(outcome.status, "executed");

  if (outcome.status === "executed") assert.equal(outcome.output, "ada@example.com");
});

test("cancellation before and during review prevents execution", async () => {
  for (const early of [true, false]) {
    const controller = new AbortController();

    if (early) controller.abort();

    const gate = createGate({ client: { evaluate: async () => result("review") } });
    const outcome = await gate.execute(given(), async () => assert.fail("executed"), {
      signal: controller.signal,
      onReview: async () => {
        controller.abort();

        return true;
      },
    });

    assert.notEqual(outcome.status, "executed");
  }
});

test("tool failures propagate once, and separate concurrent calls keep their own context", async () => {
  let calls = 0;
  const gate = createGate({
    client: { evaluate: async (input) => result(input.userRequest === "deny" ? "block" : "allow") },
  });

  await assert.rejects(
    gate.execute(given(), async () => {
      calls++;
      throw new Error("tool failure");
    }),
    /tool failure/,
  );
  assert.equal(calls, 1);

  const results = await Promise.all(
    [given(), { ...given(), userRequest: "deny" }].map((input) =>
      gate.execute(input, async () => ++calls),
    ),
  );

  assert.deepEqual(
    results.map((r) => r.status),
    ["executed", "blocked"],
  );
  assert.equal(calls, 2);
});
