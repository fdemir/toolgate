# Security and data handling

Toolgate is experimental. Its model decision can be wrong. Keep application authorization and business constraints outside the model.

- Obtain `userRequest`, application context and policies from trusted application state. Model messages or retrieved documents must not grant themselves authority.
- Label webpage/document/tool text as untrusted context. Do not label it `application` merely because your application retrieved it.
- Jev receives the complete supplied `given`, including arguments and context. Minimize sensitive data before calling the guard. The library does not redact PII.
- Reports contain complete evaluation inputs. Use synthetic or sanitized examples before sharing reports.
- The SDK does not write logs or persist approval records. Provider errors are sanitized; the raw error response and API key are not included in guard results.
- Credentials live in environment variables. `.env`, local reports and build outputs are ignored by Git.
- Guard and approval failures stop execution. Tool-side errors are never retried automatically.
- Approval callbacks and LangGraph resume routes are trusted application code. Require an authenticated human and bind consent to the exact call and user. The model must not control them.

There is no sandbox, durable approval store, distributed exactly-once execution, or guarantee of detecting all malicious instructions. An unwrapped tool path bypasses the guard.

Do not include secrets or private user data in a public issue. This local starter repository has no published private vulnerability-reporting channel yet.
