import { EvaluationError, inputSchema, resultSchema } from "./schema.ts";
import type { GuardInput, GuardResult, JevClient } from "./schema.ts";

export interface CheckResult extends GuardResult {
  status: "ok" | "error";
  error: string | null;
  latencyMs: number;
}

export interface ReviewRequest {
  given: GuardInput;
  check: CheckResult;
  signal: AbortSignal;
}

/** Runs in trusted application code, never supplied by the agent or a tool argument. */
export type ReviewHandler = (request: ReviewRequest) => Promise<boolean>;

export interface ExecutionOptions {
  signal?: AbortSignal;
  onReview?: ReviewHandler;
}

export type ExecutionResult<T> =
  | { status: "executed"; output: T; check: CheckResult; approved: boolean }
  | { status: "blocked" | "review" | "error"; check: CheckResult };

export interface GateOptions {
  client: Pick<JevClient, "evaluate">;
  timeoutMs?: number;
  reviewTimeoutMs?: number;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);

    for (const child of Object.values(value)) freeze(child);
  }

  return value;
}

async function bounded<T>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};

  try {
    const deadline = new Promise<never>((_, reject) => {
      cancel = () => {
        controller.abort();
        reject(new EvaluationError("cancelled"));
      };

      if (parent?.aborted) {
        cancel();

        return;
      }

      parent?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new EvaluationError("timeout"));
      }, timeoutMs);
    });

    return await Promise.race([
      deadline,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();

        return action(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  }
}

function failed(started: number, error: string): CheckResult {
  return {
    status: "error",
    error,
    decision: "review",
    reason: "Guard unavailable; execution stopped.",
    usage: null,
    resolvedModel: null,
    latencyMs: performance.now() - started,
  };
}

export function createGate({ client, timeoutMs = 15_000, reviewTimeoutMs = 60_000 }: GateOptions) {
  for (const ms of [timeoutMs, reviewTimeoutMs]) {
    if (!Number.isInteger(ms) || ms < 1 || ms > 300_000) {
      throw new Error("Timeout must be an integer between 1 and 300000 ms.");
    }
  }

  async function check(
    input: GuardInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CheckResult> {
    const started = performance.now();

    try {
      const given = inputSchema.parse(input);
      const result = resultSchema.parse(
        await bounded(
          (signal) => client.evaluate(structuredClone(given), signal),
          timeoutMs,
          options.signal,
        ),
      );

      if (options.signal?.aborted) return failed(started, "cancelled");

      return { ...result, status: "ok", error: null, latencyMs: performance.now() - started };
    } catch (error) {
      const result = failed(
        started,
        error instanceof EvaluationError ? error.code : "evaluation_error",
      );

      if (error instanceof EvaluationError) {
        result.usage = error.usage;
        result.resolvedModel = error.resolvedModel;
      }

      return result;
    }
  }

  async function execute<T>(
    input: GuardInput,
    action: (args: GuardInput["toolCall"]["arguments"]) => Promise<T>,
    options: ExecutionOptions = {},
  ): Promise<ExecutionResult<T>> {
    // Parse once into an owned snapshot; evaluator and approval UI get separate copies.
    const parsed = inputSchema.safeParse(input);

    if (!parsed.success)
      return { status: "error", check: failed(performance.now(), "invalid_input") };

    const given = parsed.data;
    const result = await check(given, options);

    if (result.status === "error") return { status: "error", check: result };

    if (result.decision === "block") return { status: "blocked", check: result };

    let approved = false;

    if (result.decision === "review") {
      if (!options.onReview) return { status: "review", check: result };

      try {
        approved =
          (await bounded(
            (signal) =>
              options.onReview!({
                given: freeze(structuredClone(given)),
                check: freeze(structuredClone(result)),
                signal,
              }),
            reviewTimeoutMs,
            options.signal,
          )) === true;
      } catch {
        return { status: "review", check: result };
      }

      if (!approved) return { status: "review", check: result };
    }

    if (options.signal?.aborted)
      return { status: "error", check: failed(performance.now(), "cancelled") };

    // Tool exceptions propagate. Never retry an action that may already have side effects.
    const output = await action(structuredClone(given.toolCall.arguments));

    return { status: "executed", output, check: result, approved };
  }

  return { check, execute };
}

export type Gate = ReturnType<typeof createGate>;
