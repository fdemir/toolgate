import { z } from "zod";

export const decisionSchema = z.enum(["allow", "block", "review"]);

export type Decision = z.infer<typeof decisionSchema>;

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const fieldRule = z.strictObject({
  type: z.enum(["string", "number", "boolean", "array", "object"]),
  required: z.boolean().default(true),
  min: z.number().optional(),
  max: z.number().optional(),
  allowedValues: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  allowedHosts: z.array(text).optional(),
});

export const inputSchema = z.strictObject({
  userRequest: text,
  toolCall: z.strictObject({ name: text, arguments: z.record(z.string(), z.json()) }),
  context: z.array(
    z.strictObject({
      source: z.enum(["application", "webpage", "document", "tool"]),
      content: text,
    }),
  ),
  policies: z.strictObject({
    instructions: z.array(text),
    tools: z.record(
      z.string(),
      z.strictObject({
        description: text,
        fields: z.record(z.string(), fieldRule),
      }),
    ),
  }),
});

export type GuardInput = z.infer<typeof inputSchema>;

export const scenarioSchema = z.strictObject({
  id: text.regex(/^[a-z0-9-]+$/),
  family: text,
  split: z.enum(["dev", "test"]),
  category: z.enum(["intent", "scope", "exfiltration", "injection", "policy", "ambiguity"]),
  given: inputSchema,
  expected: decisionSchema,
  rationale: text,
});

export type Scenario = z.infer<typeof scenarioSchema>;

export const usageSchema = z
  .strictObject({
    inputTokens: count,
    outputTokens: count,
    cachedInputTokens: count.default(0),
  })
  .refine((u) => u.cachedInputTokens <= u.inputTokens, "Cached tokens exceed input tokens");

export type Usage = z.infer<typeof usageSchema>;

export const resultSchema = z.strictObject({
  decision: decisionSchema,
  reason: text,
  usage: usageSchema.nullable(),
  resolvedModel: text.nullable(),
});

export type GuardResult = z.infer<typeof resultSchema>;

export const pricingSchema = z.strictObject({
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
  cachedInputPerMillion: z.number().nonnegative().optional(),
});

export type Pricing = z.infer<typeof pricingSchema>;

export interface JevClient {
  configuration: Record<string, unknown>;
  pricing: Pricing | null;
  evaluate(input: GuardInput, signal: AbortSignal): Promise<GuardResult>;
}

export class EvaluationError extends Error {
  code: string;
  usage: Usage | null;
  resolvedModel: string | null;
  constructor(code: string, usage: Usage | null = null, model: string | null = null) {
    super(code);
    this.name = "EvaluationError";
    this.code = code;
    this.usage = usage;
    this.resolvedModel = model;
  }
}
