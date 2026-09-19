import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { EvaluationError } from "@toolgate/core";
import { runEvaluation, shuffled } from "../src/runner.ts";
import { stub, options, result, sample, scenarios } from "./helpers.ts";

test("Jev receives only given; mutation cannot change later repetitions or report evidence", async () => {
  const first = sample();
  const original = structuredClone(first);
  const client = stub(async (given) => {
    assert.deepEqual(Object.keys(given).sort(), ["context", "policies", "toolCall", "userRequest"]);
    assert.deepEqual(given, original.given);
    given.userRequest = "MUTATED";
    given.toolCall.arguments.sku = "MUTATED";

    return result("block");
  });
  const report = await runEvaluation([first], client, { ...options, repetitions: 2 });

  assert.deepEqual(first, original);

  for (const row of report.rows) {
    assert.deepEqual(row.given, original.given);
    assert.equal(row.expected, "block");
    assert.equal(row.actual, "block");
    assert.equal(row.matched, true);
  }
});

test("seeded schedule evaluates every scenario and repetition exactly once", async () => {
  const client = stub(async () => result());
  const opts = { ...options, repetitions: 3, concurrency: 2 };
  const a = await runEvaluation(scenarios.slice(0, 5), client, opts);
  const b = await runEvaluation(scenarios.slice(0, 5), client, opts);
  const signature = (r: typeof a) => r.rows.map((row) => [row.scenarioId, row.repetition]);

  assert.deepEqual(signature(a), signature(b));
  assert.equal(a.rows.length, 15);
  assert.equal(new Set(a.rows.map((row) => `${row.scenarioId}/${row.repetition}`)).size, 15);
  assert.notDeepEqual(shuffled(scenarios, 41), shuffled(scenarios, 42));
});

test("concurrency is bounded", async () => {
  let active = 0;
  let peak = 0;
  const client = stub(async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(5);
    active--;

    return result();
  });

  await runEvaluation(scenarios.slice(0, 6), client, { ...options, concurrency: 2 });
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test("deadline aborts the request, records a failed case, and continues", async () => {
  let aborted = false;
  let calls = 0;
  const client = stub(async (_given, signal) => {
    if (++calls > 1) return result();

    signal.addEventListener("abort", () => {
      aborted = true;
    });

    return new Promise(() => {});
  });
  const report = await runEvaluation([sample()], client, {
    ...options,
    repetitions: 2,
    timeoutMs: 15,
  });

  assert.equal(aborted, true);
  assert.equal(report.rows[0]!.actual, "review");
  assert.equal(report.rows[0]!.matched, false);
  assert.equal(report.rows[0]!.error, "timeout");
  assert.equal(report.rows[0]!.estimatedCostUsd, null);
  assert.equal(report.rows[1]!.status, "ok");
});

test("provider errors preserve usage; unknown exception messages are not saved", async () => {
  let calls = 0;
  const client = stub(async () => {
    if (++calls === 1) throw new EvaluationError("invalid_response", result().usage, "resolved");

    throw new Error("Bearer SECRET_PAYLOAD");
  });
  const report = await runEvaluation([sample()], client, { ...options, repetitions: 2 });

  assert.equal(report.rows[0]!.usage?.inputTokens, 20);
  assert.equal(report.rows[0]!.resolvedModel, "resolved");
  assert.ok(report.rows[0]!.estimatedCostUsd! > 0);
  assert.equal(report.rows[1]!.error, "evaluation_error");
  assert.equal(JSON.stringify(report).includes("SECRET_PAYLOAD"), false);
});

test("invalid outputs fail; review-label errors never count as matches", async () => {
  const broken = stub(async () => JSON.parse('{"decision":"allow"}'));
  const scenario = sample();

  scenario.expected = "review";

  const report = await runEvaluation([scenario], broken, options);

  assert.equal(report.rows[0]!.actual, "review");
  assert.equal(report.rows[0]!.matched, false);
  assert.equal(report.summary.accuracy.count, 0);
  assert.equal(report.rows[0]!.status, "error");
  await assert.rejects(runEvaluation([], broken, options), /at least one/);
  await assert.rejects(runEvaluation([sample()], broken, { ...options, concurrency: 0 }));
});
