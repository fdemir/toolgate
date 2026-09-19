#!/usr/bin/env node
import { parseArgs } from "node:util";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadDataset, sha256 } from "./dataset.ts";
import { loadJev } from "./config.ts";
import { runEvaluation, runOptionsSchema, shuffled } from "./runner.ts";
import { markdownReport } from "./report.ts";

const help = `Toolgate — evaluate Jev against given / expected examples.

  pnpm bench validate
  pnpm bench inspect --limit 1
  pnpm evaluate --split all

Options:
  --dataset PATH       JSONL scenarios (default: bundled core dataset)
  --config PATH        Jev model and pricing (default: bundled Jev configuration)
  --split NAME         dev, test, all (default: test)
  --category NAME      Select one scenario category
  --limit N            Select N cases after seeded shuffling
  --repeat N           Repetitions per case (default: 1)
  --seed N             Shuffle seed (default: 42)
  --concurrency N      Concurrent Jev evaluations (default: 1)
  --timeout-ms N       Per-call deadline (default: 15000)
  --out PATH           New report directory (must not already exist)
  --help               Show this help

evaluate makes live Jev API calls. inspect and validate run offline.
Missing keys fail before evaluation. API errors produce review, are reported,
and exit with code 2. Invalid configuration exits with code 1.
`;

async function implementationHash() {
  const roots = [
    dirname(fileURLToPath(import.meta.url)),
    dirname(fileURLToPath(import.meta.resolve("@toolgate/core"))),
  ];
  const parts = await Promise.all(
    roots.map(async (root) => {
      const files = (await readdir(root, { recursive: true }))
        .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts"))
        .sort();

      return sha256(
        (
          await Promise.all(
            files.map(async (file) => `${file}\n${await readFile(join(root, file), "utf8")}`),
          )
        ).join("\n"),
      );
    }),
  );

  return sha256(parts.join("\n"));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      dataset: {
        type: "string",
        default: fileURLToPath(
          new URL(
            import.meta.url.endsWith(".ts") ? "../../../datasets/core.jsonl" : "./data/core.jsonl",
            import.meta.url,
          ),
        ),
      },
      config: {
        type: "string",
        default: fileURLToPath(
          new URL(
            import.meta.url.endsWith(".ts")
              ? "../../../benchmark.config.json"
              : "./data/benchmark.config.json",
            import.meta.url,
          ),
        ),
      },
      split: { type: "string", default: "test" },
      category: { type: "string" },
      limit: { type: "string" },
      repeat: { type: "string", default: "1" },
      seed: { type: "string", default: "42" },
      concurrency: { type: "string", default: "1" },
      "timeout-ms": { type: "string", default: "15000" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });

  if (values.help || !positionals.length) {
    console.log(help);

    return;
  }

  if (positionals.length !== 1 || !["evaluate", "inspect", "validate"].includes(positionals[0]!))
    throw new Error("Expected evaluate, inspect, or validate; use --help.");

  const dataset = await loadDataset(values.dataset);

  if (positionals[0] === "validate") {
    console.log(
      `Valid: ${dataset.scenarios.length} scenarios, ${new Set(dataset.scenarios.map((s) => s.family)).size} families.`,
    );

    for (const split of ["dev", "test"]) {
      const cases = dataset.scenarios.filter((s) => s.split === split);

      console.log(
        `${split}: ${cases.length} cases; ${["allow", "block", "review"].map((label) => `${label}=${cases.filter((s) => s.expected === label).length}`).join(", ")}`,
      );
    }

    console.log(`SHA-256: ${dataset.sha256}`);

    return;
  }

  if (!["dev", "test", "all"].includes(values.split))
    throw new Error("Split must be dev, test, or all.");

  const options = runOptionsSchema.parse({
    repetitions: Number(values.repeat),
    seed: Number(values.seed),
    concurrency: Number(values.concurrency),
    timeoutMs: Number(values["timeout-ms"]),
  });
  let scenarios = dataset.scenarios.filter(
    (s) =>
      (values.split === "all" || s.split === values.split) &&
      (!values.category || s.category === values.category),
  );

  if (values.limit !== undefined) {
    const limit = Number(values.limit);

    if (!Number.isInteger(limit) || limit < 1) throw new Error("Limit must be a positive integer.");

    scenarios = shuffled(scenarios, options.seed).slice(0, limit);
  }

  if (!scenarios.length) throw new Error("No scenarios match the selection.");

  if (positionals[0] === "inspect") {
    for (const scenario of scenarios)
      console.log(
        JSON.stringify(
          { id: scenario.id, given: scenario.given, expected: scenario.expected },
          null,
          2,
        ),
      );

    return;
  }

  const client = await loadJev(values.config);
  const sourceHash = await implementationHash();
  const out = resolve(
    values.out ??
      join(
        "reports",
        `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
      ),
  );

  await mkdir(dirname(out), { recursive: true });
  await mkdir(out); // Refuse to overwrite any previous run, before making paid requests.
  await writeFile(join(out, "results.jsonl"), "");
  console.log(
    `${scenarios.length} scenarios × ${options.repetitions} repetitions. Live Jev API calls enabled.`,
  );

  let completed = 0;
  let writeQueue = Promise.resolve();
  const result = await runEvaluation(scenarios, client, options, (row, total) => {
    writeQueue = writeQueue.then(async () => {
      await appendFile(join(out, "results.jsonl"), `${JSON.stringify(row)}\n`);
      completed++;

      if (completed % 10 === 0 || completed === total)
        console.log(`Completed ${completed}/${total}.`);
    });

    return writeQueue;
  });
  const report = {
    ...result,
    dataset: {
      file: basename(values.dataset),
      sha256: dataset.sha256,
      split: values.split,
      selectedIds: scenarios.map((s) => s.id),
    },
    implementationSha256: sourceHash,
  };

  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(out, "report.md"), markdownReport(report));

  const s = report.summary;

  console.log(
    `Matched ${s.accuracy.count}/${s.calls} expected outputs; ${s.calls - s.accuracy.count - s.errorRate.count} mismatches; ${s.errorRate.count} errors.`,
  );
  console.log(`Report: ${join(out, "report.md")}`);

  if (result.rows.some((row) => row.status === "error")) process.exitCode = 2;
}

main().catch((error) => {
  // Never print request headers, provider bodies, or environment values.
  console.error(error instanceof Error ? error.message : "Benchmark failed.");
  process.exitCode = 1;
});
