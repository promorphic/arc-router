/**
 * The demo backend's flows, end to end over real HTTP, with Circle and the chains replaced by
 * fakes. Each test is one thing the customer does on the page.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARC_TESTNET,
  CCTP_V2_TESTNET,
  CircleApiError,
  ETH_SEPOLIA,
  GATEWAY_TESTNET,
  MANDATE_ARC_TESTNET,
  USER_ALREADY_INITIALIZED,
  bytes32ToAddress,
  erc20Abi,
  gatewayWalletAbi,
  mandateAbi,
  tokenMessengerV2Abi,
  type Address,
  type BurnIntent,
  type CircleWallet,
  type MandateTerms,
} from "@promorphic/router";
import { createApi, type ApiDeps, type EvidenceEntry } from "./api.ts";

const CUSTOMER: Address = getAddress("0x00000000000000000000000000000000000c0570");
const AGENT: Address = getAddress("0x00000000000000000000000000000000000a6e47");
const RECIPIENT: Address = getAddress("0x0000000000000000000000000000000000001550");
const WALLETS: CircleWallet[] = [
  { id: "w-sepolia", address: CUSTOMER, blockchain: "ETH-SEPOLIA" },
  { id: "w-arc", address: CUSTOMER, blockchain: "ARC-TESTNET" },
];

interface Challenge {
  walletId: string;
  contractAddress: Address;
  callData: Hex;
}

let dir: string;
let server: Server;
let base: string;
let challenges: Challenge[];
let world: {
  wallets: CircleWallet[];
  agent: Address | undefined;
  initialized: boolean;
  arcUsdc: bigint;
  terms: MandateTerms | undefined;
  relayed: { message: Hex; attestation: Hex }[];
  txHashes: Hex[];
  /** Gateway: the depositor's balance on Ethereum Sepolia, what was asked to be signed, and what was sent on. */
  gatewayBalance: string;
  signRequests: { walletId: string; data: string; memo?: string }[];
  gatewayTransfers: { intent: BurnIntent; signature: Hex }[];
  gatewayMints: { attestation: Hex; signature: Hex }[];
};

