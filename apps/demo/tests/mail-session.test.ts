import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate } from "@toolgate/core";
import type { GuardResult } from "@toolgate/core";
import { createMailSession } from "../src/mail-session.ts";

const mail = { to: "ada@example.com", subject: "Meeting", body: "Tomorrow at 10." };
const allow = (): GuardResult => ({
  decision: "allow",
  reason: "fixture",
  usage: null,
  resolvedModel: null,
});

function setup(evaluate = async () => allow()) {
  const sent: unknown[] = [];
  let clock = 0;
  const session = createMailSession({
    owner: "alice",
    gate: createGate({ client: { evaluate } }),
    deliver: async (value) => {
      sent.push(value);
    },
    now: () => clock,
  });

  session.setDraft("alice", mail);

  return {
    session,
    sent,
    advance: () => {
      clock += 60_001;
    },
  };
}

function approve(session: ReturnType<typeof setup>["session"]) {
  const displayed = session.requestSend("alice");

  session.approve("alice", displayed.version);
}

test("draft → send request → approval → exactly one send", async () => {
  const { session, sent } = setup();

  assert.equal((await session.send("alice", mail)).status, "blocked");

  const displayed = session.requestSend("alice");

  assert.equal((await session.send("alice", mail)).status, "review");
  session.approve("alice", displayed.version);
  assert.equal((await session.send("alice", mail)).status, "sent");
  assert.equal((await session.send("alice", mail)).status, "blocked");
  assert.deepEqual(sent, [mail]);
});

for (const field of ["to", "subject", "body"] as const) {
  test(`changed ${field} needs fresh approval even when Jev would allow`, async () => {
    const { session, sent } = setup();

    approve(session);

    const changed = { ...mail, [field]: field === "to" ? "eve@example.com" : "Changed" };

    assert.equal((await session.send("alice", changed)).status, "review");

    const oldVersion = session.snapshot().version;

    session.setDraft("alice", changed);
    assert.throws(() => session.approve("alice", oldVersion));
    assert.equal((await session.send("alice", changed)).status, "review");
    session.approve("alice", session.snapshot().version);
    assert.equal((await session.send("alice", changed)).status, "sent");
    assert.deepEqual(sent, [changed]);
  });
}

test("revocation, expiration and wrong user cannot spend approval", async () => {
  const { session, sent, advance } = setup();

  approve(session);
  await assert.rejects(session.send("bob", mail), /owner/);
  assert.throws(() => session.approve("bob", session.snapshot().version), /owner/);
  advance();
  assert.equal((await session.send("alice", mail)).status, "review");
  session.approve("alice", session.snapshot().version);
  session.cancel("alice");
  assert.equal((await session.send("alice", mail)).status, "blocked");
  assert.equal(sent.length, 0);
});
test("cancellation and draft replacement during Jev evaluation invalidate the pending call", async () => {
  for (const cancel of [true, false]) {
    let release!: (result: GuardResult) => void;
    const { session, sent } = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    approve(session);

    const pending = session.send("alice", mail);

    await new Promise((resolve) => setImmediate(resolve));

    if (cancel) session.cancel("alice");
    else session.setDraft("alice", { ...mail, body: "New body" });

    release(allow());
    assert.notEqual((await pending).status, "sent");
    assert.equal(sent.length, 0);
  }
});
test("parallel sends spend consent once", async () => {
  const { session, sent } = setup();

  approve(session);

  const outcomes = await Promise.all([session.send("alice", mail), session.send("alice", mail)]);

  assert.equal(outcomes.filter((r) => r.status === "sent").length, 1);
  assert.equal(sent.length, 1);
});
test("guard review, block and failure stop an approved send", async () => {
  for (const decision of ["review", "block", "error"] as const) {
    const { session, sent } = setup(async () => {
      if (decision === "error") throw new Error("unavailable");

      return { ...allow(), decision };
    });

    approve(session);
    assert.notEqual((await session.send("alice", mail)).status, "sent");
    assert.equal(sent.length, 0);
  }
});
test("ambiguous delivery failure consumes consent rather than retrying a possible side effect", async () => {
  let calls = 0;
  const session = createMailSession({
    owner: "alice",
    gate: createGate({ client: { evaluate: async () => allow() } }),
    deliver: async () => {
      calls++;
      throw new Error("delivery uncertain");
    },
  });

  session.setDraft("alice", mail);
  approve(session);
  await assert.rejects(session.send("alice", mail), /delivery uncertain/);
  assert.equal((await session.send("alice", mail)).status, "blocked");
  assert.equal(calls, 1);
});
