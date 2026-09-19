import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDataset } from "../src/dataset.ts";
import { sample, scenarios } from "./helpers.ts";

test("core dataset has 72 cases, balanced labels, six categories and disjoint families", () => {
  assert.equal(scenarios.length, 72);
  assert.equal(new Set(scenarios.map((s) => s.family)).size, 24);

  for (const split of ["dev", "test"]) {
    const subset = scenarios.filter((s) => s.split === split);

    assert.equal(subset.length, 36);
    assert.equal(new Set(subset.map((s) => s.category)).size, 6);

    for (const label of ["allow", "block", "review"])
      assert.equal(subset.filter((s) => s.expected === label).length, 12);
  }

  for (const family of new Set(scenarios.map((s) => s.family))) {
    const group = scenarios.filter((s) => s.family === family);

    assert.equal(new Set(group.map((s) => s.expected)).size, 3);
    assert.equal(new Set(group.map((s) => s.split)).size, 1);
  }
});

test("rejects empty, malformed, duplicate, and label-contaminated inputs", () => {
  assert.throws(() => parseDataset(" \n"), /empty/);
  assert.throws(() => parseDataset("{"), /line 1/);

  const first = sample();

  assert.throws(
    () => parseDataset(JSON.stringify(first) + "\n" + JSON.stringify(first)),
    /Duplicate scenario ID/,
  );
  assert.throws(
    () => parseDataset(JSON.stringify({ ...first, given: { ...first.given, expected: "block" } })),
    /Invalid scenario/,
  );
  assert.throws(
    () => parseDataset(JSON.stringify({ ...first, expected: "deny" })),
    /Invalid scenario/,
  );
});

test("rejects duplicate inputs even with reordered object keys", () => {
  const first = sample();
  const duplicate = {
    ...first,
    id: "duplicate",
    given: Object.fromEntries(Object.entries(first.given).reverse()),
  };

  assert.throws(
    () => parseDataset([first, duplicate].map((s) => JSON.stringify(s)).join("\n")),
    /Duplicate input/,
  );
});

test("rejects scenario-family leakage between development and test splits", () => {
  const first = sample();
  const second = sample();

  second.id = "second";
  second.split = "test";
  second.given.userRequest = "Different request.";
  assert.throws(
    () => parseDataset([first, second].map((s) => JSON.stringify(s)).join("\n")),
    /Family crosses splits/,
  );
});

test("mail dataset has 24 balanced scenarios and excludes label rationale from model input", async () => {
  const { readFile } = await import("node:fs/promises");
  const cases = parseDataset(
    await readFile(new URL("../../../datasets/mail.jsonl", import.meta.url), "utf8"),
  );

  assert.equal(cases.length, 24);
  assert.equal(new Set(cases.map((item) => item.family)).size, 8);

  for (const expected of ["allow", "block", "review"])
    assert.equal(cases.filter((item) => item.expected === expected).length, 8);

  for (const item of cases) {
    assert.equal(JSON.stringify(item.given).includes("labelBasis"), false);
    assert.equal(JSON.stringify(item.given).includes(item.rationale), false);
  }
});
