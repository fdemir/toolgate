import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, percentile, summarize } from "../src/metrics.ts";
import type { Measurement } from "../src/metrics.ts";
import type { Decision } from "@toolgate/core";
import { sample } from "./helpers.ts";

function row(expected: Decision, decision: Decision, error = false): Measurement {
  return {
    index: 0,
    scenarioId: "sample",
    family: "sample",
    category: "intent",
    repetition: 1,
    expected,
    actual: decision,
    matched: !error && expected === decision,
    given: sample().given,
    rationale: "Test label.",
    status: error ? "error" : "ok",
    error: error ? "timeout" : null,
    reason: "Test",
    latencyMs: 10,
    usage: null,
    estimatedCostUsd: null,
    resolvedModel: null,
  };
}

test("separates unsafe misses, false blocks, deferrals, review bypasses, and errors", () => {
  const s = summarize([
    row("block", "allow"),
    row("block", "block"),
    row("block", "review"),
    row("allow", "allow"),
    row("allow", "block"),
    row("allow", "review"),
    row("review", "allow"),
    row("review", "review"),
    row("review", "review", true),
  ]);

  assert.deepEqual(s.unsafeMissed, { count: 1, total: 3, rate: 1 / 3 });
  assert.deepEqual(s.legitimateBlocked, { count: 1, total: 3, rate: 1 / 3 });
  assert.equal(s.legitimateReviewed.count, 1);
  assert.equal(s.reviewRequiredAllowed.count, 1);
  assert.equal(s.reviewRate.count, 4);
  assert.equal(s.errorRate.count, 1);
  assert.equal(
    s.accuracy.count,
    3,
    "An error on a review-labeled case receives no accuracy credit.",
  );
  assert.equal(
    s.confusionMatrix.review.review,
    2,
    "Matrix includes the explicit fallback decision.",
  );
});

test("zero denominators and missing usage/cost remain unknown", () => {
  const s = summarize([row("allow", "allow")]);

  assert.equal(s.unsafeMissed.rate, null);
  assert.equal(s.tokens.coverage.count, 0);
  assert.equal(s.costUsd.total, null);
  assert.equal(summarize([]).accuracy.rate, null);
  assert.equal(summarize([]).costUsd.total, null);
});

test("uses nearest-rank p50/p95 and does not mutate input", () => {
  const values = [100, 1, 2, 3, 4];

  assert.equal(percentile(values, 0.5), 3);
  assert.equal(percentile(values, 0.95), 100);
  assert.equal(percentile([], 0.95), null);
  assert.deepEqual(values, [100, 1, 2, 3, 4]);
});

test("cached tokens require their own price and are not double-counted", () => {
  const usage = { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 200 };
  const price = { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 };

  assert.ok(Math.abs(estimateCost(usage, price)! - 0.0025) < 1e-12);
  assert.equal(estimateCost(usage, { inputPerMillion: 2, outputPerMillion: 8 }), null);
  assert.equal(estimateCost(null, price), null);
  assert.equal(estimateCost(usage, null), null);
});

test("partial coverage preserves known subtotal without inventing a total", () => {
  const known = {
    ...row("allow", "allow"),
    estimatedCostUsd: 0.002,
    usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 },
  };
  const s = summarize([known, row("block", "review", true)]);

  assert.equal(s.costUsd.total, null);
  assert.equal(s.costUsd.knownSubtotal, 0.002);
  assert.equal(s.costUsd.coverage.rate, 0.5);
  assert.equal(s.tokens.knownInput, 10);
  assert.equal(s.tokens.coverage.rate, 0.5);
});
