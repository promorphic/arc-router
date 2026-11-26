/**
 * CCTP V2 transfer of the USDC leg: burn on the source chain, wait for Circle's
 * attestation, mint on the destination chain (milestone 1a).
 *
 * Interfaces: https://developers.circle.com/cctp/references/contract-interfaces
 * Attestation and fee API: https://developers.circle.com/cctp/references/technical-guide
 * Fees: https://developers.circle.com/cctp/concepts/fees
 *
 * V2 only. Nothing here touches CCTP V1.
 */
import {
  createPublicClient,
  defineChain,
  http,
  pad,
  parseAbi,
  type Account,
  type Chain,
  type Hex,
  type WalletClient,
} from "viem";
import { CCTP_FINALITY, CCTP_V2_TESTNET, IRIS_SANDBOX_URL, rpcUrl, type Address, type TestnetChain } from "./chains.ts";

export const tokenMessengerV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);
export const messageTransmitterV2Abi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
]);
export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

/** viem chain object for one of the router's testnets. */
export function viemChain(chain: TestnetChain): Chain {
  return defineChain({
    id: chain.chainId,
    name: chain.name,
    // On Arc the gas token is USDC with 18 decimals in its native form; on the Sepolias it is ETH.
    nativeCurrency:
      chain.key === "arcTestnet"
        ? { name: "USDC", symbol: "USDC", decimals: 18 }
        : { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl(chain)] } },
    blockExplorers: { default: { name: "explorer", url: chain.explorerUrl } },
  });
}

/** CCTP addresses are bytes32: an EVM address left-padded with zeros. */
export function addressToBytes32(address: Address): Hex {
  return pad(address, { size: 32 });
}

/** Any caller may submit the mint on the destination chain. */
export const ANY_DESTINATION_CALLER: Hex = `0x${"00".repeat(32)}`;

export interface FeeQuote {
  finalityThreshold: number;
  /** Basis points; may be fractional (for example 0.25). */
  minimumFeeBps: number;
}

