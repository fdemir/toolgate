import { test } from "node:test";
import assert from "node:assert/strict";
import { generateText, streamText, tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { createGate } from "@toolgate/core";
import type { Decision } from "@toolgate/core";
import { guardTools } from "../src/index.ts";

const context = {
  userRequest: "Send hello",
  context: [],
  policies: { instructions: [], tools: {} },
};
const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function gate(decision: Decision) {
  return createGate({
    client: {
      evaluate: async () => ({ decision, reason: "fixture", usage: null, resolvedModel: null }),
    },
  });
}

function model() {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [
        { type: "tool-call", toolCallId: "call-1", toolName: "send", input: '{"body":"hello"}' },
      ],
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage,
      warnings: [],
    },
  });
}

test("native AI SDK approval cannot bypass a Toolgate block", async () => {
  let executions = 0;
  let checks = 0;
  const blockingGate = createGate({
    client: {
      evaluate: async () => {
        checks++;

        return { decision: "block", reason: "fixture", usage: null, resolvedModel: null };
      },
    },
  });
  const tools = guardTools(
    {
      send: tool({
        inputSchema: z.object({ body: z.string() }),
        needsApproval: true,
        execute: async () => ++executions,
      }),
    },
    { gate: blockingGate, getContext: () => context },
  );
  const first = await generateText({ model: model(), tools, prompt: "Send hello", maxRetries: 0 });
  const approval = first.content.find((part) => part.type === "tool-approval-request");

  assert.ok(approval);
  assert.equal(executions, 0);

  const second = await generateText({
    model: new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "Stopped" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    }),
    tools,
    messages: [
      { role: "user", content: "Send hello" },
      ...first.response.messages,
      {
        role: "tool",
        content: [
          { type: "tool-approval-response", approvalId: approval.approvalId, approved: true },
        ],
      },
    ],
    maxRetries: 0,
  });

  assert.equal(executions, 0);
  assert.ok(second.response.messages.length > 0);
  assert.equal(checks, 1);
});

test("streamText preserves streamed tool outputs after authorization", async () => {
  let executions = 0;
  const tools = guardTools(
    {
      send: tool({
        inputSchema: z.object({ body: z.string() }),
        async *execute() {
          executions++;
          yield "started";
          yield "done";
        },
      }),
    },
    { gate: gate("allow"), getContext: () => context },
  );
  const response = streamText({
    model: new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "stream-1",
              toolName: "send",
              input: '{"body":"hello"}',
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
          ],
        }),
      },
    }),
    tools,
    prompt: "Send hello",
    maxRetries: 0,
  });
  const outputs: unknown[] = [];

  for await (const part of response.fullStream)
    if (part.type === "tool-result") outputs.push(part.output);

  assert.equal(executions, 1);
  // AI SDK emits preliminary chunks, then repeats the last value as the final result.
  assert.deepEqual(outputs, ["started", "done", "done"]);
});

test("unsupported execution paths are rejected at setup", () => {
  assert.throws(
    () =>
      guardTools(
        { send: tool({ inputSchema: z.object({}) }) },
        { gate: gate("allow"), getContext: () => context },
      ),
    /server-side/,
  );
  assert.throws(
    () =>
      guardTools(
        {
          send: tool({
            inputSchema: z.object({}),
            onInputAvailable: () => {},
            execute: async () => true,
          }),
        },
        { gate: gate("allow"), getContext: () => context },
      ),
    /lifecycle/,
  );
});

test("concurrent calls receive separate trusted context keyed by toolCallId", async () => {
  const ids: string[] = [];
  const tools = guardTools(
    {
      send: tool({
        inputSchema: z.object({ body: z.string() }),
        execute: async ({ body }) => body,
      }),
    },
    {
      gate: gate("allow"),
      getContext: ({ toolCallId }) => {
        ids.push(toolCallId);

        return context;
      },
    },
  );

  await Promise.all(
    ["a", "b"].map(async (toolCallId) => {
      const modelInstance = model();

      modelInstance.doGenerate = async () => ({
        content: [{ type: "tool-call", toolCallId, toolName: "send", input: '{"body":"hello"}' }],
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage,
        warnings: [],
      });

      const response = await generateText({ model: modelInstance, tools, prompt: "Send hello" });

      assert.equal(response.toolResults[0]?.output, "hello");
    }),
  );
  assert.deepEqual(ids.sort(), ["a", "b"]);
});
