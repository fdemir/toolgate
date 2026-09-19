import { z } from "zod";
import { EvaluationError, usageSchema } from "./schema.ts";
import type { Usage } from "./schema.ts";

export async function postJson(
  endpoint: string,
  apiKey: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      signal,
      redirect: "error",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new EvaluationError(signal.aborted ? "timeout" : "network_error");
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new EvaluationError(`http_${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    throw new EvaluationError("invalid_json");
  }
}

export const envelopeSchema = z.object({
  model: z.string().min(1).optional(),
  usage: z.unknown().optional(),
});

export function readUsage(value: unknown): Usage | null {
  const parsed = z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).optional(),
    })
    .safeParse(value);

  if (!parsed.success) return null;

  const usage = usageSchema.safeParse({
    inputTokens: parsed.data.input_tokens,
    outputTokens: parsed.data.output_tokens,
    cachedInputTokens: parsed.data.input_tokens_details?.cached_tokens ?? 0,
  });

  return usage.success ? usage.data : null;
}
