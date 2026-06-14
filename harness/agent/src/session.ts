// session.ts — the agent's identity + active-delegation state. Holds ONE
// long-lived TinyCloudNode signed in with the stable agent key (→ did:pkh), and
// activates a user's PortableDelegation into a sandboxed tc profile the skills
// run under. Adapted from Listen's delegation-endpoint SidecarState/bootstrap.
//
// Activation flow (POST /agent/delegation):
//   deserialize → node.useDelegation(delegation) → access.restorable →
//   writeDelegatedProfile(sandbox HOME) → persist serialized for restart.
// After this, `tc --profile <name>` (HOME=sandbox) operates as the delegator on
// the delegator's space — the run-under-delegation guarantee, no owner keys.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
  DelegatedAccess,
  PortableDelegation,
  TinyCloudNode,
} from "@tinycloud/node-sdk";
import { config } from "./config.ts";
import { ensureAgentKey } from "./agent-key.ts";
import { loadNodeSdk } from "./node-sdk.ts";
import { extractRestorable, writeDelegatedProfile } from "./profile-writer.ts";

export interface ActiveDelegation {
  delegation: PortableDelegation;
  delegationCid: string;
  spaceId: string;
  /** ISO string of the delegation's expiry. */
  expiresAt: string;
  grantedAt: number;
}

export class AgentSession {
  private node!: TinyCloudNode;
  readonly agentAddress: string;
  readonly agentDid: string;
  private active: ActiveDelegation | null = null;
  private deserialize!: (s: string) => PortableDelegation;

  private constructor(node: TinyCloudNode, agentAddress: string) {
    this.node = node;
    this.agentAddress = agentAddress;
    this.agentDid = `did:pkh:eip155:1:${agentAddress}`;
  }

  /** Boot the agent: ensure the key, sign the node in, restore a persisted delegation. */
  static async bootstrap(): Promise<AgentSession> {
    mkdirSync(config.agentStateDir, { recursive: true });

    const sdk = await loadNodeSdk();
    const { key, generated } = ensureAgentKey(config.agentKeyPath);
    if (generated) console.log(`[agent] generated new agent key at ${config.agentKeyPath}`);

    const agentAddress = await new sdk.PrivateKeySigner(key.privateKey).getAddress();

    const node = new sdk.TinyCloudNode({
      privateKey: key.privateKey,
      host: config.host,
      prefix: process.env.TC_AGENT_PREFIX ?? "distillery-agent",
      autoCreateSpace: false,
    });
    await node.signIn();

    const session = new AgentSession(node, agentAddress);
    session.deserialize = sdk.deserializeDelegation;

    // Restore a delegation persisted from a prior run (so a restart keeps the
    // sandbox profile valid without re-POSTing).
    const serialized = loadPersistedDelegation();
    if (serialized) {
      try {
        await session.activate(serialized);
        console.log(`[agent] restored delegation from disk (space=${session.active?.spaceId})`);
      } catch (err) {
        console.warn(`[agent] failed to restore persisted delegation:`, err);
      }
    }

    console.log("");
    console.log("==================================================================");
    console.log(`  Agent DID: ${session.agentDid}`);
    console.log("  Delegate to this DID from the feed front end's Connect page.");
    console.log("==================================================================");
    console.log("");

    return session;
  }

  getActive(): ActiveDelegation | null {
    return this.active;
  }

  /**
   * Activate a serialized PortableDelegation: mint a delegated session via
   * useDelegation, project it into the sandbox tc profile, persist for restart.
   * Throws (caller maps to HTTP 4xx/5xx) on a malformed or unusable delegation.
   */
  async activate(serialized: string): Promise<ActiveDelegation> {
    const delegation = this.deserialize(serialized);
    if (typeof delegation.chainId !== "number" || !Number.isFinite(delegation.chainId)) {
      throw new Error("Delegation is missing chainId.");
    }

    const access: DelegatedAccess = await this.node.useDelegation(delegation);
    const restorable = extractRestorable(access);

    writeDelegatedProfile({
      home: config.tcHome,
      profileName: config.profileName,
      host: config.host,
      agentAddress: this.agentAddress,
      delegation,
      restorable,
    });

    const active: ActiveDelegation = {
      delegation,
      delegationCid: delegation.cid,
      spaceId: delegation.spaceId,
      expiresAt: delegation.expiry.toISOString(),
      grantedAt: Date.now(),
    };
    this.active = active;
    persistDelegation(serialized);
    return active;
  }
}

function loadPersistedDelegation(): string | null {
  if (!existsSync(config.delegationPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(config.delegationPath, "utf-8")) as {
      serialized?: string;
    };
    return typeof parsed.serialized === "string" && parsed.serialized.length > 0
      ? parsed.serialized
      : null;
  } catch {
    return null;
  }
}

function persistDelegation(serialized: string): void {
  mkdirSync(config.agentStateDir, { recursive: true });
  writeFileSync(config.delegationPath, JSON.stringify({ serialized }, null, 2) + "\n", "utf-8");
}
