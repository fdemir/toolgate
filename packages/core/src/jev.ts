import { z } from "zod";
import { decisionSchema, EvaluationError } from "./schema.ts";
import type { JevClient, Pricing } from "./schema.ts";
import { envelopeSchema, postJson, readUsage } from "./http.ts";
import { instructions, promptHash, rubric } from "./prompt.ts";

export interface JevOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  pricing?: Pricing | null;
}

const answerSchema = z
  .object({
    answers: z.object({
      decision: z.object({
        type: z.literal("choice"),
        choice: decisionSchema,
        probabilities: z.object({
          allow: z.number().min(0).max(1),
          block: z.number().min(0).max(1),
          review: z.number().min(0).max(1),
        }),
        confidence: z.number().min(0).max(1),
      }),
    }),
  })
  .refine(
    ({ answers: { decision: a } }) =>
      Math.abs(Object.values(a.probabilities).reduce((sum, n) => sum + n, 0) - 1) < 0.01 &&
      a.probabilities[a.choice] >= Math.max(...Object.values(a.probabilities)),
    "Invalid choice distribution",
  );

export function createJevClient(options: JevOptions): JevClient {
  const apiKey = options.apiKey.trim();

  if (!apiKey) throw new Error("Missing TYPESAFE_API_KEY.");

  const model = options.model ?? "jev-1.13.0";
  const endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
  const url = new URL(endpoint);

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  ) {
    throw new Error("Jev requires HTTPS; HTTP is allowed only for local tests.");
  }

  return {
    pricing: options.pricing ?? null,
    configuration: {
      model,
      endpoint,
      promptHash,
      strategy: "direct-choice-v1",
    },
    async evaluate(input, signal) {
      const raw = await postJson(
        endpoint,
        apiKey,
        {
          model,
          state: input,
          questions: { decision: { type: "choice", instructions, criteria: rubric } },
        },
        signal,
      );
      const envelope = envelopeSchema.safeParse(raw);
      const usage = envelope.success ? readUsage(envelope.data.usage) : null;
      const resolvedModel = envelope.success ? (envelope.data.model ?? null) : null;
      const parsed = answerSchema.safeParse(raw);

      if (!parsed.success) throw new EvaluationError("invalid_response", usage, resolvedModel);

      return {
        decision: parsed.data.answers.decision.choice,
        reason: "Jev choice classification.",
        usage,
        resolvedModel,
      };
    },
  };
}
