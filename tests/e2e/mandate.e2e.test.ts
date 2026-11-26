/**
 * Live end-to-end test of the deployed Mandate contract on Arc TESTNET. Sends real testnet
 * transactions and spends a few cents of faucet USDC.
 *
 *   pnpm test:e2e
 *
 * Cast: the test wallet (TEST_SOURCE_PRIVATE_KEY) plays the customer; a key generated for this
 * run plays the agent; a second generated address plays the allowlisted recipient. All three are
 * test keys holding faucet funds only. Skipped unless RUN_E2E=1.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ContractFunctionRevertedError,
  BaseError,
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseEventLogs,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ARC_TESTNET,
  MANDATE_ARC_TESTNET,
  MANDATE_REASONS,
  MandateMode,
  erc20Abi,
  mandateAbi,
  proposalId,
  readRecord,
  readTerms,
  transportFor,
  viemChain,
  type Address,
} from "@promorphic/router";

const envFile = resolve(import.meta.dirname, "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const enabled = process.env.RUN_E2E === "1" && !!process.env.TEST_SOURCE_PRIVATE_KEY;

const USDC = ARC_TESTNET.usdc;
const MANDATE = MANDATE_ARC_TESTNET.address;
const units = (usdc: number) => BigInt(Math.round(usdc * 1e6));

describe.skipIf(!enabled)("Mandate on Arc testnet (live)", () => {
  const chain = viemChain(ARC_TESTNET);
  const transport = transportFor(ARC_TESTNET);
  const client = createPublicClient({ chain, transport });
  const run = Date.now().toString(36);

  const customer = enabled ? privateKeyToAccount(process.env.TEST_SOURCE_PRIVATE_KEY as Hex) : undefined!;
  const agent = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  const customerWallet = createWalletClient({ account: customer, chain, transport });
  const agentWallet = createWalletClient({ account: agent, chain, transport });

  const balance = (who: Address) => client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const mined = async (hash: Hex) => {
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status, `transaction ${hash}`).toBe("success");
    return receipt;
  };

  /** The agent submits a proposal; returns what the contract recorded. */
  async function propose(reference: string, to: Address, amount: bigint) {
    const hash = await agentWallet.writeContract({
      address: MANDATE,
      abi: mandateAbi,
      functionName: "execute",
      args: [customer.address, proposalId(`${run}-${reference}`), USDC, to, amount],
    });
    const receipt = await mined(hash);
    const [event] = parseEventLogs({ abi: mandateAbi, logs: receipt.logs, eventName: ["ProposalExecuted", "ProposalRejected"] });
    return {
      hash,
      outcome: event!.eventName,
      reason: event!.eventName === "ProposalRejected" ? MANDATE_REASONS[Number(event!.args.reason)] : "None",
    };
  }

  async function setMandate(mode: keyof typeof MandateMode, perOrder: number, daily: number) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await mined(
      await customerWallet.writeContract({
        address: MANDATE,
        abi: mandateAbi,
        functionName: "setMandate",
        args: [agent.address, USDC, MandateMode[mode], units(perOrder), units(daily), expiry, [USDC], [recipient]],
      }),
    );
  }

  let spentBefore = 0n;

  beforeAll(async () => {
    expect(await client.getChainId(), "must be Arc testnet").toBe(ARC_TESTNET.chainId);
    // Gas for the agent: on Arc the gas token is USDC in its 18-decimal native form.
    await mined(await customerWallet.sendTransaction({ to: agent.address, value: parseEther("0.05") }));
    // The customer allows the Mandate contract to move at most 1 USDC, and no more.
    await mined(await customerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [MANDATE, units(1)] }));
    spentBefore = await client.readContract({ address: MANDATE, abi: mandateAbi, functionName: "spentInWindow", args: [customer.address] });
    // Daily cap leaves room for exactly 0.25 USDC on top of whatever earlier runs spent in the window.
    await setMandate("Autopilot", 0.1, Number(spentBefore) / 1e6 + 0.25);
  });

  it("the customer's mandate is readable on-chain", async () => {
    const terms = await readTerms(customer.address);
    expect(terms).toMatchObject({ agent: agent.address, mode: "Autopilot", revoked: false, perOrderCap: units(0.1) });
  });

  it("an in-limit proposal moves USDC from the customer straight to the allowlisted recipient", async () => {
    const before = { customer: await balance(customer.address), recipient: await balance(recipient), mandate: await balance(MANDATE), agent: await balance(agent.address) };
    const result = await propose("in-limit", recipient, units(0.1));
    expect(result.outcome).toBe("ProposalExecuted");
    expect(await balance(recipient)).toBe(before.recipient + units(0.1));
    expect(await balance(MANDATE), "the contract holds nothing").toBe(before.mandate);
    // The customer paid exactly the order, and no gas: the agent paid its own gas.
    expect(await balance(customer.address)).toBe(before.customer - units(0.1));
    expect(await balance(agent.address)).toBeLessThan(before.agent);
  });

  it("a proposal over the per-order cap is rejected with a transaction hash, and nothing moves", async () => {
    const before = await balance(recipient);
    const result = await propose("over-cap", recipient, units(0.11));
    expect(result).toMatchObject({ outcome: "ProposalRejected", reason: "OverPerOrderCap" });
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await balance(recipient)).toBe(before);
  });

  it("a proposal to a recipient outside the allowlist is rejected", async () => {
    const result = await propose("stranger", stranger, units(0.05));
    expect(result).toMatchObject({ outcome: "ProposalRejected", reason: "RecipientNotAllowed" });
    expect(await balance(stranger)).toBe(0n);
  });

  it("the agent cannot pay itself", async () => {
    const result = await propose("self", agent.address, units(0.05));
    expect(result).toMatchObject({ outcome: "ProposalRejected", reason: "RecipientNotAllowed" });
  });

  it("the rolling daily cap stops the order that would exceed it", async () => {
    expect((await propose("daily-2", recipient, units(0.1))).outcome).toBe("ProposalExecuted");
    // 0.2 spent this run; the cap leaves 0.05.
    expect(await propose("daily-3", recipient, units(0.1))).toMatchObject({ outcome: "ProposalRejected", reason: "OverDailyCap" });
    expect((await propose("daily-4", recipient, units(0.05))).outcome).toBe("ProposalExecuted");
    const spent = await client.readContract({ address: MANDATE, abi: mandateAbi, functionName: "spentInWindow", args: [customer.address] });
    expect(spent).toBe(spentBefore + units(0.25));
  });

  it("nobody but the named agent can submit for the customer", async () => {
    const attempt = client.simulateContract({
      account: stranger,
      address: MANDATE,
      abi: mandateAbi,
      functionName: "execute",
      args: [customer.address, proposalId(`${run}-intruder`), USDC, recipient, units(0.01)],
    });
    await expect(attempt).rejects.toSatisfy((err: unknown) => {
      const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
      return revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "NotAgent";
    });
  });

  it("Copilot: nothing executes until the customer approves that exact proposal", async () => {
    await setMandate("Copilot", 0.1, Number(spentBefore) / 1e6 + 0.5);
    expect(await propose("copilot-unapproved", recipient, units(0.05))).toMatchObject({ outcome: "ProposalRejected", reason: "NotApproved" });

    const approve = (reference: string, amount: bigint) =>
      customerWallet
        .writeContract({ address: MANDATE, abi: mandateAbi, functionName: "approve", args: [proposalId(`${run}-${reference}`), USDC, recipient, amount] })
        .then(mined);

    await approve("copilot-changed", units(0.05));
    // Approved for 0.05; the agent tries 0.06.
    expect(await propose("copilot-changed", recipient, units(0.06))).toMatchObject({ outcome: "ProposalRejected", reason: "NotApproved" });

    await approve("copilot-ok", units(0.05));
    const before = await balance(recipient);
    expect((await propose("copilot-ok", recipient, units(0.05))).outcome).toBe("ProposalExecuted");
    expect(await balance(recipient)).toBe(before + units(0.05));
  });

  it("after the customer revokes, every proposal is rejected", async () => {
    await mined(await customerWallet.writeContract({ address: MANDATE, abi: mandateAbi, functionName: "revoke" }));
    expect(await propose("after-revoke", recipient, units(0.01))).toMatchObject({ outcome: "ProposalRejected", reason: "Revoked" });
    expect((await readTerms(customer.address))?.revoked).toBe(true);
  });

  it("the audit record lists this run's decisions in order, each with its transaction", async () => {
    const head = await client.getBlockNumber();
    const record = await readRecord(customer.address, { fromBlock: head > 9_000n ? head - 9_000n : 0n });
    const mine = record.filter((r) => r.proposalId && [
      "in-limit", "over-cap", "stranger", "self", "daily-2", "daily-3", "daily-4", "copilot-unapproved", "copilot-changed", "copilot-ok", "after-revoke",
    ].some((ref) => r.proposalId === proposalId(`${run}-${ref}`)));
    const decided = mine.filter((r) => r.kind !== "ProposalApproved");
    expect(decided.map((r) => `${r.kind === "ProposalExecuted" ? "executed" : r.reason}`)).toEqual([
      "executed", "OverPerOrderCap", "RecipientNotAllowed", "RecipientNotAllowed", "executed", "OverDailyCap", "executed", "NotApproved", "NotApproved", "executed", "Revoked",
    ]);
    expect(mine.filter((r) => r.kind === "ProposalApproved").every((r) => r.actor === customer.address)).toBe(true);
    expect(decided.every((r) => r.actor === agent.address && /^0x[0-9a-f]{64}$/.test(r.txHash))).toBe(true);
    expect(record.some((r) => r.kind === "MandateRevoked")).toBe(true);
  });

  it("the customer withdraws the allowance at the end", async () => {
    await mined(await customerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [MANDATE, 0n] }));
    const allowance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [customer.address, MANDATE] });
    expect(allowance).toBe(0n);
  });
});
