import { parseArgs } from "node:util";
import { createGate, createJevClient } from "@toolgate/core";
import { createMailSession } from "./mail-session.ts";

const { values } = parseArgs({ options: { live: { type: "boolean" } } });
const client = values.live
  ? createJevClient({ apiKey: process.env.TYPESAFE_API_KEY ?? "" })
  : {
      evaluate: async () => ({
        decision: "allow" as const,
        reason: "Always-allow stub tests application consent",
        usage: null,
        resolvedModel: "demo-stub",
      }),
    };
const sent: unknown[] = [];
const session = createMailSession({
  owner: "alice",
  gate: createGate({ client }),
  deliver: async (mail) => {
    sent.push(mail);
  },
});
const original = { to: "ada@example.com", subject: "Meeting", body: "Tomorrow at 10." };

console.log(
  values.live
    ? "LIVE Jev; scripted human events; in-memory mail delivery."
    : "OFFLINE; always-allow Jev stub; scripted human events; in-memory mail delivery.",
);
session.setDraft("alice", original);

async function attempt(step: string, mail = original) {
  const result = await session.send("alice", mail);

  console.log(JSON.stringify({ step, ...result, deliveredCount: sent.length }));

  if (result.status === "error") process.exitCode = 2;
}

await attempt("Only a draft was requested");

const displayed = session.requestSend("alice");

await attempt("Send requested; approval still missing");
session.approve("alice", displayed.version);
await attempt("Recipient changed after approval", { ...original, to: "eve@example.com" });
session.cancel("alice");
await attempt("User cancelled");

const renewed = session.requestSend("alice");

session.approve("alice", renewed.version);
await attempt("Fresh explicit approval for exact original draft");
await attempt("Duplicate send with the same approval");
