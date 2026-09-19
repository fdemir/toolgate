import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownReport } from "../src/report.ts";
import type { Report } from "../src/report.ts";

const exec = promisify(execFile);
const env = { ...process.env, TYPESAFE_API_KEY: "" };
const testEnv = { ...env, TYPESAFE_API_KEY: "FAKE_TEST_KEY" };

process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));

const mockCli = [
  "--import",
  "./packages/eval/tests/fixtures/jev-http.ts",
  "packages/eval/src/cli.ts",
];

test("evaluation CLI writes given/expected/actual for every case, without leaking credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "toolgate-cli-"));

  t.after(() => rm(root, { recursive: true, force: true }));

  const out = join(root, "report");
  const { stdout } = await exec(
    process.execPath,
    [...mockCli, "evaluate", "--split", "all", "--repeat", "2", "--out", out],
    { env: testEnv },
  );

  assert.match(stdout, /Matched 48\/144 expected outputs/);

  const report: Report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  const lines = (await readFile(join(out, "results.jsonl"), "utf8")).trim().split("\n");
  const markdown = await readFile(join(out, "report.md"), "utf8");

  assert.equal(report.rows.length, 144);
  assert.equal(lines.length, 144);
  assert.equal(report.summary.uniqueScenarios, 72);
  assert.equal(report.summary.errorRate.count, 0);
  assert.ok(report.summary.costUsd.total! > 0);

  for (const row of report.rows) {
    assert.ok(row.given.userRequest);
    assert.equal(row.actual, "block");
    assert.equal(row.matched, row.expected === "block");
  }

  assert.match(report.dataset.sha256, /^[0-9a-f]{64}$/);
  assert.match(report.implementationSha256, /^[0-9a-f]{64}$/);
  assert.match(markdown, /Given: user request \| Expected \| Actual \| Result/);
  assert.equal(markdown, markdownReport(report));
  assert.equal(JSON.stringify(report).includes("FAKE_TEST_KEY"), false);
  assert.equal("adapters" in report, false);
  await assert.rejects(
    exec(process.execPath, [...mockCli, "evaluate", "--out", out], { env: testEnv }),
    /EEXIST/,
  );
});

test("inspect is offline and respects split/category/seed/limit", async () => {
  const args = [
    "packages/eval/src/cli.ts",
    "inspect",
    "--split",
    "dev",
    "--category",
    "injection",
    "--limit",
    "1",
    "--seed",
    "19",
  ];
  const a = await exec(process.execPath, args, { env });
  const b = await exec(process.execPath, args, { env });

  assert.equal(a.stdout, b.stdout);

  const item = JSON.parse(a.stdout);

  assert.deepEqual(Object.keys(item).sort(), ["expected", "given", "id"]);
  assert.ok(item.given.context.length > 0);
});

test("removed commands and flags, invalid selections, and missing keys fail before evaluation", async () => {
  for (const args of [
    ["compare"],
    ["evaluate", "--adapters", "rules"],
    ["evaluate", "--live"],
    ["evaluate", "--bad-flag"],
    ["evaluate", "--split", "unknown"],
    ["evaluate", "--category", "unknown"],
    ["evaluate", "--repeat", "0"],
    ["evaluate", "--limit", "0"],
    ["evaluate"],
  ]) {
    await assert.rejects(
      exec(process.execPath, ["packages/eval/src/cli.ts", ...args], { env }),
      (error) => {
        assert.ok(error && typeof error === "object" && "code" in error);

        return error.code === 1;
      },
    );
  }
});

test("API failures produce a complete error report and exit code 2", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "toolgate-errors-"));

  t.after(() => rm(root, { recursive: true, force: true }));

  const out = join(root, "report");

  await assert.rejects(
    exec(process.execPath, [...mockCli, "evaluate", "--limit", "2", "--out", out], {
      env: { ...testEnv, TOOLGATE_TEST_HTTP_FAILURE: "1" },
    }),
    (error) => {
      assert.ok(error && typeof error === "object" && "code" in error);

      return error.code === 2;
    },
  );

  const report: Report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));

  assert.equal(report.summary.errorRate.count, 2);
  assert.equal(report.summary.accuracy.count, 0);
  assert.ok(report.rows.every((row) => !row.matched && row.error === "http_503"));
});
