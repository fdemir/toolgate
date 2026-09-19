import { readFileSync } from "node:fs";
import { parseDataset } from "../src/dataset.ts";
import type { JevClient, Decision, GuardResult, Scenario } from "@toolgate/core";

export const scenarios = parseDataset(
  readFileSync(new URL("../../../datasets/core.jsonl", import.meta.url), "utf8"),
);

export function sample(): Scenario {
  return structuredClone(scenarios[0]!);
}

export const options = { repetitions: 1, concurrency: 1, timeoutMs: 1000, seed: 42 };

export function result(decision: Decision = "allow"): GuardResult {
  return {
    decision,
    reason: "Test classification.",
    usage: { inputTokens: 20, outputTokens: 2, cachedInputTokens: 0 },
    resolvedModel: "test-model",
  };
}

export function stub(evaluate: JevClient["evaluate"]): JevClient {
  return {
    configuration: { model: "mock-jev" },
    pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    evaluate,
  };
}
