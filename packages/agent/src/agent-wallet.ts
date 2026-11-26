/**
 * Submits proposals to the Mandate contract from a Circle Agent Wallet, through the Circle CLI.
 *
 * The agent process holds no key. It asks the CLI to have Circle sign `Mandate.execute(...)` from
 * the Agent Wallet; the contract then decides. A proposal outside the mandate is not a failed
 * transaction: the contract records a `ProposalRejected` event, so the refusal has a hash.
 *
 * CLI reference (`@circle-fin/cli` 1.4.0, `circle wallet execute --help`):
 * https://developers.circle.com/agent-stack/agent-wallets/quickstart
 */
import { execFile } from "node:child_process";
import { parseEventLogs, type Hex, type Log } from "viem";
import { MANDATE_REASONS, mandateAbi, proposalId, type Address, type MandateReason } from "@promorphic/router";

/** The Mandate function the agent calls. Kept as text because the CLI takes a signature string. */
export const EXECUTE_SIGNATURE = "execute(address,bytes32,address,address,uint256)";

/** Only testnets: this module refuses to build a command for any other chain. */
export const AGENT_TESTNET_CHAINS = ["ARC-TESTNET"] as const;
export type AgentChain = (typeof AGENT_TESTNET_CHAINS)[number];

export interface Proposal {
  customer: Address;
  /** Human-readable reference; its hash is the on-chain proposal id. */
  reference: string;
  asset: Address;
  recipient: Address;
  /** Settlement-token base units. */
  amount: bigint;
}

export interface AgentWalletTarget {
  agentWallet: Address;
  mandate: Address;
  chain: AgentChain;
}

/** The two chain reads this module needs. A viem public client satisfies it; so does a test fake. */
export interface ChainReader {
  getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint | "latest" }): Promise<Log[]>;
  getBlockNumber(): Promise<bigint>;
}

/** Runs the Circle CLI with these arguments and returns its stdout. */
export type CliRunner = (args: string[]) => Promise<string>;

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

/** Arguments for `circle wallet execute` that submit one proposal. Pure, so it can be tested. */
export function executeArgs(p: Proposal, t: AgentWalletTarget): string[] {
  if (!(AGENT_TESTNET_CHAINS as readonly string[]).includes(t.chain)) throw new Error(`refusing chain ${t.chain}: testnet only`);
  for (const [name, value] of Object.entries({ customer: p.customer, asset: p.asset, recipient: p.recipient, agentWallet: t.agentWallet, mandate: t.mandate })) {
    if (!isAddress(value)) throw new Error(`${name} is not an address: ${value}`);
  }
  if (p.amount <= 0n) throw new Error("amount must be positive");
  if (!p.reference) throw new Error("a proposal needs a reference");
  return [
    "wallet",
    "execute",
    EXECUTE_SIGNATURE,
    p.customer,
    proposalId(p.reference),
    p.asset,
    p.recipient,
    p.amount.toString(),
    "--contract",
    t.mandate,
    "--address",
    t.agentWallet,
    "--chain",
    t.chain,
    "--output",
    "json",
  ];
}

/** Arguments for `circle wallet list` that return the Agent Wallet on one chain. */
export function listArgs(chain: AgentChain): string[] {
  return ["wallet", "list", "--type", "agent", "--chain", chain, "--output", "json"];
}

/** The Agent Wallet address on `chain` from `circle wallet list --output json`, if there is one. */
export function parseAgentWallet(stdout: string, chain: AgentChain): Address | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const wallets = (parsed as { data?: { wallets?: { type?: string; address?: string; blockchain?: string }[] } }).data?.wallets ?? [];
  const match = wallets.find((w) => w.type === "agent" && w.blockchain === chain && w.address && isAddress(w.address));
  return match?.address as Address | undefined;
}

/** The CLI's error message, if its JSON output is an error. */
export function parseCliError(stdout: string): string | undefined {
  try {
    return (JSON.parse(stdout) as { error?: { message?: string } }).error?.message;
  } catch {
    return undefined;
  }
}

/** Runs the Circle CLI installed in this repository. Resolves with stdout even on a non-zero exit, so errors can be read as JSON. */
export function circleCli(cwd: string): CliRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("pnpm", ["exec", "circle", ...args], { cwd, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }, timeout: 120_000 }, (error, stdout, stderr) => {
        const jsonStart = stdout.indexOf("{");
        if (jsonStart !== -1) return resolve(stdout.slice(jsonStart));
        if (error) return reject(new Error(`circle ${args.slice(0, 2).join(" ")} failed: ${(stderr || error.message).trim().split("\n")[0]}`));
        resolve(stdout);
      });
    });
}

export interface ProposalOutcome {
  reference: string;
  proposalId: Hex;
  outcome: "ProposalExecuted" | "ProposalRejected";
  reason: MandateReason;
  txHash: Hex;
  blockNumber: bigint;
  /** The address the contract saw as the caller. Must be the Agent Wallet. */
  agent: Address;
}

/**
 * Finds what the Mandate contract recorded for a proposal. The contract's event log is the source
 * of truth, so this does not depend on what the CLI prints.
 */
export async function findOutcome(
  client: Pick<ChainReader, "getLogs">,
  p: Pick<Proposal, "customer" | "reference">,
  opts: { mandate: Address; fromBlock: bigint; toBlock?: bigint },
): Promise<ProposalOutcome | undefined> {
  const id = proposalId(p.reference);
  const logs = await client.getLogs({ address: opts.mandate, fromBlock: opts.fromBlock, toBlock: opts.toBlock ?? "latest" });
  const events = parseEventLogs({ abi: mandateAbi, logs, eventName: ["ProposalExecuted", "ProposalRejected"] });
  const event = events.find((e) => e.args.proposalId === id && e.args.customer.toLowerCase() === p.customer.toLowerCase());
  if (!event) return undefined;
  return {
    reference: p.reference,
    proposalId: id,
    outcome: event.eventName,
    reason: event.eventName === "ProposalRejected" ? (MANDATE_REASONS[Number(event.args.reason)] ?? "None") : "None",
    txHash: event.transactionHash,
    blockNumber: event.blockNumber,
    agent: event.args.agent,
  };
}

/**
 * Submits one proposal from the Agent Wallet and waits for the contract's decision.
 * Throws if the CLI reports an error or no decision appears in time.
 */
export async function submitProposal(
  p: Proposal,
  t: AgentWalletTarget,
  deps: { cli: CliRunner; client: ChainReader; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<ProposalOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fromBlock = await deps.client.getBlockNumber();
  const stdout = await deps.cli(executeArgs(p, t));
  const cliError = parseCliError(stdout);
  if (cliError) throw new Error(`Circle refused the request before signing: ${cliError}`);
  const deadline = Date.now() + (deps.timeoutMs ?? 90_000);
  for (;;) {
    const outcome = await findOutcome(deps.client, p, { mandate: t.mandate, fromBlock });
    if (outcome) {
      if (outcome.agent.toLowerCase() !== t.agentWallet.toLowerCase()) throw new Error(`proposal was submitted by ${outcome.agent}, not the Agent Wallet`);
      return outcome;
    }
    if (Date.now() > deadline) throw new Error(`no decision recorded for "${p.reference}" within the timeout`);
    await sleep(deps.pollMs ?? 2_000);
  }
}
