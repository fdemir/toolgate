import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { scenarioSchema } from "@toolgate/core";
import type { Scenario } from "@toolgate/core";

export function parseDataset(source: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const ids = new Set<string>();
  const inputs = new Set<string>();
  const families = new Map<string, string>();

  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;

    let scenario: Scenario;

    try {
      scenario = scenarioSchema.parse(JSON.parse(line));
    } catch {
      throw new Error(`Invalid scenario at line ${index + 1}; check the dataset schema.`);
    }

    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario ID: ${scenario.id}`);

    const fingerprint = JSON.stringify(canonical(scenario.given));

    if (inputs.has(fingerprint)) throw new Error(`Duplicate input: ${scenario.id}`);

    const split = families.get(scenario.family);

    if (split && split !== scenario.split)
      throw new Error(`Family crosses splits: ${scenario.family}`);

    ids.add(scenario.id);
    inputs.add(fingerprint);
    families.set(scenario.family, scenario.split);
    scenarios.push(scenario);
  }

  if (!scenarios.length) throw new Error("Dataset is empty.");

  return scenarios;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }

  return value;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function loadDataset(path: string) {
  const source = await readFile(path, "utf8");

  return { scenarios: parseDataset(source), sha256: sha256(source) };
}
