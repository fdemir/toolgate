import { z } from "zod";
import type { Gate, GuardInput, CheckResult } from "@toolgate/core";

export const mailSchema = z.strictObject({ to: z.email(), subject: z.string(), body: z.string() });

export type Mail = z.infer<typeof mailSchema>;

export type SendResult = {
  status: "sent" | "blocked" | "review" | "error";
  reason: string;
  check?: CheckResult;
};

/** Application-owned consent. Never expose approve/requestSend/cancel as agent tools. */
export function createMailSession(options: {
  owner: string;
  gate: Gate;
  deliver: (mail: Mail) => Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let draft: Mail | undefined;
  let version = 0;
  let requested = false;
  let cancelled = false;
  let consumed = false;
  let approval: { version: number; expiresAt: number } | undefined;

  function authenticate(actor: string) {
    if (actor !== options.owner) throw new Error("Wrong session owner.");
  }

  function snapshot() {
    return { version, draft: draft ? structuredClone(draft) : null };
  }

  function setDraft(actor: string, value: Mail) {
    authenticate(actor);
    draft = mailSchema.parse(value);
    version++;
    approval = undefined;

    return snapshot();
  }

  function requestSend(actor: string) {
    authenticate(actor);

    if (!draft) throw new Error("Create a draft first.");

    requested = true;
    cancelled = false;
    consumed = false;
    approval = undefined;
    version++;

    return snapshot();
  }

  function approve(actor: string, displayedVersion: number) {
    authenticate(actor);

    if (!requested || cancelled || consumed || displayedVersion !== version) {
      throw new Error("This draft is no longer awaiting approval.");
    }

    approval = { version, expiresAt: now() + 60_000 };
  }

  function cancel(actor: string) {
    authenticate(actor);
    cancelled = true;
    approval = undefined;
    version++;
  }

  function permission(mail: Mail): SendResult | null {
    if (cancelled) return { status: "blocked", reason: "Sending was cancelled." };

    if (consumed)
      return { status: "blocked", reason: "This send authorization was already consumed." };

    if (!requested) return { status: "blocked", reason: "Only a draft was requested." };

    if (
      !draft ||
      mail.to !== draft.to ||
      mail.subject !== draft.subject ||
      mail.body !== draft.body
    ) {
      return { status: "review", reason: "Recipient or content differs from the displayed draft." };
    }

    if (!approval || approval.version !== version || approval.expiresAt <= now()) {
      return { status: "review", reason: "Approve the current draft before sending." };
    }

    return null;
  }

  async function send(actor: string, proposed: Mail, signal?: AbortSignal): Promise<SendResult> {
    authenticate(actor);

    const mail = mailSchema.parse(proposed);
    const denied = permission(mail);

    if (denied) return denied;

    const checkedVersion = version;
    const given: GuardInput = {
      userRequest: "Send the exact email I approved.",
      toolCall: { name: "mail.send", arguments: mail },
      context: [
        {
          source: "application",
          content: JSON.stringify({
            draft,
            version,
            approval:
              "The authenticated user approved this exact draft once. This approval is currently valid.",
          }),
        },
      ],
      policies: {
        instructions: [
          "Only send the exact approved recipient, subject and body. Approval is single-use and revocable.",
        ],
        tools: { "mail.send": { description: "Send an email immediately.", fields: {} } },
      },
    };
    const check = await options.gate.check(given, signal ? { signal } : {});

    if (check.status === "error" || signal?.aborted)
      return { status: "error", reason: "Guard failed or request cancelled.", check };

    if (check.decision !== "allow")
      return {
        status: check.decision === "block" ? "blocked" : "review",
        reason: "Jev did not allow this call.",
        check,
      };

    const changed = permission(mail);

    if (changed) return { ...changed, check };

    if (checkedVersion !== version)
      return { status: "review", reason: "Authorization changed during evaluation.", check };

    // Reserve synchronously before awaiting delivery: parallel calls cannot spend consent twice.
    consumed = true;
    approval = undefined;
    await options.deliver(structuredClone(mail));

    return { status: "sent", reason: "Approved email sent once.", check };
  }

  return { snapshot, setDraft, requestSend, approve, cancel, send };
}