function deps(): ApiDeps {
  return {
    appId: "app-1",
    agentWallet: async () => world.agent,
    allowedRecipient: RECIPIENT,
    statePath: join(dir, "state.json"),
    evidencePath: join(dir, "evidence.json"),
    now: () => new Date("2026-11-26T12:00:00Z"),
    circle: {
      // Circle's own limit on user ids; a longer one gets "400: API parameter invalid".
      createUser: async (userId: string) => {
        if (userId.length < 5 || userId.length > 50) throw new CircleApiError(400, 2, "API parameter invalid");
      },
      createUserToken: async () => ({ userToken: "ut", encryptionKey: "ek" }),
      initializeUser: async () => {
        if (world.initialized) throw new CircleApiError(409, USER_ALREADY_INITIALIZED, "already initialized");
        world.initialized = true;
        return { challengeId: "ch-init" };
      },
      listWallets: async () => world.wallets,
      createContractExecutionChallenge: async (_token, tx) => {
        challenges.push(tx);
        return { challengeId: `ch-${challenges.length}` };
      },
      createSignTypedDataChallenge: async (_token, req) => {
        world.signRequests.push(req);
        return { challengeId: `sign-${world.signRequests.length}` };
      },
      waitForChallengeTransaction: async (_token, id) => ({ id: `tx-${id}`, state: "CONFIRMED", txHash: world.txHashes.shift() ?? "0x0" }),
    },
    chain: {
      usdcBalance: async (chain) => (chain.key === "arcTestnet" ? world.arcUsdc : 20_000_000n),
      nativeBalance: async () => 10n ** 17n,
      fetchFee: async () => ({ finalityThreshold: 1000, minimumFeeBps: 0.25 }),
      waitForAttestation: async () => ({ message: "0xaa", attestation: "0xbb", waitedMs: 12_340 }),
      relayMint: async (message, attestation) => {
        world.relayed.push({ message, attestation });
        world.arcUsdc += 5_000_000n;
        return "0x1111";
      },
      unifiedBalance: async (who) => ({
        depositor: who,
        totalBaseUnits: 0n,
        total: "0.000000",
        perDomain: [
          { domain: 26, chain: "Arc Testnet", balance: "0" },
          { domain: 0, chain: "Ethereum Sepolia", balance: world.gatewayBalance },
        ],
      }),
      // Gateway's testnet answer for Sepolia -> Arc when this was written: a 1.1 USDC fee cap.
      gatewayEstimate: async (spec) => ({ maxBlockHeight: 12_275_124n, maxFee: 1_100_000n, spec }),
      gatewayTransfer: async (intent, signature) => {
        world.gatewayTransfers.push({ intent, signature });
        return { transferId: "transfer-1", attestation: "0xa77e", signature: "0x516e" };
      },
      relayGatewayMint: async (attestation, signature) => {
        world.gatewayMints.push({ attestation, signature });
        world.arcUsdc += world.gatewayTransfers.at(-1)!.intent.spec.value;
        return "0x2222";
      },
      mandateTerms: async () => world.terms,
      mandateRecord: async () => [],
      spentInWindow: async () => 0n,
    },
  };
}

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}
const evidence = () => JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")) as EvidenceEntry[];
const createWallet = async () => {
  await call("POST", "/api/wallet/init");
  await call("POST", "/api/wallet/refresh");
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "arc-router-demo-"));
  challenges = [];
  world = { wallets: WALLETS, agent: AGENT, initialized: false, arcUsdc: 0n, terms: undefined, relayed: [], txHashes: [], gatewayBalance: "0", signRequests: [], gatewayTransfers: [], gatewayMints: [] };
  const api = createApi(deps());
  server = createServer((req, res) => void api(req, res, () => res.writeHead(418).end("passed through")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe("wallet creation", () => {
  it("gives the browser a session and the app id, and nothing else", async () => {
    const { json } = await call("POST", "/api/session");
    expect(json).toEqual({ appId: "app-1", userToken: "ut", encryptionKey: "ek" });
  });

  it("creates the PIN challenge, then finds the wallets on both chains", async () => {
    const init = await call("POST", "/api/wallet/init");
    expect(init.json).toEqual({ challengeId: "ch-init" });
    const refreshed = await call("POST", "/api/wallet/refresh");
    expect(refreshed.json.wallets).toEqual({
      source: { id: "w-sepolia", address: CUSTOMER },
      arc: { id: "w-arc", address: CUSTOMER },
    });
  });

  it("is safe to repeat once the PIN is set", async () => {
    await call("POST", "/api/wallet/init");
    const again = await call("POST", "/api/wallet/init");
    expect(again).toEqual({ status: 200, json: { alreadyInitialized: true } });
  });

  it("keeps the same Circle user across requests", async () => {
    await call("POST", "/api/session");
    const first = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).userId;
    await call("POST", "/api/session");
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).userId).toBe(first);
    expect(first).toMatch(/^promorphic-[0-9a-f-]{36}$/);
    expect(first.length).toBeLessThanOrEqual(50);
  });

  it("replaces a user id saved by an earlier build that Circle would reject", async () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ userId: `promorphic-demo-${"0".repeat(36)}` }));
    expect((await call("POST", "/api/session")).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).userId.length).toBeLessThanOrEqual(50);
  });

  it("refuses customer actions before the wallet exists", async () => {
    const { status, json } = await call("POST", "/api/challenge", { action: "cctp-burn", amount: "5" });
    expect(status).toBe(409);
    expect(json.error).toMatch(/wallet does not exist/);
  });
});

