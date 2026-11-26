/**
 * Chain facts for the USDC settlement leg.
 *
 * Every value here was read from Circle's or Arc's live documentation on
 * 26 Nov 2026 and then checked against the live network by
 * `scripts/verify-chain-facts.ts` (run `pnpm verify:chains`). The source URL
 * sits next to each value. Do not edit a value without re-reading its source.
 *
 * Testnet only. Arc mainnet appears as a chain id for reference and nothing
 * in this repository sends a mainnet transaction.
 */

export type Address = `0x${string}`;

export interface TestnetChain {
  /** Short key used across the router. */
  key: "arcTestnet" | "ethSepolia" | "baseSepolia";
  name: string;
  /** EVM chain id. */
  chainId: number;
  /** CCTP V2 / Gateway domain id. Not the same thing as the chain id. */
  cctpDomain: number;
  /** Identifier used by Circle Wallets and the Circle CLI. */
  circleBlockchain: "ARC-TESTNET" | "ETH-SEPOLIA" | "BASE-SEPOLIA";
  rpcUrlEnv: string;
  defaultRpcUrl: string;
  /** Other public endpoints for the same network, tried when the default one rate-limits. */
  fallbackRpcUrls?: string[];
  explorerUrl: string;
  /** USDC ERC-20 interface, 6 decimals. */
  usdc: Address;
}

/**
 * Arc testnet.
 * Chain id, RPC, explorer: https://docs.arc.io/arc/references/connect-to-arc
 * RPC endpoints: https://docs.arc.io/arc/references/rpc-endpoints
 * USDC address: https://docs.arc.io/arc/references/contract-addresses
 * CCTP domain: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
 * Circle Wallets identifier: https://developers.circle.com/wallets/supported-blockchains
 *
 * USDC is the gas token on Arc. The native balance uses 18 decimals and the
 * ERC-20 interface at `usdc` uses 6. Never mix `msg.value` with `balanceOf()`.
 * Source: https://docs.arc.io/arc/references/evm-differences
 */
export const ARC_TESTNET: TestnetChain = {
  key: "arcTestnet",
  name: "Arc Testnet",
  chainId: 5042002,
  cctpDomain: 26,
  circleBlockchain: "ARC-TESTNET",
  rpcUrlEnv: "ARC_TESTNET_RPC_URL",
  defaultRpcUrl: "https://rpc.testnet.arc.io",
  // Listed on https://docs.arc.io/arc/references/rpc-endpoints. The Blockdaemon endpoint listed
  // there did not answer plain JSON-RPC without credentials when checked, so it is left out.
  fallbackRpcUrls: ["https://rpc.drpc.testnet.arc.io", "https://rpc.quicknode.testnet.arc.io"],
  explorerUrl: "https://explorer.testnet.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
};

/**
 * Ethereum Sepolia.
 * CCTP domain: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
 * USDC address: https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
export const ETH_SEPOLIA: TestnetChain = {
  key: "ethSepolia",
  name: "Ethereum Sepolia",
  chainId: 11155111,
  cctpDomain: 0,
  circleBlockchain: "ETH-SEPOLIA",
  rpcUrlEnv: "ETH_SEPOLIA_RPC_URL",
  defaultRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  explorerUrl: "https://sepolia.etherscan.io",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
};

/**
 * Base Sepolia.
 * CCTP domain: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
 * USDC address: https://developers.circle.com/stablecoins/usdc-contract-addresses
 */
export const BASE_SEPOLIA: TestnetChain = {
  key: "baseSepolia",
  name: "Base Sepolia",
  chainId: 84532,
  cctpDomain: 6,
  circleBlockchain: "BASE-SEPOLIA",
  rpcUrlEnv: "BASE_SEPOLIA_RPC_URL",
  defaultRpcUrl: "https://sepolia.base.org",
  explorerUrl: "https://sepolia.basescan.org",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export const TESTNET_CHAINS: readonly TestnetChain[] = [ARC_TESTNET, ETH_SEPOLIA, BASE_SEPOLIA];

/** Arc mainnet chain id, for reference only. https://docs.arc.io/arc/references/connect-to-arc */
export const ARC_MAINNET_CHAIN_ID = 5042;

/**
 * CCTP V2 testnet contracts. The same address on Ethereum Sepolia, Base
 * Sepolia and Arc Testnet.
 * Source: https://developers.circle.com/cctp/references/contract-addresses
 *
 * CCTP V1 is not used anywhere: its deprecation completes on 1 Dec 2026.
 * Source: https://developers.circle.com/cctp/migration-from-v1-to-v2
 */
export const CCTP_V2_TESTNET = {
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  tokenMinterV2: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
  messageV2: "0xbaC0179bB358A8936169a63408C8481D582390C4",
} as const satisfies Record<string, Address>;

/**
 * Iris attestation API (sandbox serves all testnets).
 * Source: https://developers.circle.com/cctp/references/technical-guide
 * Rate limit: 40 requests per second; exceeding it blocks for 5 minutes.
 */
export const IRIS_SANDBOX_URL = "https://iris-api-sandbox.circle.com";

/**
 * minFinalityThreshold values for depositForBurn.
 * Source: https://developers.circle.com/cctp/references/technical-guide#finality-thresholds
 */
export const CCTP_FINALITY = {
  /** Fast Transfer: attested at "confirmed". Carries a fee, read from the fee API. */
  fast: 1000,
  /** Standard Transfer: attested at "finalized". No fee. */
  standard: 2000,
} as const;

/**
 * Gateway testnet. Permissionless, no API key.
 * API base: https://developers.circle.com/gateway/quickstarts/unified-balance
 * Contracts: https://developers.circle.com/gateway/references/contract-addresses
 * (also returned by GET /v1/info, which is what verify-chain-facts checks)
 */
export const GATEWAY_TESTNET = {
  apiUrl: "https://gateway-api-testnet.circle.com",
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
} as const;

/**
 * USYC on Arc testnet. Testnet only in this repository; mainnet USYC is
 * enabled per customer and is outside this codebase's scope.
 * Source: https://docs.arc.io/arc/references/contract-addresses
 * The Entitlements address is printed in lowercase on that page.
 */
export const USYC_ARC_TESTNET = {
  token: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
  entitlements: "0xcc205224862c7641930c87679e98999d23c26113",
  teller: "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
} as const satisfies Record<string, Address>;

export function chainByDomain(domain: number): TestnetChain | undefined {
  return TESTNET_CHAINS.find((c) => c.cctpDomain === domain);
}

export function rpcUrl(chain: TestnetChain, env: Record<string, string | undefined> = process.env): string {
  return env[chain.rpcUrlEnv] || chain.defaultRpcUrl;
}

export function explorerTxUrl(chain: TestnetChain, hash: string): string {
  return `${chain.explorerUrl}/tx/${hash}`;
}
