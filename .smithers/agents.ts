// smithers-source: generated
import { type AgentLike, ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smithers-orchestrator";
import { ClaudeCodeAgent } from "./agents/claude-code";
import { CodexAgent } from "./agents/codex";

export { ClaudeCodeAgent } from "./agents/claude-code";
export { CodexAgent } from "./agents/codex";

export const providers = {
  claude: ClaudeCodeAgent,
  codex: CodexAgent,
  claudeOpus: new SmithersClaudeCodeAgent({ model: "claude-opus-4-8", cwd: process.cwd() }),
  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
} as const;

export const agents = {
  cheapFast: [providers.claudeSonnet],
  smart: [providers.claude, providers.claudeOpus, providers.codex],
  smartTool: [providers.claude, providers.claudeOpus, providers.codex],
} as const satisfies Record<string, AgentLike[]>;
