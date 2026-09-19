import { readFile } from "node:fs/promises";
import { z } from "zod";
import { pricingSchema } from "@toolgate/core";
import { createJevClient } from "@toolgate/core";

export const configSchema = z.strictObject({
  model: z.string().min(1),
  endpoint: z.url().refine((value) => {
    const u = new URL(value);

    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  }, "Use an HTTPS endpoint without credentials or query parameters."),
  pricing: pricingSchema.nullable(),
});

export async function loadJev(configPath: string, env = process.env) {
  const config = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const apiKey = env.TYPESAFE_API_KEY?.trim();

  if (!apiKey) throw new Error("Missing TYPESAFE_API_KEY; add it to .env or the environment.");

  return createJevClient({ ...config, apiKey });
}
