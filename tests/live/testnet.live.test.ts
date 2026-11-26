/**
 * Read-only checks against the live testnets and Circle's testnet APIs. No transaction is sent.
 *
 *   pnpm test:live
 *
 * Skipped unless RUN_LIVE=1, so the default `pnpm test` stays offline.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARC_TESTNET,
  BASE_SEPOLIA,
  CCTP_FINALITY,
  CCTP_V2_TESTNET,
  CIRCLE_API_URL,
  ETH_SEPOLIA,
  MANDATE_ARC_TESTNET,
  fetchFee,
  mandateAbi,
  maxFeeFor,
  readRecord,
  readTerms,
  readUnifiedBalance,
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

  it.skipIf(!process.env.CIRCLE_API_KEY)("Circle Wallets: the testnet key authenticates and belongs to the configured app", async () => {
    expect(process.env.CIRCLE_API_KEY).toMatch(/^TEST_API_KEY:/);
    const res = await fetch(`${CIRCLE_API_URL}/v1/w3s/config/entity`, { headers: { authorization: `Bearer ${process.env.CIRCLE_API_KEY}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { appId: string } };
    expect(body.data.appId).toBe(process.env.CIRCLE_APP_ID);
  });
});
