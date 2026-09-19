import type { EvaluationResult } from "./runner.ts";

export type Report = EvaluationResult & {
  dataset: { file: string; sha256: string; split: string; selectedIds: string[] };
  implementationSha256: string;
};

const number = (value: number | null) => (value === null ? "unknown" : value.toFixed(3));
const pct = (value: { count: number; total: number; rate: number | null }) =>
  `${value.count}/${value.total} (${value.rate === null ? "n/a" : `${(value.rate * 100).toFixed(1)}%`})`;
const cell = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("\n", " ");

function jsonBlock(value: unknown) {
  const json = JSON.stringify(value, null, 2);
  const longest = Math.max(0, ...(json.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));

  return `${fence}json\n${json}\n${fence}`;
}

export function markdownReport(report: Report): string {
  const s = report.summary;
  const lines = [
    "# Toolgate — Jev evaluation",
    "",
    `Matched **${pct(s.accuracy)}** expected outputs. Errors: ${s.errorRate.count}.`,
    "",
    `Dataset: ${cell(report.dataset.file)}; split: ${report.dataset.split}; ${report.dataset.selectedIds.length} cases × ${report.options.repetitions} repetitions.`,
    `Started: ${report.startedAt}. Seed: ${report.options.seed}; concurrency: ${report.options.concurrency}; timeout: ${report.options.timeoutMs} ms.`,
    "",
    `p50 / p95: ${number(s.latencyMs.p50)} / ${number(s.latencyMs.p95)} ms. Estimated API cost: ${s.costUsd.total === null ? "unknown" : "$" + s.costUsd.total.toFixed(6)}.`,
    `Reported tokens: ${s.tokens.knownInput} input (${s.tokens.knownCachedInput} cached), ${s.tokens.knownOutput} output. Usage coverage: ${pct(s.tokens.coverage)}. Cost coverage: ${pct(s.costUsd.coverage)}.`,
    `Unsafe actions allowed: ${pct(s.unsafeMissed)}. Legitimate actions blocked: ${pct(s.legitimateBlocked)}. Required reviews allowed: ${pct(s.reviewRequiredAllowed)}. Review decisions: ${pct(s.reviewRate)}.`,
    "",
    "## Cases",
    "",
    "| Case | Given: user request | Expected | Actual | Result |",
    "| --- | --- | --- | --- | --- |",
    ...report.rows.map(
      (row) =>
        `| ${cell(row.scenarioId)} (${row.repetition}) | ${cell(row.given.userRequest)} | ${row.expected} | ${row.actual} | ${row.status === "error" ? cell(row.error ?? "error") : row.matched ? "pass" : "fail"} |`,
    ),
    "",
    "## Full given / expected / actual",
    "",
  ];

  for (const row of report.rows) {
    lines.push(
      `### ${cell(row.scenarioId)} · repetition ${row.repetition}`,
      "",
      jsonBlock({
        given: row.given,
        expected: row.expected,
        actual: row.actual,
        matched: row.matched,
        status: row.status,
        error: row.error,
      }),
      "",
      `Label rationale: ${cell(row.rationale)}`,
      "",
    );
  }

  lines.push(
    "## Run details",
    "",
    `Dataset SHA-256: \`${report.dataset.sha256}\`.`,
    `Implementation SHA-256: \`${report.implementationSha256}\`.`,
    `Reported models: ${[...new Set(report.rows.map((row) => row.resolvedModel ?? "unknown"))].map(cell).join(", ")}.`,
    "API errors use a review fallback and always fail the expected-output check. Missing cost or usage stays unknown. Latency includes failed calls.",
    "These are synthetic, explicitly labeled examples without independent human annotation. Repetitions are not new labeled examples. See report.json for the confusion matrix and per-category metrics.",
    "",
  );

  return lines.join("\n");
}
