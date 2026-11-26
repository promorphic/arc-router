/**
 * Checks every hardcoded chain fact in packages/router/src/chains.ts against
 * the live testnets and Circle's testnet APIs. Read-only: no key, no
 * transaction. Exits non-zero if any check fails.
 *
 *   pnpm verify:chains
 */
import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_TESTNET,
  BASE_SEPOLIA,
  CCTP_FINALITY,
  CCTP_V2_TESTNET,
  ETH_SEPOLIA,
  GATEWAY_TESTNET,
  IRIS_SANDBOX_URL,
  TESTNET_CHAINS,
  USYC_ARC_TESTNET,
  rpcUrl,
  type Address,
} from "@promorphic/router";

const abi = parseAbi([
  "function localDomain() view returns (uint32)",
  "function localMessageTransmitter() view returns (address)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function asset() view returns (address)",
  "function share() view returns (address)",
  "function authority() view returns (address)",
]);

const rows: { check: string; expected: string; got: string; ok: boolean }[] = [];
function record(check: string, expected: unknown, got: unknown) {
  const e = String(expected).toLowerCase();
  const g = String(got).toLowerCase();
  rows.push({ check, expected: String(expected), got: String(got), ok: e === g });
}
async function attempt(check: string, expected: unknown, fn: () => Promise<unknown>) {
  try {
    record(check, expected, await fn());
  } catch (err) {
    record(check, expected, `error: ${(err as Error).message.split("\n")[0]}`);
  }
}
const hasCode = async (client: PublicClient, address: Address) =>
  ((await client.getCode({ address })) ?? "0x").length > 2 ? "deployed" : "no code";

for (const chain of TESTNET_CHAINS) {
  const client = createPublicClient({ transport: http(rpcUrl(chain)) });
  const n = chain.name;
  await attempt(`${n}: chain id`, chain.chainId, () => client.getChainId());
  await attempt(`${n}: CCTP domain (MessageTransmitterV2.localDomain)`, chain.cctpDomain, () =>
    client.readContract({ address: CCTP_V2_TESTNET.messageTransmitterV2, abi, functionName: "localDomain" }),
  );
  await attempt(`${n}: TokenMessengerV2 points at MessageTransmitterV2`, CCTP_V2_TESTNET.messageTransmitterV2, () =>
    client.readContract({ address: CCTP_V2_TESTNET.tokenMessengerV2, abi, functionName: "localMessageTransmitter" }),
  );
  await attempt(`${n}: TokenMinterV2`, "deployed", () => hasCode(client, CCTP_V2_TESTNET.tokenMinterV2));
  await attempt(`${n}: MessageV2`, "deployed", () => hasCode(client, CCTP_V2_TESTNET.messageV2));
  await attempt(`${n}: USDC symbol`, "USDC", () => client.readContract({ address: chain.usdc, abi, functionName: "symbol" }));
  await attempt(`${n}: USDC decimals (ERC-20 interface)`, 6, () =>
    client.readContract({ address: chain.usdc, abi, functionName: "decimals" }),
  );
  await attempt(`${n}: GatewayWallet`, "deployed", () => hasCode(client, GATEWAY_TESTNET.gatewayWallet));
  await attempt(`${n}: GatewayMinter`, "deployed", () => hasCode(client, GATEWAY_TESTNET.gatewayMinter));
}

// Arc mainnet: chain id only, read-only.
await attempt("Arc mainnet: chain id (read only)", ARC_MAINNET_CHAIN_ID, () =>
  createPublicClient({ transport: http("https://rpc.mainnet.arc.io") }).getChainId(),
);

// USYC on Arc testnet.
{
  const arc = createPublicClient({ transport: http(rpcUrl(ARC_TESTNET)) });
  await attempt("USYC: token symbol", "USYC", () =>
    arc.readContract({ address: USYC_ARC_TESTNET.token, abi, functionName: "symbol" }),
  );
  await attempt("USYC: Teller.asset() is Arc USDC", ARC_TESTNET.usdc, () =>
    arc.readContract({ address: USYC_ARC_TESTNET.teller, abi, functionName: "asset" }),
  );
  await attempt("USYC: Teller.share() is the USYC token", USYC_ARC_TESTNET.token, () =>
    arc.readContract({ address: USYC_ARC_TESTNET.teller, abi, functionName: "share" }),
  );
  await attempt("USYC: Teller.authority() is Entitlements", USYC_ARC_TESTNET.entitlements, () =>
    arc.readContract({ address: USYC_ARC_TESTNET.teller, abi, functionName: "authority" }),
  );
}

// Gateway API agrees with the hardcoded contracts and domains.
await attempt("Gateway /v1/info: wallet + minter + domain for each test chain", "match", async () => {
  const info = (await (await fetch(`${GATEWAY_TESTNET.apiUrl}/v1/info`)).json()) as {
    domains: { domain: number; walletContract: { address: string }; minterContract: { address: string } }[];
  };
  for (const chain of TESTNET_CHAINS) {
    const d = info.domains.find((x) => x.domain === chain.cctpDomain);
    if (!d) return `domain ${chain.cctpDomain} missing`;
    if (d.walletContract.address.toLowerCase() !== GATEWAY_TESTNET.gatewayWallet.toLowerCase()) return `wallet differs on ${chain.name}`;
    if (d.minterContract.address.toLowerCase() !== GATEWAY_TESTNET.gatewayMinter.toLowerCase()) return `minter differs on ${chain.name}`;
  }
  return "match";
});

// CCTP fee API: a Fast Transfer route into Arc exists from both source testnets.
const fastFees: string[] = [];
for (const source of [ETH_SEPOLIA, BASE_SEPOLIA]) {
  await attempt(`Iris fees ${source.name} -> Arc Testnet: Fast (threshold ${CCTP_FINALITY.fast}) offered`, "yes", async () => {
    const fees = (await (
      await fetch(`${IRIS_SANDBOX_URL}/v2/burn/USDC/fees/${source.cctpDomain}/${ARC_TESTNET.cctpDomain}`)
    ).json()) as { finalityThreshold: number; minimumFee: number }[];
    const fast = fees.find((f) => f.finalityThreshold === CCTP_FINALITY.fast);
    if (fast) fastFees.push(`${source.name} -> Arc Testnet fast fee: ${fast.minimumFee} bps`);
    return fast ? "yes" : "no";
  });
}

const width = Math.max(...rows.map((r) => r.check.length));
for (const r of rows) {
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.check.padEnd(width)}  ${r.ok ? r.got : `expected ${r.expected}, got ${r.got}`}`);
}
for (const line of fastFees) console.log(`info  ${line} (read at ${new Date().toISOString()}; set by Circle, fetch before each burn)`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} checks passed`);
process.exit(failed ? 1 : 0);
