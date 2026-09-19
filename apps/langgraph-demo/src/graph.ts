import { z } from "zod";
import { Annotation, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { inputSchema } from "@toolgate/core";
import type { CheckResult, Gate, GuardInput } from "@toolgate/core";

const State = Annotation.Root({
  check: Annotation<CheckResult>(),
  approved: Annotation<boolean>(),
  executed: Annotation<boolean>(),
});

/** One graph instance per proposed call. Approval resumes the stored decision. */
export function createGuardedGraph(options: {
  gate: Gate;
  given: GuardInput;
  execute: (args: GuardInput["toolCall"]["arguments"]) => Promise<void>;
}) {
  const given = inputSchema.parse(options.given);

  return new StateGraph(State)
    .addNode("guard", async (_state, config) => ({
      check: await options.gate.check(given, config.signal ? { signal: config.signal } : {}),
      approved: false,
      executed: false,
    }))
    .addNode("approval", () => {
      const approval = z
        .strictObject({ approved: z.boolean() })
        .safeParse(interrupt({ toolCall: structuredClone(given.toolCall) }));

      return { approved: approval.success && approval.data.approved === true };
    })
    .addNode("action", async (state, config) => {
      config.signal?.throwIfAborted();

      if (
        state.check.status !== "ok" ||
        !(state.check.decision === "allow" || (state.check.decision === "review" && state.approved))
      ) {
        return { executed: false };
      }

      await options.execute(structuredClone(given.toolCall.arguments));

      return { executed: true };
    })
    .addEdge(START, "guard")
    .addConditionalEdges(
      "guard",
      (state) => {
        if (state.check.status === "error" || state.check.decision === "block") return END;

        return state.check.decision === "review" ? "approval" : "action";
      },
      [END, "approval", "action"],
    )
    .addConditionalEdges("approval", (state) => (state.approved ? "action" : END), ["action", END])
    .addEdge("action", END)
    .compile({ checkpointer: new MemorySaver() });
}
