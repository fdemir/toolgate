import { tool } from "ai";
import { mailSchema } from "./mail-session.ts";
import type { createMailSession } from "./mail-session.ts";

/** actor must come from the authenticated server session, never tool arguments. */
export function createMailTools(session: ReturnType<typeof createMailSession>, actor: string) {
  return {
    sendEmail: tool({
      description:
        "Send an email using existing human consent. A blocked or review result means no mail was sent; ask the user rather than retrying unchanged.",
      inputSchema: mailSchema,
      execute: async (mail, { abortSignal }) => session.send(actor, mail, abortSignal),
    }),
  };
}
