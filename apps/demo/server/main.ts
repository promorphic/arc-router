/**
 * Local demo server: the API in ./api.ts plus the Vite dev server for the page, on one port.
 * Testnet only. Run with `pnpm demo` from the repository root.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createServer as createViteServer } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import {
  ARC_TESTNET,
  CircleWalletsClient,
  MANDATE_ARC_TESTNET,
  TESTNET_CHAINS,
  erc20Abi,
  fetchFee,
  mandateAbi,
  mint,
  readRecord,
  readTerms,
  readUnifiedBalance,
  transportFor,
  viemChain,
  waitForAttestation,
  type Address,
  type TestnetChain,
} from "@promorphic/router";
import { createApi, type ApiDeps } from "./api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const envFile = resolve(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(2);
  }
  return v;
}

// Guard: every RPC must answer with the testnet chain id we expect before anything is signed.
for (const chain of TESTNET_CHAINS) {
  const id = await createPublicClient({ transport: transportFor(chain) }).getChainId();
  if (id !== chain.chainId) {
    console.error(`refusing to start: ${chain.rpcUrlEnv} answers chain id ${id}, expected testnet ${chain.chainId}`);
    process.exit(1);
  }
}

const relayer = privateKeyToAccount(requireEnv("TEST_SOURCE_PRIVATE_KEY") as Hex);
const client = (chain: TestnetChain) => createPublicClient({ transport: transportFor(chain) });

/**
 * The customer's Circle Agent Wallet on Arc testnet. Taken from ARC_AGENT_WALLET_ADDRESS, or
 * asked of the Circle CLI once the customer has logged in (`circle wallet login --testnet`).
 */
let agentWallet = (process.env.ARC_AGENT_WALLET_ADDRESS || undefined) as Address | undefined;
let agentCheckedAt = 0;
async function resolveAgentWallet(): Promise<Address | undefined> {
  if (agentWallet || Date.now() - agentCheckedAt < 15_000) return agentWallet;
  agentCheckedAt = Date.now();
  const out = await new Promise<string>((done) =>
    execFile(
      "pnpm",
      ["exec", "circle", "wallet", "list", "--type", "agent", "--chain", ARC_TESTNET.circleBlockchain, "--output", "json"],
      { cwd: repoRoot, timeout: 20_000 },
      (_err, stdout) => done(String(stdout ?? "")),
    ),
  );
  agentWallet = out.match(/0x[0-9a-fA-F]{40}/)?.[0] as Address | undefined;
  return agentWallet;
}

const deps: ApiDeps = {
  appId: requireEnv("CIRCLE_APP_ID"),
  circle: new CircleWalletsClient({ apiKey: requireEnv("CIRCLE_API_KEY") }),
  agentWallet: resolveAgentWallet,
  // The test wallet doubles as the allowlisted recipient: a stand-in for an issuer's settlement address.
  allowedRecipient: relayer.address,
  statePath: resolve(repoRoot, "apps/demo/.demo-state.json"),
  evidencePath: resolve(repoRoot, "evidence/m1.json"),
  chain: {
    usdcBalance: (chain, who) => client(chain).readContract({ address: chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] }),
    nativeBalance: (chain, who) => client(chain).getBalance({ address: who }),
    fetchFee: (source, destination, threshold) => fetchFee(source, destination, threshold),
    waitForAttestation: (domain, hash) => waitForAttestation(domain, hash),
    relayMint: (message, attestation) =>
      mint({
        wallet: createWalletClient({ account: relayer, chain: viemChain(ARC_TESTNET), transport: transportFor(ARC_TESTNET) }),
        destination: ARC_TESTNET,
        message,
        attestation,
      }),
    unifiedBalance: (who) => readUnifiedBalance(who),
    mandateTerms: (customer) => readTerms(customer),
    mandateRecord: (customer) => readRecord(customer),
    spentInWindow: (customer) =>
      client(ARC_TESTNET).readContract({ address: MANDATE_ARC_TESTNET.address, abi: mandateAbi, functionName: "spentInWindow", args: [customer] }),
  },
};

const api = createApi(deps);
const vite = await createViteServer({
  root: resolve(here, ".."),
  server: { middlewareMode: true },
  appType: "spa",
  // Circle's web SDK pulls in Node built-ins (buffer, stream, util, crypto) that browsers lack.
  plugins: [nodePolyfills({ include: ["buffer", "stream", "util", "crypto", "process", "events", "vm"] })],
});
const port = Number(process.env.PORT ?? 5180);

createHttpServer((req, res) => {
  void api(req, res, () => vite.middlewares(req, res));
}).listen(port, "127.0.0.1", () => {
  console.log(`Promorphic demo (testnet) on http://localhost:${port}`);
  console.log(`relayer / allowlisted test recipient: ${relayer.address}`);
});
