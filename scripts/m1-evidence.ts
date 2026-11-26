/**
 * Milestone 1 evidence run. Re-runs the testnet flow end to end and prints an evidence block
 * to paste into MILESTONES.md.
 *
 *   pnpm m1:evidence                       # Ethereum Sepolia -> Arc Testnet, Fast Transfer, 1 USDC
 *   pnpm m1:evidence --source base         # Base Sepolia as the source
 *   pnpm m1:evidence --amount 2.5 --standard
 *
 * Sends TESTNET transactions only. It refuses to run against any chain id that is not one of
 * the three testnets in packages/router/src/chains.ts.
 *
 * Signer: TEST_SOURCE_PRIVATE_KEY, a test wallet holding faucet funds, standing in for the
 * customer's funding wallet. Destination: ARC_USER_WALLET_ADDRESS, the customer's Circle
 * user-controlled wallet on Arc testnet.
 *
 * Covers 1a and 1c. 1b (Agent Wallet through the Mandate contract) is driven by the Circle CLI,
 * because the Agent Wallet's session belongs to the customer; it is not part of this script yet.
 */
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARC_TESTNET,
  BASE_SEPOLIA,
  ETH_SEPOLIA,
  TESTNET_CHAINS,
  baseUnitsToUsdc,
  burn,
  erc20Abi,
  explorerTxUrl,
  mint,
  readUnifiedBalance,
  rpcUrl,
  usdcToBaseUnits,
  viemChain,
  waitForAttestation,
  type Address,
  type TestnetChain,
} from "@promorphic/router";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(2);
  }
  return v;
}

const source: TestnetChain = arg("source") === "base" ? BASE_SEPOLIA : ETH_SEPOLIA;
const destination = ARC_TESTNET;
const amount = usdcToBaseUnits(arg("amount") ?? "1");
const fast = !process.argv.includes("--standard");

const account = privateKeyToAccount(requireEnv("TEST_SOURCE_PRIVATE_KEY") as Hex);
const recipient = requireEnv("ARC_USER_WALLET_ADDRESS") as Address;

// Guard: every RPC we are about to sign for must be one of the known testnets.
for (const chain of [source, destination]) {
  const id = await createPublicClient({ transport: http(rpcUrl(chain)) }).getChainId();
  if (id !== chain.chainId || !TESTNET_CHAINS.some((c) => c.chainId === id)) {
    console.error(`refusing to run: ${chain.rpcUrlEnv} answers chain id ${id}, expected testnet ${chain.chainId}`);
    process.exit(1);
  }
}

const sourceWallet = createWalletClient({ account, chain: viemChain(source), transport: http(rpcUrl(source)) });
const arcWallet = createWalletClient({ account, chain: viemChain(destination), transport: http(rpcUrl(destination)) });
const arcClient = createPublicClient({ transport: http(rpcUrl(destination)) });
const balanceOnArc = (who: Address) =>
  arcClient.readContract({ address: destination.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });

console.log(`1a. CCTP V2 ${fast ? "Fast" : "Standard"} Transfer: ${baseUnitsToUsdc(amount)} USDC, ${source.name} -> ${destination.name}`);
console.log(`    from test wallet ${account.address} to user-controlled wallet ${recipient}`);

const before = await balanceOnArc(recipient);
const burnStarted = Date.now();
const burned = await burn({ wallet: sourceWallet, source, destination, amount, recipient, fast });
console.log(`    burn   ${burned.burnTxHash}`);
const attested = await waitForAttestation(source.cctpDomain, burned.burnTxHash);
console.log(`    attested after ${(attested.waitedMs / 1000).toFixed(1)} s`);
const mintTxHash = await mint({ wallet: arcWallet, destination, message: attested.message, attestation: attested.attestation });
const totalSeconds = ((Date.now() - burnStarted) / 1000).toFixed(1);
const after = await balanceOnArc(recipient);
console.log(`    mint   ${mintTxHash}`);

console.log(`\n1c. Gateway unified balance for the user-controlled wallet`);
const unified = await readUnifiedBalance(recipient);
for (const b of unified.perDomain) console.log(`    ${b.chain.padEnd(18)} ${b.balance}`);
console.log(`    total              ${unified.total}`);

const today = new Date().toISOString().slice(0, 10);
console.log(`
---------------- evidence block (paste into MILESTONES.md) ----------------
| ${today} | M1(a) | ${source.name} | [burn ${burned.burnTxHash}](${explorerTxUrl(source, burned.burnTxHash)}) | ${baseUnitsToUsdc(amount)} USDC burned through TokenMessengerV2.depositForBurn (CCTP V2, ${fast ? `Fast Transfer, fee ${burned.feeBps} bps, maxFee ${baseUnitsToUsdc(burned.maxFee)}` : "Standard Transfer, no fee"}) for the user-controlled wallet ${recipient} on ${destination.name}. |
| ${today} | M1(a) | ${destination.name} | [mint ${mintTxHash}](${explorerTxUrl(destination, mintTxHash)}) | MessageTransmitterV2.receiveMessage minted USDC to the user-controlled wallet: balance ${baseUnitsToUsdc(before)} -> ${baseUnitsToUsdc(after)}. Attestation took ${(attested.waitedMs / 1000).toFixed(1)} s; burn to mint ${totalSeconds} s. |
| ${today} | M1(c) | Circle Gateway testnet | \`POST /v1/balances\` for ${recipient} | Unified USDC balance read by the router: ${unified.perDomain.map((b) => `${b.chain} ${b.balance}`).join(", ")}; total ${unified.total}. |
---------------------------------------------------------------------------`);
