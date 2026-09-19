# Contributing

Use Node.js 24+ and pnpm 10.33.2. Run `pnpm install --frozen-lockfile`, then `pnpm check`. CI and tests do not call paid APIs. `pnpm demo` demonstrates execution using explicit stubs; `pnpm demo --live` and `pnpm evaluate` make paid Jev requests.

Use the shared TypeScript configuration, Oxlint and Prettier. Keep packages focused and document changes to execution semantics. Add behavior tests when changing allow/block/review, approval, cancellation, or report calculations.

Label new scenarios before running Jev. Keep related variants in the same split, preserve failures in reports, and distinguish live results from stubs. Do not commit API keys or private scenario data.

Run `pnpm build` before using `pnpm bench`.