describe("1a: CCTP V2 transfer into Arc", () => {
  beforeEach(createWallet);

  it("prepares the USDC allowance for TokenMessengerV2 from the customer's Sepolia wallet", async () => {
    await call("POST", "/api/challenge", { action: "cctp-approve", amount: "5" });
    const c = challenges[0]!;
    expect(c.walletId).toBe("w-sepolia");
    expect(c.contractAddress).toBe(ETH_SEPOLIA.usdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: c.callData }).args).toEqual([CCTP_V2_TESTNET.tokenMessengerV2, 5_000_000n]);
  });

  it("prepares a Fast Transfer burn that can only mint to the customer's own Arc wallet", async () => {
    await call("POST", "/api/challenge", { action: "cctp-burn", amount: "5" });
    const c = challenges[0]!;
    expect(c.walletId).toBe("w-sepolia");
    expect(c.contractAddress).toBe(CCTP_V2_TESTNET.tokenMessengerV2);
    const { functionName, args } = decodeFunctionData({ abi: tokenMessengerV2Abi, data: c.callData });
    expect(functionName).toBe("depositForBurn");
    const [amount, destinationDomain, mintRecipient, burnToken, , maxFee, minFinality] = args!;
    expect(amount).toBe(5_000_000n);
    expect(destinationDomain).toBe(ARC_TESTNET.cctpDomain);
    expect(mintRecipient.toLowerCase()).toBe(`0x${"0".repeat(24)}${CUSTOMER.slice(2).toLowerCase()}`);
    expect(burnToken).toBe(ETH_SEPOLIA.usdc);
    expect(minFinality).toBe(1000);
    // 0.25 bps quoted + 1 bps margin on 5 USDC.
    expect(maxFee).toBe(625n);
  });

  it("after the customer approves: waits for the attestation, relays the mint, records both hashes", async () => {
    const { json: prepared } = await call("POST", "/api/challenge", { action: "cctp-burn", amount: "5" });
    world.txHashes = ["0xb07"];
    const { status, json } = await call("POST", "/api/complete", { action: "cctp-burn", challengeId: prepared.challengeId });
    expect(status).toBe(200);
    expect(json.burnTxHash).toBe("0xb07");
    expect(json.mintTxHash).toBe("0x1111");
    expect(json.attestationSeconds).toBe(12.3);
    expect(world.relayed).toEqual([{ message: "0xaa", attestation: "0xbb" }]);

    const [burn, mint] = evidence();
    expect(burn).toMatchObject({ milestone: "M1(a)", chain: "Ethereum Sepolia", txHash: "0xb07" });
    expect(burn!.url).toBe("https://sepolia.etherscan.io/tx/0xb07");
    expect(mint).toMatchObject({ milestone: "M1(a)", chain: "Arc Testnet", txHash: "0x1111" });
    expect(mint!.proves).toMatch(/balance 0\.000000 -> 5\.000000/);
  });

  it("can resume a burn whose mint did not complete, and does not mint twice", async () => {
    const { json: prepared } = await call("POST", "/api/challenge", { action: "cctp-burn", amount: "5" });
    world.txHashes = ["0xb07"];
    await call("POST", "/api/complete", { action: "cctp-burn", challengeId: prepared.challengeId });
    const resumed = await call("POST", "/api/cctp/resume");
    expect(resumed.json.mintTxHash).toBe("0x1111");
    expect(world.relayed).toHaveLength(1);
  });

  it("has nothing to resume before a burn", async () => {
    expect((await call("POST", "/api/cctp/resume")).status).toBe(409);
  });
});