/** Current fee for a route at a finality threshold. Set by Circle; read before every burn. */
export async function fetchFee(
  sourceDomain: number,
  destinationDomain: number,
  finalityThreshold: number,
  opts: { irisUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<FeeQuote> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.irisUrl ?? IRIS_SANDBOX_URL}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`);
  if (!res.ok) throw new Error(`Iris fee API returned ${res.status}: ${await res.text()}`);
  const fees = (await res.json()) as { finalityThreshold: number; minimumFee: number }[];
  const match = fees.find((f) => f.finalityThreshold === finalityThreshold);
  if (!match) {
    throw new Error(`no fee entry for finality threshold ${finalityThreshold} on route ${sourceDomain} -> ${destinationDomain}`);
  }
  return { finalityThreshold: match.finalityThreshold, minimumFeeBps: match.minimumFee };
}

/**
 * maxFee for depositForBurn, in USDC base units: the quoted fee rounded up, plus a margin so a
 * small fee change between quote and burn does not revert the burn. The burn reverts on the
 * source chain, with nothing burned, if the actual fee is above maxFee.
 */
export function maxFeeFor(amount: bigint, feeBps: number, marginBps = 1): bigint {
  if (feeBps < 0 || marginBps < 0) throw new Error("fee must not be negative");
  if (feeBps === 0) return 0n;
  // Fractional basis points: scale by 1e6 so 0.325 bps stays exact.
  const scaled = BigInt(Math.round((feeBps + marginBps) * 1_000_000));
  const denominator = 10_000n * 1_000_000n;
  return (amount * scaled + denominator - 1n) / denominator;
}

export interface BurnResult {
  approveTxHash?: Hex;
  burnTxHash: Hex;
  maxFee: bigint;
  feeBps: number;
  fast: boolean;
}

/**
 * Burns `amount` USDC on `source` for minting to `recipient` on `destination`.
 * The signer is the customer's own funding wallet; the router never takes custody.
 */
export async function burn(params: {
  wallet: WalletClient & { account: Account };
  source: TestnetChain;
  destination: TestnetChain;
  amount: bigint;
  recipient: Address;
  fast: boolean;
  fetchImpl?: typeof fetch;
}): Promise<BurnResult> {
  const { wallet, source, destination, amount, recipient, fast } = params;
  const chain = viemChain(source);
  const client = createPublicClient({ chain, transport: http(rpcUrl(source)) });
  const threshold = fast ? CCTP_FINALITY.fast : CCTP_FINALITY.standard;
  const fee = await fetchFee(source.cctpDomain, destination.cctpDomain, threshold, { fetchImpl: params.fetchImpl });
  const maxFee = maxFeeFor(amount, fee.minimumFeeBps);

  let approveTxHash: Hex | undefined;
  const allowance = await client.readContract({
    address: source.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet.account.address, CCTP_V2_TESTNET.tokenMessengerV2],
  });
  if (allowance < amount) {
    approveTxHash = await wallet.writeContract({
      chain,
      account: wallet.account,
      address: source.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [CCTP_V2_TESTNET.tokenMessengerV2, amount],
    });
    await client.waitForTransactionReceipt({ hash: approveTxHash });
  }

  const burnTxHash = await wallet.writeContract({
    chain,
    account: wallet.account,
    address: CCTP_V2_TESTNET.tokenMessengerV2,
    abi: tokenMessengerV2Abi,
    functionName: "depositForBurn",
    args: [
      amount,
      destination.cctpDomain,
      addressToBytes32(recipient),
      source.usdc,
      ANY_DESTINATION_CALLER,
      maxFee,
      threshold,
    ],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: burnTxHash });
  if (receipt.status !== "success") throw new Error(`burn reverted: ${burnTxHash}`);
  return { approveTxHash, burnTxHash, maxFee, feeBps: fee.minimumFeeBps, fast };
}

export interface Attestation {
  message: Hex;
  attestation: Hex;
  /** Milliseconds from the first poll to a complete attestation. */
  waitedMs: number;
}

/** Polls Iris until the burn's message is attested. */
export async function waitForAttestation(
  sourceDomain: number,
  burnTxHash: Hex,
  opts: { irisUrl?: string; pollMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Attestation> {
  const doFetch = opts.fetchImpl ?? fetch;
  const pollMs = opts.pollMs ?? 2_000; // well inside Iris's 40 requests/second limit
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000; // a Standard transfer from Ethereum waits for finality
  const started = Date.now();
  const url = `${opts.irisUrl ?? IRIS_SANDBOX_URL}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`;

  for (;;) {
    const res = await doFetch(url);
    if (res.ok) {
      const body = (await res.json()) as { messages?: { message: Hex; attestation: string; status: string }[] };
      const m = body.messages?.[0];
      if (m && m.status === "complete" && m.attestation.startsWith("0x")) {
        return { message: m.message, attestation: m.attestation as Hex, waitedMs: Date.now() - started };
      }
    } else if (res.status !== 404) {
      // 404 means Iris has not seen the burn yet; anything else is a real error.
      throw new Error(`Iris returned ${res.status}: ${await res.text()}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`no attestation for ${burnTxHash} after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Submits the attested message on the destination chain; USDC is minted to the burn's recipient. */
export async function mint(params: {
  wallet: WalletClient & { account: Account };
  destination: TestnetChain;
  message: Hex;
  attestation: Hex;
}): Promise<Hex> {
  const { wallet, destination, message, attestation } = params;
  const chain = viemChain(destination);
  const client = createPublicClient({ chain, transport: http(rpcUrl(destination)) });
  const hash = await wallet.writeContract({
    chain,
    account: wallet.account,
    address: CCTP_V2_TESTNET.messageTransmitterV2,
    abi: messageTransmitterV2Abi,
    functionName: "receiveMessage",
    args: [message, attestation],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`mint reverted: ${hash}`);
  return hash;
}
