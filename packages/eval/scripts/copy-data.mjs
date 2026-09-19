import { copyFile, mkdir, chmod } from "node:fs/promises";

await mkdir(new URL("../dist/data/", import.meta.url), { recursive: true });
await copyFile(
  new URL("../../../datasets/core.jsonl", import.meta.url),
  new URL("../dist/data/core.jsonl", import.meta.url),
);
await copyFile(
  new URL("../../../benchmark.config.json", import.meta.url),
  new URL("../dist/data/benchmark.config.json", import.meta.url),
);
await chmod(new URL("../dist/cli.js", import.meta.url), 0o755);