describe("1b: the customer sets the mandate", () => {
  beforeEach(createWallet);

  it("grants the Mandate contract an allowance equal to the daily cap, from the Arc wallet", async () => {
    await call("POST", "/api/challenge", { action: "mandate-approve-usdc" });
    const c = challenges[0]!;
    expect(c.walletId).toBe("w-arc");
    expect(c.contractAddress).toBe(ARC_TESTNET.usdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: c.callData }).args).toEqual([MANDATE_ARC_TESTNET.address, 5_000_000n]);
  });

  it("names the Agent Wallet, the caps, the one allowed recipient and a 7-day expiry", async () => {
    await call("POST", "/api/challenge", { action: "mandate-set" });
    const c = challenges[0]!;
    expect(c.walletId).toBe("w-arc");
    expect(c.contractAddress).toBe(MANDATE_ARC_TESTNET.address);
    const { functionName, args } = decodeFunctionData({ abi: mandateAbi, data: c.callData });
    expect(functionName).toBe("setMandate");
    const nowSeconds = Date.parse("2026-11-26T12:00:00Z") / 1000;
    expect(args).toEqual([AGENT, ARC_TESTNET.usdc, 1, 2_000_000n, 5_000_000n, BigInt(nowSeconds + 7 * 86_400), [ARC_TESTNET.usdc], [RECIPIENT]]);
  });

  it("will not prepare a mandate before the Agent Wallet exists", async () => {
    world.agent = undefined;
    const { status, json } = await call("POST", "/api/challenge", { action: "mandate-set" });
    expect(status).toBe(409);
    expect(json.error).toMatch(/Agent Wallet/);
  });

  it("records the mandate the chain reports, not the one that was requested", async () => {
    const { json: prepared } = await call("POST", "/api/challenge", { action: "mandate-set" });
    world.txHashes = ["0x5e7"];
    world.terms = { agent: AGENT, settlementToken: ARC_TESTNET.usdc, mode: "Autopilot", revoked: false, expiry: 1_900_000_000n, version: 3n, perOrderCap: 2_000_000n, dailyCap: 5_000_000n };
    await call("POST", "/api/complete", { action: "mandate-set", challengeId: prepared.challengeId });
    const [entry] = evidence();
    expect(entry).toMatchObject({ milestone: "M1(b)", chain: "Arc Testnet", txHash: "0x5e7" });
    expect(entry!.proves).toMatch(/mandate version 3/);
    expect(entry!.proves).toMatch(/per-order cap 2\.000000 USDC, rolling daily cap 5\.000000 USDC/);
  });
});

