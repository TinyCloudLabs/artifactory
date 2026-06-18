export const repoCommands = {
  lint: null,
  test: "bun test tests/agent-runner.test.ts tests/listen-read-lib.test.ts && bunx tsc --noEmit",
  coverage: null,
} as const;

export default { repoCommands };
