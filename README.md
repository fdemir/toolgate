# Toolgate

Check an agent's proposed tool call against the user's request **before execution**.

Toolgate is an experimental, open-source TypeScript project powered by Jev. It includes a small execution SDK, an AI SDK adapter, runnable AI SDK and LangGraph examples, and a `given → expected → actual` evaluation CLI. No dashboard or comparison providers.

- `allow`: execute the checked arguments.
- `block`: stop; approval cannot override this decision.
- `review`: stop unless a trusted application approval handler explicitly approves.
- Guard error or timeout: stop, with an error distinct from a model decision.

## Run locally

Requires Node.js 24+ and pnpm 10.33.2.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm demo
pnpm demo:langgraph
pnpm demo:mail
```

Both demos run offline. The AI SDK demo uses a scripted model, scripted guard decisions and an in-memory email tool; the actual AI SDK dispatches the calls. The LangGraph demo pauses for review and resumes with a clearly labeled scripted approval. Neither sends mail. These demos prove execution wiring, not model accuracy.

To use live Jev, copy `.env.example` to `.env` and set `TYPESAFE_API_KEY`:

```sh
pnpm demo --live
pnpm demo --live --interactive
pnpm evaluate --split all
```

`--interactive` asks you to approve the exact call when Jev returns `review`. Live commands send supplied context to Jev and incur API usage. The default demo never contacts Jev, even when a key exists.

The [mail consent walkthrough](docs/mail.md) covers draft-only requests, exact-content approval, changed recipients, revocation, expiry and duplicate-send prevention. Run `pnpm demo:mail --live` for Jev and `pnpm evaluate:mail` for the separate 24-case evaluation.

## Use with AI SDK

Wrap your server-side tools once per authenticated request, then pass them to `generateText` or `streamText`:

```ts
import { createGate, createJevClient } from "@toolgate/core";
import { guardTools } from "@toolgate/ai-sdk";

const gate = createGate({
  client: createJevClient({ apiKey: process.env.TYPESAFE_API_KEY! }),
});

const tools = guardTools(existingTools, {
  gate,
  getContext: () => ({
    userRequest: authenticatedUserRequest,
    context: [],
    policies: { instructions: ["Only send emails when explicitly requested."], tools: {} },
  }),
});
// generateText({ model, messages, tools });
```

The variables `existingTools`, `authenticatedUserRequest`, `model`, and `messages` belong to your application. A complete executable example is in [apps/demo](apps/demo/src/scenarios.ts).

Without `onReview`, review decisions become tool errors and the action remains unexecuted. A provided `onReview` must obtain authenticated human approval, not ask the agent to approve itself. [Integration details](docs/integration.md) cover approval, cancellation, tool errors, and LangGraph.

## Evaluate your scenarios

```sh
pnpm validate
pnpm bench inspect --limit 1
pnpm evaluate --split dev --limit 6
pnpm evaluate --dataset ./my-cases.jsonl --split all --out reports/my-run
```

Each JSONL example contains `given`, `expected`, and labeling metadata. Only `given` reaches Jev; labels stay local. Reports include each actual decision, unsafe misses, incorrect blocks, review rate, p50/p95 latency, usage and estimated cost. The CLI never executes scenario tools.

See the [72-case dataset](datasets/README.md) and [methodology](docs/methodology.md). The starter dataset is synthetic and has not been independently human-annotated.

## Workspace

| Path                  | Purpose                                             |
| --------------------- | --------------------------------------------------- |
| `packages/core`       | Jev client and framework-independent execution gate |
| `packages/ai-sdk`     | Typed AI SDK 6 tool wrapper                         |
| `packages/eval`       | Evaluation CLI and reports                          |
| `packages/config`     | Shared strict TypeScript configuration              |
| `apps/demo`           | AI SDK execution and interactive approval example   |
| `apps/langgraph-demo` | LangGraph checkpoint / interrupt / resume example   |

Uses pnpm workspaces, Turborepo, Oxlint, Prettier, and Node's test runner. CI is offline.

```sh
pnpm check  # lint, types, tests, build, dataset validation
pnpm lint:fix
```

Run the CLI from this repository with `pnpm bench`. CLI exit codes: `0` completed (mismatches are reported), `1` invalid setup, `2` evaluation errors.

## Scope

Jev is a probabilistic check, not an authorization system or sandbox. Keep your application's permissions, argument validation, and transaction limits. Policies supplied to Jev are model context, not hard-enforced business rules. Guarded tools accept JSON-object inputs. Provider-executed tools and tools with input lifecycle hooks are rejected; client-executed tools are outside this adapter's scope.

Toolgate only controls calls routed through it. An agent must not also receive the unwrapped executor. No automatic retries or approval reuse are provided. [Security and data handling](SECURITY.md).

MIT licensed.
