// Secret resolution for distillery skills.
//
// v1 is env-vars only. The canonical home for keys is the TinyCloud Secret
// Manager (secrets.tinycloud.xyz); they are copied into env vars / .env
// manually for now. Headless vault access is blocked today — the vault
// master key requires the root OpenKey passkey signature (user presence by
// design) — so vault integration is deferred. See SPEC.md, "Future:
// TinyCloud secrets vault integration".
//
// Structure: getSecret walks an ordered resolver chain. Adding the vault
// later means writing one resolver function and prepending it to RESOLVERS —
// no skill or call-site changes.
//
// Env precedence for GEMINI_API_KEY mirrors pulse-radio's resolveGeminiKey:
// GOOGLE_AI_API_KEY > GEMINI_API_KEY > GOOGLE_API_KEY. Any other secret
// resolves from the env var matching its exact name.

/**
 * Env-var aliases checked (in order) for a given canonical secret name.
 * Names without an alias entry are checked under their own name only.
 */
const ENV_ALIASES: Record<string, readonly string[]> = {
  GEMINI_API_KEY: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

interface Resolution {
  value?: string;
  /** Human-readable labels of every source this resolver tried. */
  attempted: string[];
}

type SecretResolver = (name: string) => Promise<Resolution>;

async function resolveFromEnv(name: string): Promise<Resolution> {
  const attempted: string[] = [];
  for (const envName of ENV_ALIASES[name] ?? [name]) {
    attempted.push(`env: ${envName}`);
    const value = process.env[envName]?.trim();
    if (value) return { value, attempted };
  }
  return { attempted };
}

// Ordered chain. When headless TinyCloud vault access lands, prepend its
// resolver here (vault key convention: "secrets/<NAME>" in the "secrets"
// space) — nothing else changes.
const RESOLVERS: readonly SecretResolver[] = [resolveFromEnv];

/**
 * Resolve a secret by canonical name through the resolver chain.
 * Throws with every attempted source listed when nothing resolves.
 */
export async function getSecret(name: string): Promise<string> {
  const attempted: string[] = [];
  for (const resolver of RESOLVERS) {
    const result = await resolver(name);
    attempted.push(...result.attempted);
    if (result.value) return result.value;
  }
  throw new Error(
    `Secret "${name}" not found. Attempted sources (in order):\n` +
      attempted.map((s) => `  - ${s}`).join("\n") +
      `\nFix: export one of the env vars above. Keys live in the TinyCloud ` +
      `Secret Manager (secrets.tinycloud.xyz) — copy manually for now.`,
  );
}
