import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { createJevClient } from "@toolgate/core";
import type { ReviewHandler } from "@toolgate/core";
import { runScenario, scenarios } from "./scenarios.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      interactive: { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(
      "pnpm demo [--live] [--interactive]\nScripted agent + in-memory email tool. --live uses Jev. --interactive asks for review approval.",
    );

    return;
  }

  if (values.interactive && !process.stdin.isTTY)
    throw new Error("Interactive review requires a terminal.");

  const client = values.live
    ? createJevClient({ apiKey: process.env.TYPESAFE_API_KEY ?? "" })
    : null;
  const rl = values.interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const onReview: ReviewHandler | undefined = rl
    ? async ({ given, signal }) => {
        console.log("Review this exact call:", JSON.stringify(given.toolCall, null, 2));

        return (
          (await rl.question("Execute? Type yes: ", { signal })).trim().toLowerCase() === "yes"
        );
      }
    : undefined;

  console.log(
    client
      ? "LIVE Jev guard; scripted agent; in-memory email tool."
      : "OFFLINE demonstration: scripted agent and guard decisions, in-memory email tool. This is not a benchmark.",
  );

  try {
    for (const scenario of scenarios) {
      let actual = "unknown";
      let guardStatus = "ok";
      const evaluator = {
        evaluate: async (...args: Parameters<NonNullable<typeof client>["evaluate"]>) => {
          try {
            const result = client
              ? await client.evaluate(...args)
              : {
                  decision: scenario.expected,
                  reason: "Scripted demo decision",
                  usage: null,
                  resolvedModel: "demo-stub",
                };

            actual = result.decision;

            return result;
          } catch (error) {
            guardStatus = "error";
            throw error;
          }
        },
      };
      const outcome = await runScenario(scenario, evaluator, onReview);

      console.log(
        JSON.stringify({
          case: scenario.id,
          expected: scenario.expected,
          actual,
          guardStatus,
          executed: outcome.sent.length > 0,
        }),
      );

      if (guardStatus === "error") process.exitCode = 2;
    }
  } finally {
    rl?.close();
  }
}

main().catch(() => {
  console.error("Demo failed. Check configuration and TYPESAFE_API_KEY for live mode.");
  process.exitCode = 1;
});
