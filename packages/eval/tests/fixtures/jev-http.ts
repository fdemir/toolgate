// Only preloaded by CLI tests. No network request is made.
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      model: "mock-jev",
      usage: { input_tokens: 100, output_tokens: 5 },
      answers: {
        decision: {
          type: "choice",
          choice: "block",
          probabilities: { allow: 0, block: 1, review: 0 },
          confidence: 1,
        },
      },
    }),
    { status: process.env.TOOLGATE_TEST_HTTP_FAILURE === "1" ? 503 : 200 },
  );
