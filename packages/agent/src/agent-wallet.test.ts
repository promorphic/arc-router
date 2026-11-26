import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { mandateAbi, proposalId } from "@promorphic/router";
import { EXECUTE_SIGNATURE, executeArgs, findOutcome, listArgs, parseAgentWallet, parseCliError, submitProposal, type Proposal } from "./agent-wallet.ts";

const CUSTOMER = getAddress("0x00000000000000000000000000000000000c0570");
const AGENT = getAddress("0x00000000000000000000000000000000000a6e47");
const OTHER = getAddress("0x000000000000000000000000000000000000beef");
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const ISSUER = getAddress("0x0000000000000000000000000000000000001550");
const MANDATE = getAddress("0x2d1cbbeea337a30df22c0446db2528b98b543d10");
const TARGET = { agentWallet: AGENT, mandate: MANDATE, chain: "ARC-TESTNET" as const };
const proposal: Proposal = { customer: CUSTOMER, reference: "order-1", asset: USDC, recipient: ISSUER, amount: 1_000_000n };

/** A Mandate event log as a node would return it. */
function log(kind: "ProposalExecuted" | "ProposalRejected", p: Proposal, opts: { agent?: Hex; reason?: number; block?: bigint } = {}): Log {
  const topics = encodeEventTopics({ abi: mandateAbi, eventName: kind, args: { customer: p.customer, proposalId: proposalId(p.reference), version: 1n } });
  const base = [opts.agent ?? AGENT, p.asset, p.recipient, p.amount] as const;
  const data =
    kind === "ProposalExecuted"
      ? encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], base)
      : encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }], [...base, opts.reason ?? 0]);
  return {
    address: MANDATE,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: opts.block ?? 100n,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}
const chainWith = (logs: Log[]) => ({ getLogs: async () => logs, getBlockNumber: async () => 99n });

describe("circle wallet execute arguments", () => {
  it("calls Mandate.execute from the Agent Wallet with the proposal's fields in order", () => {
    expect(executeArgs(proposal, TARGET)).toEqual([
      "wallet", "execute", EXECUTE_SIGNATURE,
      CUSTOMER, proposalId("order-1"), USDC, ISSUER, "1000000",
      "--contract", MANDATE, "--address", AGENT, "--chain", "ARC-TESTNET", "--output", "json",
    ]);
  });

  it("never sends native value and never targets anything but the Mandate contract", () => {
    const args = executeArgs(proposal, TARGET);
    expect(args).not.toContain("--amount");
    expect(args[args.indexOf("--contract") + 1]).toBe(MANDATE);
  });

  it("refuses a chain that is not a testnet", () => {
    expect(() => executeArgs(proposal, { ...TARGET, chain: "ARC" as never })).toThrow(/testnet only/);
    expect(() => executeArgs(proposal, { ...TARGET, chain: "ETH" as never })).toThrow(/testnet only/);
  });

  it("refuses malformed input before anything reaches Circle", () => {
    expect(() => executeArgs({ ...proposal, recipient: "0x123" as never }, TARGET)).toThrow(/recipient is not an address/);
    expect(() => executeArgs({ ...proposal, amount: 0n }, TARGET)).toThrow(/positive/);
    expect(() => executeArgs({ ...proposal, reference: "" }, TARGET)).toThrow(/reference/);
    // A flag smuggled in as an address is rejected, not passed to the CLI.
    expect(() => executeArgs({ ...proposal, customer: "--rpc-url" as never }, TARGET)).toThrow(/customer is not an address/);
  });
});

