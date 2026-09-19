import { performance } from "node:perf_hooks";
import { z } from "zod";
import { EvaluationError, resultSchema } from "@toolgate/core";
import type { JevClient, GuardResult, Scenario } from "@toolgate/core";
import { estimateCost, summarize } from "./metrics.ts";
import type { Measurement } from "./metrics.ts";

export const runOptionsSchema = z.strictObject({
  repetitions: z.number().int().min(1).max(100),
  concurrency: z.number().int().min(1).max(64),
  timeoutMs: z.number().int().min(1).max(300_000),
  seed: z.number().int().min(0).max(4_294_967_295),
});

export type RunOptions = z.infer<typeof runOptionsSchema>;

export function shuffled<T>(values: T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;

    return state / 4_294_967_296;
  };

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));

    [result[i], result[j]] = [result[j]!, result[i]!];
  }

  return result;
}

async function evaluate(client: JevClient, scenario: Scenario, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Only given reaches the model; labels and evaluation metadata stay local.
  const given = structuredClone(scenario.given);
  const started = performance.now();
  let result: GuardResult;
  let error: string | null = null;

  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new EvaluationError("timeout"));
      }, timeoutMs);
    });

    result = resultSchema.parse(
      await Promise.race([
        Promise.resolve().then(() => client.evaluate(given, controller.signal)),
        deadline,
      ]),
    );
  } catch (cause) {
    error = cause instanceof EvaluationError ? cause.code : "evaluation_error";
    result = {
      decision: "review",
      reason: "Evaluation failed; human review required.",
      usage: cause instanceof EvaluationError ? cause.usage : null,
      resolvedModel: cause instanceof EvaluationError ? cause.resolvedModel : null,
    };
  } finally {
    clearTimeout(timer);
  }

  return {
    actual: result.decision,
    reason: result.reason,
    usage: result.usage,
    resolvedModel: result.resolvedModel,
    status: error ? ("error" as const) : ("ok" as const),
    error,
    latencyMs: performance.now() - started,
    estimatedCostUsd: estimateCost(result.usage, client.pricing),
  };
}

export async function runEvaluation(
  scenarios: Scenario[],
  client: JevClient,
  options: RunOptions,
  onResult?: (row: Measurement, total: number) => Promise<void>,
) {
  runOptionsSchema.parse(options);

  if (!scenarios.length) throw new Error("Select at least one scenario.");

  const jobs: { scenario: Scenario; repetition: number }[] = [];

  for (let repetition = 1; repetition <= options.repetitions; repetition++) {
    for (const scenario of shuffled(scenarios, options.seed + repetition - 1))
      jobs.push({ scenario, repetition });
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const rows: Measurement[] = [];
  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      const { scenario, repetition } = jobs[index]!;
      const result = await evaluate(client, scenario, options.timeoutMs);
      const row: Measurement = {
        index,
        scenarioId: scenario.id,
        family: scenario.family,
        category: scenario.category,
        given: structuredClone(scenario.given),
        expected: scenario.expected,
        rationale: scenario.rationale,
        repetition,
        ...result,
        matched: result.status === "ok" && result.actual === scenario.expected,
      };

      rows[index] = row;
      await onResult?.(row, jobs.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));

  return {
    schemaVersion: 2,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    options,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    configuration: client.configuration,
    pricing: client.pricing,
    summary: summarize(rows),
    byCategory: Object.fromEntries(
      [...new Set(scenarios.map((s) => s.category))]
        .sort()
        .map((category) => [category, summarize(rows.filter((row) => row.category === category))]),
    ),
    rows,
  };
}

export type EvaluationResult = Awaited<ReturnType<typeof runEvaluation>>;
