/**
 * Milestone 1(b) evidence run: a Circle Agent Wallet on Arc TESTNET submits three proposals to the
 * Mandate contract. One is inside the customer's limits and executes; one is over the per-order
 * cap and one names a recipient outside the allowlist, and both are rejected with a hash.
 *
 *   pnpm m1b:agent
 *       The test wallet (TEST_SOURCE_PRIVATE_KEY, faucet funds only) plays the customer: it grants
 *       the allowance and sets the mandate, then the Agent Wallet submits the proposals.
 *
 *   pnpm m1b:agent --customer 0x… --recipient 0x…
 *       The mandate was already set by the customer's own wallet (for example a Circle
 *       user-controlled wallet, from the demo page). Nothing is signed for the customer here.
 *
 * The Agent Wallet is signed for by Circle through the Circle CLI; this script holds no key for
 * it. It needs `circle wallet login <email> --testnet` to have been done by the wallet's owner.
 *
 * Sends TESTNET transactions only and refuses any other chain id.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { circleCli, listArgs, parseAgentWallet, submitProposal, type ProposalOutcome } from "@promorphic/agent";
import {
  ARC_TESTNET,
  MANDATE_ARC_TESTNET,
  baseUnitsToUsdc,
  erc20Abi,
  explorerTxUrl,
  mandateAbi,
  readTerms,
  transportFor,
  usdcToBaseUnits,
  viemChain,
  type Address,
} from "@promorphic/router";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "..");
const chain = viemChain(ARC_TESTNET);
const transport = transportFor(ARC_TESTNET);
const client = createPublicClient({ chain, transport });
if ((await client.getChainId()) !== ARC_TESTNET.chainId) fail("refusing to run: the RPC endpoint is not Arc testnet");

const USDC = ARC_TESTNET.usdc;
const MANDATE = MANDATE_ARC_TESTNET.address;
const cli = circleCli(repoRoot);

const agentWallet = (process.env.ARC_AGENT_WALLET_ADDRESS as Address | undefined) || parseAgentWallet(await cli(listArgs("ARC-TESTNET")), "ARC-TESTNET");
if (!agentWallet) fail("no Circle Agent Wallet on ARC-TESTNET. The wallet's owner runs: pnpm exec circle wallet login <email> --testnet");

const evidence: { milestone: string; chain: string; what: string; txHash: Hex; url: string; proves: string }[] = [];
const note = (what: string, txHash: Hex, proves: string) => {
  evidence.push({ milestone: "M1(b)", chain: ARC_TESTNET.name, what, txHash, url: explorerTxUrl(ARC_TESTNET, txHash), proves });
  console.log(`${what}\n  ${explorerTxUrl(ARC_TESTNET, txHash)}\n  ${proves}\n`);
};

let customer: Address;
let recipient: Address;
let customerLabel: string;

if (arg("customer")) {
  customer = arg("customer") as Address;
  recipient = (arg("recipient") as Address | undefined) ?? fail("--recipient is required with --customer: an address on that mandate's allowlist");
  customerLabel = "the customer's own wallet";
} else {
  // The test wallet plays the customer. It holds faucet funds only.
  const key = process.env.TEST_SOURCE_PRIVATE_KEY ?? fail("TEST_SOURCE_PRIVATE_KEY is not set (or pass --customer and --recipient)");
  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain, transport });
  customer = account.address;
  customerLabel = "a test wallet standing in for the customer";
  // A throwaway address stands in for an issuer's settlement address; its key is discarded.
  recipient = (process.env.M1B_RECIPIENT as Address | undefined) || privateKeyToAccount(generatePrivateKey()).address;

  const perOrderCap = usdcToBaseUnits(arg("per-order") ?? "2");
  const dailyCap = usdcToBaseUnits(arg("daily") ?? "5");
  const mined = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") fail(`transaction ${hash} failed`);
    return hash;
  };
  const approveHash = await mined(await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [MANDATE, dailyCap] }));
  note("USDC allowance granted to the Mandate contract", approveHash, `Customer ${customer} (${customerLabel}) allows the Mandate contract to move at most ${baseUnitsToUsdc(dailyCap)} USDC. Funds stay in the customer's wallet.`);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  const setHash = await mined(
    await wallet.writeContract({ address: MANDATE, abi: mandateAbi, functionName: "setMandate", args: [agentWallet, USDC, 1, perOrderCap, dailyCap, expiry, [USDC], [recipient]] }),
  );
  note(
    "Mandate set by the customer (Mandate.setMandate)",
    setHash,
    `Customer ${customer} (${customerLabel}) named the Circle Agent Wallet ${agentWallet} as agent: per-order cap ${baseUnitsToUsdc(perOrderCap)} USDC, rolling daily cap ${baseUnitsToUsdc(dailyCap)} USDC, recipient allowlist [${recipient}], expiry ${new Date(Number(expiry) * 1000).toISOString()}.`,
  );
}

const terms = (await readTerms(customer, { client })) ?? fail(`${customer} has no mandate`);
if (terms.revoked) fail("the mandate is revoked");
if (terms.agent.toLowerCase() !== agentWallet.toLowerCase()) fail(`the mandate names agent ${terms.agent}, not the Agent Wallet ${agentWallet}`);

const balance = (who: Address) => client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const run = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const stranger = privateKeyToAccount(generatePrivateKey()).address;
const inLimit = terms.perOrderCap < usdcToBaseUnits("1") ? terms.perOrderCap : usdcToBaseUnits("1");
const overCap = terms.perOrderCap + usdcToBaseUnits("1");
const target = { agentWallet, mandate: MANDATE, chain: "ARC-TESTNET" as const };

async function propose(label: string, to: Address, amount: bigint): Promise<ProposalOutcome & { moved: bigint }> {
  const before = await balance(to);
  const outcome = await submitProposal({ customer, reference: `m1b-${run}-${label}`, asset: USDC, recipient: to, amount }, target, { cli, client });
  return { ...outcome, moved: (await balance(to)) - before };
}

const a = await propose("in-limit", recipient, inLimit);
if (a.outcome !== "ProposalExecuted" || a.moved !== inLimit) fail(`expected the in-limit proposal to execute, got ${a.outcome} (${a.reason})`);
note(
  "Agent Wallet proposal inside the limits: executed",
  a.txHash,
  `The Circle Agent Wallet ${agentWallet} submitted "${a.reference}" for ${baseUnitsToUsdc(inLimit)} USDC (per-order cap ${baseUnitsToUsdc(terms.perOrderCap)}). The Mandate contract moved it from customer ${customer} straight to the allowlisted recipient ${recipient}. The Agent Wallet never held the customer's USDC.`,
);

const b = await propose("over-cap", recipient, overCap);
if (b.outcome !== "ProposalRejected" || b.reason !== "OverPerOrderCap" || b.moved !== 0n) fail(`expected OverPerOrderCap, got ${b.outcome} (${b.reason})`);
note(
  "Agent Wallet proposal over the per-order cap: rejected",
  b.txHash,
  `The same Agent Wallet submitted "${b.reference}" for ${baseUnitsToUsdc(overCap)} USDC against a cap of ${baseUnitsToUsdc(terms.perOrderCap)}. The contract recorded ProposalRejected with reason OverPerOrderCap; the transaction succeeded and nothing moved.`,
);

const c = await propose("not-allowlisted", stranger, inLimit);
if (c.outcome !== "ProposalRejected" || c.reason !== "RecipientNotAllowed" || c.moved !== 0n) fail(`expected RecipientNotAllowed, got ${c.outcome} (${c.reason})`);
note(
  "Agent Wallet proposal to a recipient outside the allowlist: rejected",
  c.txHash,
  `The same Agent Wallet submitted "${c.reference}" paying ${stranger}, which is not on the customer's allowlist. The contract recorded ProposalRejected with reason RecipientNotAllowed; nothing moved.`,
);

// Append to the evidence file the demo server also writes.
const evidencePath = resolve(repoRoot, "evidence/m1.json");
mkdirSync(dirname(evidencePath), { recursive: true });
const all = existsSync(evidencePath) ? (JSON.parse(readFileSync(evidencePath, "utf8")) as unknown[]) : [];
const date = new Date().toISOString();
writeFileSync(evidencePath, `${JSON.stringify([...all, ...evidence.map((e) => ({ date, ...e }))], null, 2)}\n`);
console.log(`wrote ${evidence.length} entries to evidence/m1.json. Audit record: pnpm record ${customer}`);