describe("circle wallet list output", () => {
  const listed = (wallets: unknown[]) => JSON.stringify({ data: { wallets } });

  it("asks for agent wallets on the one chain, as JSON", () => {
    expect(listArgs("ARC-TESTNET")).toEqual(["wallet", "list", "--type", "agent", "--chain", "ARC-TESTNET", "--output", "json"]);
  });

  it("finds the Agent Wallet on the chain asked for", () => {
    const out = listed([
      { type: "local", address: OTHER, blockchain: "ARC-TESTNET" },
      { type: "agent", address: OTHER, blockchain: "BASE-SEPOLIA" },
      { type: "agent", address: AGENT, blockchain: "ARC-TESTNET", createDate: "2026-11-26T14:55:45Z" },
    ]);
    expect(parseAgentWallet(out, "ARC-TESTNET")).toBe(AGENT);
  });

  it("returns nothing when not logged in, when there is no wallet, or when the output is not JSON", () => {
    expect(parseAgentWallet(listed([]), "ARC-TESTNET")).toBeUndefined();
    expect(parseAgentWallet(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Not logged in" } }), "ARC-TESTNET")).toBeUndefined();
    expect(parseAgentWallet("Not logged in. See 0x00000000000000000000000000000000000a6e47", "ARC-TESTNET")).toBeUndefined();
  });

  it("reads the CLI's error message", () => {
    expect(parseCliError(JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: "Estimate fee execution reverted." } }))).toMatch(/reverted/);
    expect(parseCliError(JSON.stringify({ data: { id: "tx-1" } }))).toBeUndefined();
    expect(parseCliError("")).toBeUndefined();
  });
});

describe("reading the contract's decision", () => {
  it("reports an executed proposal with its hash and the caller the contract saw", async () => {
    const outcome = await findOutcome(chainWith([log("ProposalExecuted", proposal)]), proposal, { mandate: MANDATE, fromBlock: 99n });
    expect(outcome).toMatchObject({ outcome: "ProposalExecuted", reason: "None", agent: AGENT, blockNumber: 100n, proposalId: proposalId("order-1") });
    expect(outcome!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("reports a rejection with the contract's reason", async () => {
    const outcome = await findOutcome(chainWith([log("ProposalRejected", proposal, { reason: 5 })]), proposal, { mandate: MANDATE, fromBlock: 99n });
    expect(outcome).toMatchObject({ outcome: "ProposalRejected", reason: "OverPerOrderCap" });
  });

  it("ignores other proposals and other customers", async () => {
    const logs = [log("ProposalExecuted", { ...proposal, reference: "order-2" }), log("ProposalExecuted", { ...proposal, customer: OTHER })];
    expect(await findOutcome(chainWith(logs), proposal, { mandate: MANDATE, fromBlock: 99n })).toBeUndefined();
  });
});

describe("submitting a proposal from the Agent Wallet", () => {
  const noSleep = async () => {};

  it("runs the CLI once and returns what the contract recorded", async () => {
    const calls: string[][] = [];
    const logs: Log[] = [];
    const cli = async (args: string[]) => {
      calls.push(args);
      logs.push(log("ProposalRejected", proposal, { reason: 4 }));
      return JSON.stringify({ data: { id: "tx-1", state: "INITIATED" } });
    };
    const outcome = await submitProposal(proposal, TARGET, { cli, client: chainWith(logs), sleep: noSleep });
    expect(calls).toEqual([executeArgs(proposal, TARGET)]);
    expect(outcome).toMatchObject({ outcome: "ProposalRejected", reason: "RecipientNotAllowed" });
  });

  it("keeps polling until the decision is mined", async () => {
    let reads = 0;
    const client = { getBlockNumber: async () => 99n, getLogs: async () => (++reads < 3 ? [] : [log("ProposalExecuted", proposal)]) };
    const outcome = await submitProposal(proposal, TARGET, { cli: async () => "{}", client, sleep: noSleep });
    expect(outcome.outcome).toBe("ProposalExecuted");
    expect(reads).toBe(3);
  });

  it("surfaces a refusal by Circle, such as a contract revert at estimation or a spend policy", async () => {
    const cli = async () => JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: "Service returned error 400: Estimate fee execution reverted." } });
    await expect(submitProposal(proposal, TARGET, { cli, client: chainWith([]), sleep: noSleep })).rejects.toThrow(/refused the request before signing.*reverted/);
  });

  it("fails if the contract saw a caller other than the Agent Wallet", async () => {
    const client = chainWith([log("ProposalExecuted", proposal, { agent: OTHER })]);
    await expect(submitProposal(proposal, TARGET, { cli: async () => "{}", client, sleep: noSleep })).rejects.toThrow(/not the Agent Wallet/);
  });

  it("gives up after the timeout when no decision appears", async () => {
    await expect(submitProposal(proposal, TARGET, { cli: async () => "{}", client: chainWith([]), sleep: noSleep, timeoutMs: -1 })).rejects.toThrow(/no decision recorded/);
  });
});
