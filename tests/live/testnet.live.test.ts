/**
 * Read-only checks against the live testnets and Circle's testnet APIs. No transaction is sent.
 *
 *   pnpm test:live
 *
 * Skipped unless RUN_LIVE=1, so the default `pnpm test` stays offline.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, parseEventLogs } from "viem";
import { describe, expect, it } from "vitest";
import { findOutcome, listArgs, parseAgentWallet, circleCli } from "@promorphic/agent";
import {
  ARC_TESTNET,
  BASE_SEPOLIA,
  CCTP_FINALITY,
  CCTP_V2_TESTNET,
  CIRCLE_API_URL,
  ETH_SEPOLIA,
  GATEWAY_TESTNET,
  MANDATE_ARC_TESTNET,
  buildTransferSpec,
  erc20Abi,
  estimateBurnIntent,
  fetchFee,
  mandateAbi,
  maxFeeFor,
  readRecord,
  readTerms,
  readUnifiedBalance,
  requestTransferAttestation,
  transportFor,
} from "@promorphic/router";

const envFile = resolve(import.meta.dirname, "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const enabled = process.env.RUN_LIVE === "1";
const NOBODY = "0x000000000000000000000000000000000000dEaD";

describe.skipIf(!enabled)("live testnet (read-only)", () => {
  const arc = createPublicClient({ transport: transportFor(ARC_TESTNET) });

  it("CCTP: a Fast Transfer into Arc is offered from both source testnets, with a fee we can cap", async () => {
    for (const source of [ETH_SEPOLIA, BASE_SEPOLIA]) {
      const fast = await fetchFee(source.cctpDomain, ARC_TESTNET.cctpDomain, CCTP_FINALITY.fast);
      expect(fast.minimumFeeBps).toBeGreaterThanOrEqual(0);
      expect(fast.minimumFeeBps).toBeLessThan(50);
      const standard = await fetchFee(source.cctpDomain, ARC_TESTNET.cctpDomain, CCTP_FINALITY.standard);
      expect(standard.minimumFeeBps).toBe(0);
      // The cap on a 5 USDC transfer stays under one cent.
      expect(maxFeeFor(5_000_000n, fast.minimumFeeBps)).toBeLessThan(10_000n);
    }
  });

  it("CCTP: TokenMessengerV2 on Arc is wired to the MessageTransmitterV2 we call", async () => {
    const transmitter = await arc.readContract({
      address: CCTP_V2_TESTNET.tokenMessengerV2,
      abi: [{ type: "function", name: "localMessageTransmitter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
      functionName: "localMessageTransmitter",
    });
    expect(transmitter.toLowerCase()).toBe(CCTP_V2_TESTNET.messageTransmitterV2.toLowerCase());
  });

  it("Gateway: the unified balance read returns one entry per test chain", async () => {
    const balance = await readUnifiedBalance(NOBODY);
    expect(balance.perDomain.map((b) => b.chain).sort()).toEqual(["Arc Testnet", "Base Sepolia", "Ethereum Sepolia"]);
    expect(balance.total).toMatch(/^\d+\.\d{6}$/);
    expect(balance.totalBaseUnits).toBe(balance.perDomain.reduce((sum, b) => sum + BigInt(Math.round(Number(b.balance) * 1e6)), 0n));
  });

  it("Gateway: the estimate endpoint prices a Sepolia to Arc transfer and the fee cap is a few USDC at most", async () => {
    const spec = buildTransferSpec({ source: ETH_SEPOLIA, destination: ARC_TESTNET, depositor: NOBODY, recipient: NOBODY, value: 2_000_000n, salt: `0x${"5a".repeat(32)}` });
    const intent = await estimateBurnIntent(spec);
    expect(intent.spec).toEqual(spec);
    expect(intent.maxFee).toBeGreaterThan(0n);
    expect(intent.maxFee).toBeLessThan(5_000_000n);
    const sepolia = createPublicClient({ transport: transportFor(ETH_SEPOLIA) });
    // The intent stays usable for a while: its expiry is ahead of the source chain's head.
    expect(intent.maxBlockHeight).toBeGreaterThan(await sepolia.getBlockNumber());
  });

  it("Gateway: a burn intent nobody funded is refused, so nothing can be minted from thin air", async () => {
    const spec = buildTransferSpec({ source: ETH_SEPOLIA, destination: ARC_TESTNET, depositor: NOBODY, recipient: NOBODY, value: 2_000_000n, salt: `0x${"5b".repeat(32)}` });
    const intent = await estimateBurnIntent(spec);
    await expect(requestTransferAttestation(intent, `0x${"11".repeat(65)}`)).rejects.toThrow(/\/v1\/transfer returned 4\d\d/);
  });

  it("Mandate: the deployed contract is the one in this repository", async () => {
    expect(((await arc.getCode({ address: MANDATE_ARC_TESTNET.address })) ?? "0x").length).toBeGreaterThan(2);
    const receipt = await arc.getTransactionReceipt({ hash: MANDATE_ARC_TESTNET.deployTxHash });
    expect(receipt.contractAddress?.toLowerCase()).toBe(MANDATE_ARC_TESTNET.address.toLowerCase());
    expect(receipt.blockNumber).toBe(MANDATE_ARC_TESTNET.deployBlock);
    const window = await arc.readContract({
      address: MANDATE_ARC_TESTNET.address,
      abi: [{ type: "function", name: "WINDOW_BUCKETS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "WINDOW_BUCKETS",
    });
    expect(window).toBe(25n);
  });

  it("Mandate: an address that never set a mandate has none, and nothing can be proposed for it", async () => {
    expect(await readTerms(NOBODY)).toBeUndefined();
    const head = await arc.getBlockNumber();
    expect(await readRecord(NOBODY, { fromBlock: head - 100n })).toEqual([]);
    await expect(
      arc.readContract({
        address: MANDATE_ARC_TESTNET.address,
        abi: mandateAbi,
        functionName: "preview",
        args: [NOBODY, `0x${"00".repeat(32)}`, ARC_TESTNET.usdc, NOBODY, 1n],
      }),
    ).rejects.toThrow(/NoMandate/);
  });

  // The M1(b) evidence run of 26 Nov 2026 (scripts/m1b-agent.ts), re-read from the chain.
  const M1B = {
    customer: "0x43fcd8798f6f59FaD358B6d682d34BAc33FDE4d9",
    agentWallet: "0x1023fe642ca99b40028d187fe491c0e56a038c6e",
    block: 74224871n,
    run: "m1b-20261126T145940",
  } as const;

  it("Agent Wallet: the recorded in-limit proposal was executed by the Circle Agent Wallet", async () => {
    const outcome = await findOutcome(arc, { customer: M1B.customer, reference: `${M1B.run}-in-limit` }, { mandate: MANDATE_ARC_TESTNET.address, fromBlock: M1B.block, toBlock: M1B.block });
    expect(outcome).toMatchObject({ outcome: "ProposalExecuted", reason: "None", txHash: "0x3a978f2aba74e571aa68adbb4cce491888bedeb5fb382eb0c0c9d0c85112f43d" });
    expect(outcome!.agent.toLowerCase()).toBe(M1B.agentWallet);
  });

  it("Agent Wallet: the recorded out-of-limit proposals were rejected with their reasons", async () => {
    const window = { mandate: MANDATE_ARC_TESTNET.address, fromBlock: M1B.block, toBlock: M1B.block + 200n };
    const overCap = await findOutcome(arc, { customer: M1B.customer, reference: `${M1B.run}-over-cap` }, window);
    expect(overCap).toMatchObject({ outcome: "ProposalRejected", reason: "OverPerOrderCap", txHash: "0xcb6bd14046870eb9d43e22554de6b57540296043b5d3fe9033c137a930465e5d" });
    const stranger = await findOutcome(arc, { customer: M1B.customer, reference: `${M1B.run}-not-allowlisted` }, window);
    expect(stranger).toMatchObject({ outcome: "ProposalRejected", reason: "RecipientNotAllowed", txHash: "0x8fb5ba177df411e80433790f87f87921e7b594bb896822b1e7f7e0a7f9a0cca8" });
  });

  it("Agent Wallet: it is a smart account, so its transactions arrive through a bundler", async () => {
    expect(((await arc.getCode({ address: M1B.agentWallet })) ?? "0x").length).toBeGreaterThan(2);
    const receipt = await arc.getTransactionReceipt({ hash: "0x3a978f2aba74e571aa68adbb4cce491888bedeb5fb382eb0c0c9d0c85112f43d" });
    // ERC-4337 EntryPoint v0.7. The transaction's sender is a bundler; the Mandate contract saw the Agent Wallet as caller.
    expect(receipt.to?.toLowerCase()).toBe("0x0000000071727de22e5e9d8baf0edac6f37da032");
    expect(receipt.from.toLowerCase()).not.toBe(M1B.agentWallet);
  });

  // The M1(a) and M1(b) run of 26 Nov 2026 with the customer's Circle user-controlled wallet, re-read from the chains.
  const CUSTOMER = "0xdc2fefe9fa4b011eec12811c547e702b50781c04";

  it("CCTP: the recorded burn on Sepolia came from the customer's wallet and the mint on Arc paid the same wallet", async () => {
    const sepolia = createPublicClient({ transport: transportFor(ETH_SEPOLIA) });
    const burn = await sepolia.getTransactionReceipt({ hash: "0x5c841f0cdfb2706c4b18282560c4e34bd87f9d5d48d0ed9618f909620ef88718" });
    expect(burn.status).toBe("success");
    expect(burn.from.toLowerCase()).toBe(CUSTOMER);
    expect(burn.to?.toLowerCase()).toBe(CCTP_V2_TESTNET.tokenMessengerV2.toLowerCase());

    const mint = await arc.getTransactionReceipt({ hash: "0xbe422779508bcf8b2dd62f96060ad63764c737407c1565394e6c0845de931b99" });
    expect(mint.status).toBe("success");
    expect(mint.to?.toLowerCase()).toBe(CCTP_V2_TESTNET.messageTransmitterV2.toLowerCase());
    // The customer did not send the mint: a relayer paid the gas.
    expect(mint.from.toLowerCase()).not.toBe(CUSTOMER);
    const transfers = parseEventLogs({ abi: erc20Abi, logs: mint.logs, eventName: "Transfer" }).filter((t) => t.address.toLowerCase() === ARC_TESTNET.usdc.toLowerCase());
    const received = transfers.filter((t) => t.args.to.toLowerCase() === CUSTOMER).reduce((sum, t) => sum + t.args.value, 0n);
    expect(received).toBe(4_999_875n);
  });

  it("Gateway: the recorded mint on Arc paid the customer 2 USDC and was submitted by a relayer", async () => {
    const mint = await arc.getTransactionReceipt({ hash: "0xe788e31043d4603ef0692e44557ef39609c7310614055f2b6130c480adfcf249" });
    expect(mint.status).toBe("success");
    expect(mint.to?.toLowerCase()).toBe(GATEWAY_TESTNET.gatewayMinter.toLowerCase());
    expect(mint.from.toLowerCase()).not.toBe(CUSTOMER);
    const received = parseEventLogs({ abi: erc20Abi, logs: mint.logs, eventName: "Transfer" })
      .filter((t) => t.address.toLowerCase() === ARC_TESTNET.usdc.toLowerCase() && t.args.to.toLowerCase() === CUSTOMER)
      .reduce((sum, t) => sum + t.args.value, 0n);
    expect(received).toBe(2_000_000n);

    const sepolia = createPublicClient({ transport: transportFor(ETH_SEPOLIA) });
    const deposit = await sepolia.getTransactionReceipt({ hash: "0xd174b1bc42e5525671b731b6147cb278a5ad55f6a8be864d04a7494972bf7b78" });
    expect(deposit.status).toBe("success");
    expect(deposit.from.toLowerCase()).toBe(CUSTOMER);
    expect(deposit.to?.toLowerCase()).toBe(GATEWAY_TESTNET.gatewayWallet.toLowerCase());
  });

  it("Mandate: the customer's Circle wallet set the mandate and the Agent Wallet's proposals were decided under it", async () => {
    const record = await readRecord(CUSTOMER, { fromBlock: 74231300n, toBlock: 74231500n });
    expect(record.map((r) => [r.kind, r.reason ?? ""])).toEqual([
      ["MandateSet", ""],
      ["ProposalExecuted", ""],
      ["ProposalRejected", "OverPerOrderCap"],
      ["ProposalRejected", "RecipientNotAllowed"],
    ]);
    expect(record[0]!.actor?.toLowerCase()).toBe(CUSTOMER);
    for (const r of record.slice(1)) expect(r.actor?.toLowerCase()).toBe(M1B.agentWallet);
    expect(record[1]!.txHash).toBe("0xd96be9a5fcec46ef8640fa96d04a3065651bf0178700b3aa96aa5a4c2d411447");
  });

  it.skipIf(process.env.RUN_CIRCLE_CLI !== "1")("Agent Wallet: the Circle CLI session lists the wallet on Arc testnet", async () => {
    const out = await circleCli(resolve(import.meta.dirname, "../.."))(listArgs("ARC-TESTNET"));
    expect(parseAgentWallet(out, "ARC-TESTNET")?.toLowerCase()).toBe(M1B.agentWallet);
  });

  it.skipIf(!process.env.CIRCLE_API_KEY)("Circle Wallets: the testnet key authenticates and belongs to the configured app", async () => {
    expect(process.env.CIRCLE_API_KEY).toMatch(/^TEST_API_KEY:/);
    const res = await fetch(`${CIRCLE_API_URL}/v1/w3s/config/entity`, { headers: { authorization: `Bearer ${process.env.CIRCLE_API_KEY}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { appId: string } };
    expect(body.data.appId).toBe(process.env.CIRCLE_APP_ID);
  });
});
