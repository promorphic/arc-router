/**
 * The demo backend's flows, end to end over real HTTP, with Circle and the chains replaced by
 * fakes. Each test is one thing the customer does on the page.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARC_TESTNET,
  CCTP_V2_TESTNET,
  CircleApiError,
  ETH_SEPOLIA,
  MANDATE_ARC_TESTNET,
  USER_ALREADY_INITIALIZED,
  erc20Abi,
  mandateAbi,
  tokenMessengerV2Abi,
  type Address,
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
      createUser: async () => {},
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
      unifiedBalance: async (who) => ({ depositor: who, totalBaseUnits: 0n, total: "0.000000", perDomain: [{ domain: 26, chain: "Arc Testnet", balance: "0" }] }),
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
  world = { wallets: WALLETS, agent: AGENT, initialized: false, arcUsdc: 0n, terms: undefined, relayed: [], txHashes: [] };
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
    expect(first).toMatch(/^promorphic-demo-/);
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
    for (const action of ["cctp-approve", "cctp-burn", "mandate-approve-usdc", "mandate-set"]) {
      const { json } = await call("POST", "/api/challenge", { action, amount: "1" });
      expect(Object.keys(json)).toEqual(["challengeId"]);
    }
  });
});
