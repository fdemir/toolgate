import { test } from "node:test";
import assert from "node:assert/strict";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createGate } from "@toolgate/core";
import { createMailTools } from "../src/mail-tools.ts";
import { createMailSession } from "../src/mail-session.ts";

test("AI SDK sees only a send tool and cannot supply its own approval or owner", async () => {
  let sent = 0;
  const mail = { to: "ada@example.com", subject: "Meeting", body: "Hello" };
  const session = createMailSession({
    owner: "alice",
    gate: createGate({
      client: {
        evaluate: async () => ({
          decision: "allow",
          reason: "fixture",
          usage: null,
          resolvedModel: null,
        }),
      },
    }),
    deliver: async () => {
      sent++;
    },
  });

  session.setDraft("alice", mail);

  const tools = createMailTools(session, "alice");

  assert.deepEqual(Object.keys(tools), ["sendEmail"]);

  async function propose(input: unknown) {
    return generateText({
      model: new MockLanguageModelV3({
        doGenerate: {
          content: [
            {
              type: "tool-call",
              toolCallId: "mail-1",
              toolName: "sendEmail",
              input: JSON.stringify(input),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
          warnings: [],
        },
      }),
      tools,
      prompt: "Process this email",
      maxRetries: 0,
    });
  }

  const blocked = await propose(mail);

  assert.equal(blocked.staticToolResults[0]?.output.status, "blocked");

  const display = session.requestSend("alice");

  session.approve("alice", display.version);

  const forged = await propose({ ...mail, approved: true, actor: "alice" });

  assert.equal(forged.staticToolResults.length, 0);
  assert.equal(sent, 0);

  const allowed = await propose(mail);

  assert.equal(allowed.staticToolResults[0]?.output.status, "sent");
  session.cancel("alice");
  assert.equal((await propose(mail)).staticToolResults[0]?.output.status, "blocked");
  assert.equal(sent, 1);
});
