import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { createJevClient } from "@toolgate/core";
import { loadJev } from "../src/config.ts";
import { runEvaluation } from "../src/runner.ts";
import { options, sample } from "./helpers.ts";

async function mock(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const address = server.address();

  assert.ok(address && typeof address !== "string");

  return `http://127.0.0.1:${address.port}`;
}

const jevBody = {
  model: "jev-test-snapshot",
  usage: { input_tokens: 91, output_tokens: 5 },
  answers: {
    decision: {
      type: "choice",
      choice: "block",
      probabilities: { allow: 0.05, block: 0.9, review: 0.05 },
      confidence: 0.8,
    },
  },
};
const settings = { apiKey: "FAKE_TEST_KEY", model: "requested-model", pricing: null };

test("Jev sends the documented choice request without labels and reads model/usage", async (t) => {
  let requestBody: unknown;
  let authorization: string | undefined;
  const endpoint = await mock(t, (request, response) => {
    authorization = request.headers.authorization;

    const chunks: Buffer[] = [];

    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(jevBody));
    });
  });
  const guard = createJevClient({ ...settings, endpoint });
  const result = await guard.evaluate(sample().given, new AbortController().signal);

  assert.equal(authorization, "Bearer FAKE_TEST_KEY");

  const payload = JSON.parse(JSON.stringify(requestBody));

  assert.deepEqual(payload.state, sample().given);
  assert.equal(payload.model, "requested-model");
  assert.equal(payload.questions.decision.type, "choice");
  assert.deepEqual(Object.keys(payload.questions.decision.criteria).sort(), [
    "allow",
    "block",
    "review",
  ]);
  assert.equal(result.decision, "block");
  assert.equal(result.resolvedModel, "jev-test-snapshot");
  assert.equal(result.usage?.inputTokens, 91);
  assert.equal(JSON.stringify(guard.configuration).includes("FAKE_TEST_KEY"), false);
});

for (const [name, body] of [
  [
    "unknown choice",
    { ...jevBody, answers: { decision: { ...jevBody.answers.decision, choice: "execute" } } },
  ],
  ["missing answer", { ...jevBody, answers: {} }],
  [
    "inconsistent probabilities",
    { ...jevBody, answers: { decision: { ...jevBody.answers.decision, choice: "allow" } } },
  ],
]) {
  test(`Jev ${name} becomes an error review and preserves usage`, async (t) => {
    const endpoint = await mock(t, (_request, response) => response.end(JSON.stringify(body)));
    const report = await runEvaluation(
      [sample()],
      createJevClient({ ...settings, endpoint }),
      options,
    );

    assert.equal(report.rows[0]!.actual, "review");
    assert.equal(report.rows[0]!.error, "invalid_response");
    assert.equal(report.rows[0]!.usage?.inputTokens, 91);
  });
}

test("missing or malformed token usage is unknown, never zero", async (t) => {
  const endpoint = await mock(t, (_request, response) =>
    response.end(JSON.stringify({ ...jevBody, usage: { input_tokens: -1 } })),
  );
  const result = await createJevClient({ ...settings, endpoint }).evaluate(
    sample().given,
    new AbortController().signal,
  );

  assert.equal(result.decision, "block");
  assert.equal(result.usage, null);
});

for (const status of [401, 429, 500, 529]) {
  test(`HTTP ${status} is counted once without hidden retries or error-body leaks`, async (t) => {
    let calls = 0;
    const endpoint = await mock(t, (_request, response) => {
      calls++;
      response.statusCode = status;
      response.end("SECRET_PROVIDER_BODY");
    });
    const report = await runEvaluation(
      [sample()],
      createJevClient({ ...settings, endpoint }),
      options,
    );

    assert.equal(calls, 1);
    assert.equal(report.rows[0]!.error, `http_${status}`);
    assert.equal(report.rows[0]!.usage, null);
    assert.equal(JSON.stringify(report).includes("SECRET_PROVIDER_BODY"), false);
  });
}

test("invalid JSON and redirect responses fail closed", async (t) => {
  const endpoint = await mock(t, (request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/target" });
      response.end();
    } else {
      response.end("not-json");
    }
  });

  for (const path of ["", "/redirect"]) {
    const report = await runEvaluation(
      [sample()],
      createJevClient({ ...settings, endpoint: endpoint + path }),
      options,
    );

    assert.equal(report.rows[0]!.actual, "review");
    assert.equal(report.rows[0]!.status, "error");
  }
});

test("missing key fails before making an API request", async () => {
  await assert.rejects(
    loadJev(new URL("../../../benchmark.config.json", import.meta.url).pathname, {}),
    /TYPESAFE_API_KEY/,
  );
});