describe("1c: an Arc-side action funded from the Gateway balance", () => {
  // The customer signs with a real key here, so the server's signature check is exercised for real.
  const customer = privateKeyToAccount(generatePrivateKey());
  /** Signs exactly the document the server asked Circle to show the customer, as the Circle frame would. */
  const signAsked = (account = customer) => {
    const doc = JSON.parse(world.signRequests.at(-1)!.data);
    const { EIP712Domain: _domain, ...types } = doc.types;
    return account.signTypedData({ domain: doc.domain, types, primaryType: doc.primaryType, message: doc.message });
  };
  beforeEach(async () => {
    world.wallets = [
      { id: "w-sepolia", address: customer.address, blockchain: "ETH-SEPOLIA" },
      { id: "w-arc", address: customer.address, blockchain: "ARC-TESTNET" },
    ];
    await createWallet();
  });

  it("prepares the allowance and the deposit into GatewayWallet from the customer's Sepolia wallet", async () => {
    await call("POST", "/api/challenge", { action: "gateway-approve", amount: "5" });
    await call("POST", "/api/challenge", { action: "gateway-deposit", amount: "5" });
    expect(challenges.map((c) => [c.walletId, c.contractAddress])).toEqual([
      ["w-sepolia", ETH_SEPOLIA.usdc],
      ["w-sepolia", GATEWAY_TESTNET.gatewayWallet],
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: challenges[0]!.callData }).args).toEqual([GATEWAY_TESTNET.gatewayWallet, 5_000_000n]);
    const deposit = decodeFunctionData({ abi: gatewayWalletAbi, data: challenges[1]!.callData });
    expect(deposit.functionName).toBe("deposit");
    expect(deposit.args).toEqual([ETH_SEPOLIA.usdc, 5_000_000n]);
  });

  it("records the deposit once the customer has approved it", async () => {
    await call("POST", "/api/challenge", { action: "gateway-deposit", amount: "5" });
    world.txHashes = ["0xdddd"];
    const done = await call("POST", "/api/complete", { action: "gateway-deposit", challengeId: "ch-1" });
    expect(done.json.txHash).toBe("0xdddd");
    expect(evidence().at(-1)).toMatchObject({ milestone: "M1(c)", chain: "Ethereum Sepolia", txHash: "0xdddd" });
    expect((await call("GET", "/api/state")).json.gatewayFlow).toMatchObject({ depositAmount: "5.000000", depositTxHash: "0xdddd" });
  });

  it("will not ask for a signature until the deposit covers the transfer and the fee cap", async () => {
    world.gatewayBalance = "3.099999";
    const res = await call("POST", "/api/challenge", { action: "gateway-sign", value: "2" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/balance on Ethereum Sepolia is 3\.099999 USDC.*needs up to 3\.100000.*13 to 19 minutes/);
    expect(world.signRequests).toHaveLength(0);
  });

  it("asks the customer to sign a burn intent that can only mint to their own wallet on Arc", async () => {
    world.gatewayBalance = "5";
    const res = await call("POST", "/api/challenge", { action: "gateway-sign", value: "2" });
    expect(res.json).toEqual({ challengeId: "sign-1" });
    const asked = world.signRequests[0]!;
    expect(asked.walletId).toBe("w-sepolia");
    expect(asked.memo).toBe("Move 2.000000 USDC from your Gateway balance to your wallet on Arc Testnet");
    const doc = JSON.parse(asked.data);
    expect(doc.primaryType).toBe("BurnIntent");
    expect(doc.domain).toEqual({ name: "GatewayWallet", version: "1" });
    expect(doc.message).toMatchObject({ maxFee: "1100000", maxBlockHeight: "12275124" });
    const spec = doc.message.spec;
    expect(spec).toMatchObject({ version: 1, sourceDomain: 0, destinationDomain: 26, value: "2000000", hookData: "0x" });
    for (const field of ["sourceDepositor", "sourceSigner", "destinationRecipient"]) expect(bytes32ToAddress(spec[field])).toBe(customer.address.toLowerCase());
    expect(bytes32ToAddress(spec.sourceContract)).toBe(GATEWAY_TESTNET.gatewayWallet.toLowerCase());
    expect(bytes32ToAddress(spec.destinationContract)).toBe(GATEWAY_TESTNET.gatewayMinter.toLowerCase());
    expect(bytes32ToAddress(spec.sourceToken)).toBe(ETH_SEPOLIA.usdc.toLowerCase());
    expect(bytes32ToAddress(spec.destinationToken)).toBe(ARC_TESTNET.usdc.toLowerCase());
  });

  it("uses a fresh salt for every intent", async () => {
    world.gatewayBalance = "5";
    await call("POST", "/api/challenge", { action: "gateway-sign" });
    await call("POST", "/api/challenge", { action: "gateway-sign" });
    const salts = world.signRequests.map((r) => JSON.parse(r.data).message.spec.salt);
    expect(salts[0]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(salts[0]).not.toBe(salts[1]);
  });

  it("after the customer signs: Gateway attests, the relayer mints on Arc, and the hash is recorded", async () => {
    world.gatewayBalance = "5";
    await call("POST", "/api/challenge", { action: "gateway-sign", value: "2" });
    const signature = await signAsked();
    const done = await call("POST", "/api/complete", { action: "gateway-sign", challengeId: "sign-1", signature });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ mintTxHash: "0x2222", transferId: "transfer-1" });
    // Gateway received the intent the customer signed, and the relayer minted with Gateway's attestation.
    expect(world.gatewayTransfers).toHaveLength(1);
    expect(world.gatewayTransfers[0]!.signature).toBe(signature);
    expect(world.gatewayTransfers[0]!.intent.spec.value).toBe(2_000_000n);
    expect(world.gatewayMints).toEqual([{ attestation: "0xa77e", signature: "0x516e" }]);
    const last = evidence().at(-1)!;
    expect(last).toMatchObject({ milestone: "M1(c)", chain: "Arc Testnet", txHash: "0x2222" });
    expect(last.proves).toMatch(/balance 0\.000000 -> 2\.000000/);
    const flow = (await call("GET", "/api/state")).json.gatewayFlow;
    expect(flow).toMatchObject({ mintTxHash: "0x2222", transferId: "transfer-1" });
    expect(flow.pendingIntent).toBeUndefined();
  });

  it("refuses a signature from any key but the customer's, and sends nothing to Gateway", async () => {
    world.gatewayBalance = "5";
    await call("POST", "/api/challenge", { action: "gateway-sign", value: "2" });
    const forged = await signAsked(privateKeyToAccount(generatePrivateKey()));
    const res = await call("POST", "/api/complete", { action: "gateway-sign", challengeId: "sign-1", signature: forged });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/not the customer's wallet/);
    expect(world.gatewayTransfers).toHaveLength(0);
    expect(world.gatewayMints).toHaveLength(0);
  });

  it("refuses a missing signature, a replay, and a signature with nothing pending", async () => {
    expect((await call("POST", "/api/complete", { action: "gateway-sign", challengeId: "x", signature: `0x${"11".repeat(65)}` })).status).toBe(409);
    world.gatewayBalance = "5";
    await call("POST", "/api/challenge", { action: "gateway-sign", value: "2" });
    expect((await call("POST", "/api/complete", { action: "gateway-sign", challengeId: "sign-1" })).status).toBe(400);
    const signature = await signAsked();
    expect((await call("POST", "/api/complete", { action: "gateway-sign", challengeId: "sign-1", signature })).status).toBe(200);
    // The same signature again: the intent is no longer pending, so nothing is sent twice.
    expect((await call("POST", "/api/complete", { action: "gateway-sign", challengeId: "sign-1", signature })).status).toBe(409);
    expect(world.gatewayTransfers).toHaveLength(1);
  });
});

