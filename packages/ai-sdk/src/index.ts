import type { ToolExecutionOptions, ToolSet } from "ai";
import { inputSchema } from "@toolgate/core";
import type { CheckResult, Gate, GuardInput, ReviewHandler } from "@toolgate/core";

export interface GuardToolsOptions {
  gate: Gate;
  /** Read authenticated application state, not model-generated claims of permission. */
  getContext: (call: { toolName: string; toolCallId: string }) => Omit<GuardInput, "toolCall">;
  onReview?: ReviewHandler;
}

export class ToolgateDeniedError extends Error {
  readonly check: CheckResult;
  constructor(check: CheckResult) {
    super(
      `Toolgate stopped execution: ${check.status === "error" ? "guard unavailable" : check.decision}.`,
    );
    this.name = "ToolgateDeniedError";
    this.check = check;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

/** Wrap server-side tools before passing them to generateText or streamText. */
export function guardTools<T extends ToolSet>(tools: T, options: GuardToolsOptions): T {
  const entries = Object.entries(tools).map(([name, definition]) => {
    if (definition.type === "provider" || !definition.execute) {
      throw new Error(`Toolgate requires a server-side execute function: ${name}`);
    }

    if (definition.onInputStart || definition.onInputDelta || definition.onInputAvailable) {
      throw new Error(`Move input lifecycle hooks outside guarded tools: ${name}`);
    }

    const original = definition.execute;

    return [
      name,
      {
        ...definition,
        async *execute(input: unknown, execution: ToolExecutionOptions) {
          const given = inputSchema.parse({
            ...options.getContext({ toolName: name, toolCallId: execution.toolCallId }),
            toolCall: { name, arguments: input },
          });
          const outcome = await options.gate.execute(
            given,
            async (args) => original(args, execution),
            {
              ...(execution.abortSignal ? { signal: execution.abortSignal } : {}),
              ...(options.onReview ? { onReview: options.onReview } : {}),
            },
          );

          if (outcome.status !== "executed") throw new ToolgateDeniedError(outcome.check);

          execution.abortSignal?.throwIfAborted();

          if (isAsyncIterable(outcome.output)) {
            for await (const chunk of outcome.output) {
              execution.abortSignal?.throwIfAborted();
              yield chunk;
            }
          } else {
            yield outcome.output;
          }
        },
      },
    ];
  });

  // The wrapper preserves each tool's input/output types and schema.
  return Object.fromEntries(entries) as T;
}