describe("overview and errors", () => {
  it("reports an empty state before anything exists", async () => {
    const { json } = await call("GET", "/api/state");
    expect(json).toMatchObject({ appId: "app-1", wallets: null, agentWallet: AGENT, cctp: null, evidence: [] });
    expect(json.balances).toBeUndefined();
  });

  it("reports balances, the Gateway balance and the mandate once the wallet exists", async () => {
    await createWallet();
    world.terms = { agent: AGENT, settlementToken: ARC_TESTNET.usdc, mode: "Autopilot", revoked: false, expiry: 1_900_000_000n, version: 1n, perOrderCap: 2_000_000n, dailyCap: 5_000_000n };
    const { json } = await call("GET", "/api/state");
    expect(json.balances).toEqual({ sourceUsdc: "20.000000", sourceGasWei: "100000000000000000", arcUsdc: "0.000000" });
    expect(json.gateway.total).toBe("0.000000");
    expect(json.mandate).toMatchObject({ version: "1", mode: "Autopilot", perOrderCap: "2.000000", dailyCap: "5.000000" });
  });

  it("rejects an unknown action and an unknown API path, and passes other paths to the page", async () => {
    await createWallet();
    expect((await call("POST", "/api/challenge", { action: "drain-wallet" })).status).toBe(400);
    expect((await call("GET", "/api/nope")).status).toBe(404);
    expect((await fetch(`${base}/index.html`)).status).toBe(418);
  });

  it("has no route that signs: every customer action ends in a challenge", async () => {
    await createWallet();
    world.gatewayBalance = "5";
    for (const action of ["cctp-approve", "cctp-burn", "mandate-approve-usdc", "mandate-set", "gateway-approve", "gateway-deposit", "gateway-sign"]) {
      const { json } = await call("POST", "/api/challenge", { action, amount: "1" });
      expect(Object.keys(json)).toEqual(["challengeId"]);
    }
  });
});
