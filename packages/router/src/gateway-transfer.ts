/**
 * Gateway: funding an action on one chain from a USDC balance deposited on another (milestone 1c).
 *
 *   1. The depositor approves and calls `GatewayWallet.deposit(token, value)` on the source chain.
 *      The deposit counts once it is final (about 65 blocks on Ethereum, about 1 on Arc).
 *   2. The depositor signs a burn intent (EIP-712). Nothing moves on the source chain yet.
 *   3. Gateway's API checks the intent against the balance and returns an attestation.
 *   4. Anyone submits `GatewayMinter.gatewayMint(attestation, signature)` on the destination chain;
 *      USDC is minted to the recipient named in the intent.
 *
 * The depositor's key signs steps 1 and 2 only. This module never holds it: it builds calldata
 * and typed data for the depositor's wallet to sign, and talks to Gateway's API.
 *
 * Sources:
 *   contracts   https://developers.circle.com/gateway/references/contract-interfaces-and-events
 *   burn intent https://developers.circle.com/gateway/howtos/transfer-unified-usdc-balance
 *   fields      https://developers.circle.com/gateway/references/technical-guide
 *   API         https://developers.circle.com/api-reference/gateway/all/create-transfer-attestation
 *   fees        https://developers.circle.com/gateway/references/fees
 */
import {
  createPublicClient,
  encodeFunctionData,
  hexToBigInt,
  pad,
  parseAbi,
  recoverTypedDataAddress,
  type Account,
  type Hex,
  type WalletClient,
} from "viem";
import { GATEWAY_TESTNET, type Address, type TestnetChain } from "./chains.ts";
import { viemChain } from "./cctp.ts";
import { transportFor } from "./rpc.ts";

export const gatewayWalletAbi = parseAbi(["function deposit(address token, uint256 value)"]);
export const gatewayMinterAbi = parseAbi(["function gatewayMint(bytes attestationPayload, bytes signature)"]);

/** Calldata for the depositor's `GatewayWallet.deposit`. The token must be approved to the GatewayWallet first. */
export function encodeGatewayDeposit(token: Address, value: bigint): Hex {
  if (value <= 0n) throw new Error("deposit value must be positive");
  return encodeFunctionData({ abi: gatewayWalletAbi, functionName: "deposit", args: [token, value] });
}

/** The EIP-712 domain has a name and a version only: no chain id and no verifying contract. */
export const BURN_INTENT_DOMAIN = { name: "GatewayWallet", version: "1" } as const;

export const BURN_INTENT_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

export interface TransferSpec {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceContract: Hex;
  destinationContract: Hex;
  sourceToken: Hex;
  destinationToken: Hex;
  sourceDepositor: Hex;
  destinationRecipient: Hex;
  sourceSigner: Hex;
  destinationCaller: Hex;
  value: bigint;
  salt: Hex;
  hookData: Hex;
}

export interface BurnIntent {
  /** Source-chain block after which the intent can no longer be used. */
  maxBlockHeight: bigint;
  /** The most Gateway may charge, in token base units, on top of `spec.value`. */
  maxFee: bigint;
  spec: TransferSpec;
}

const bytes32 = (address: Address): Hex => pad(address.toLowerCase() as Address, { size: 32 });
const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

/**
 * The transfer the depositor will be asked to sign: `value` USDC from their Gateway balance on
 * `source`, minted to `recipient` on `destination`. Any address may submit the mint.
 */
export function buildTransferSpec(p: {
  source: TestnetChain;
  destination: TestnetChain;
  depositor: Address;
  recipient: Address;
  value: bigint;
  /** 32 random bytes; makes the intent unique. */
  salt: Hex;
}): TransferSpec {
  if (p.value <= 0n) throw new Error("transfer value must be positive");
  if (!/^0x[0-9a-fA-F]{64}$/.test(p.salt)) throw new Error("salt must be 32 bytes");
  return {
    version: 1,
    sourceDomain: p.source.cctpDomain,
    destinationDomain: p.destination.cctpDomain,
    sourceContract: bytes32(GATEWAY_TESTNET.gatewayWallet),
    destinationContract: bytes32(GATEWAY_TESTNET.gatewayMinter),
    sourceToken: bytes32(p.source.usdc),
    destinationToken: bytes32(p.destination.usdc),
    sourceDepositor: bytes32(p.depositor),
    destinationRecipient: bytes32(p.recipient),
    // The depositor signs their own intent; no delegate is involved.
    sourceSigner: bytes32(p.depositor),
    destinationCaller: ZERO_BYTES32,
    value: p.value,
    salt: p.salt,
    hookData: "0x",
  };
}

/** JSON form used by Gateway's API and by wallet signing endpoints: uint256 fields as decimal strings. */
export function burnIntentToJson(intent: BurnIntent) {
  return {
    maxBlockHeight: intent.maxBlockHeight.toString(),
    maxFee: intent.maxFee.toString(),
    spec: { ...intent.spec, value: intent.spec.value.toString() },
  };
}

export function burnIntentFromJson(json: ReturnType<typeof burnIntentToJson>): BurnIntent {
  return { maxBlockHeight: BigInt(json.maxBlockHeight), maxFee: BigInt(json.maxFee), spec: { ...json.spec, value: BigInt(json.spec.value) } };
}

/** The complete EIP-712 document for a burn intent, as a JSON string a wallet can be asked to sign. */
export function burnIntentTypedDataJson(intent: BurnIntent): string {
  return JSON.stringify({ types: BURN_INTENT_TYPES, domain: BURN_INTENT_DOMAIN, primaryType: "BurnIntent", message: burnIntentToJson(intent) });
}

/** Who signed this burn intent. Checked before anything is sent to Gateway. */
export function recoverBurnIntentSigner(intent: BurnIntent, signature: Hex): Promise<Address> {
  const { EIP712Domain: _domain, ...types } = BURN_INTENT_TYPES;
  return recoverTypedDataAddress({ domain: BURN_INTENT_DOMAIN, types, primaryType: "BurnIntent", message: intent, signature });
}

interface ApiOptions {
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

async function gatewayPost<T>(path: string, body: unknown, opts: ApiOptions): Promise<T> {
  const res = await (opts.fetchImpl ?? fetch)(`${opts.apiUrl ?? GATEWAY_TESTNET.apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // keep the raw text
    }
    throw new Error(`Gateway ${path} returned ${res.status}: ${message}`);
  }
  return JSON.parse(text) as T;
}

/**
 * Asks Gateway what a transfer needs: the fee cap and the expiry block it would accept.
 * `POST /v1/estimate` takes the spec and returns the burn intent filled in. Fees are set by
 * Circle and differ by source chain, so they are fetched for each transfer, never hardcoded.
 */
export async function estimateBurnIntent(spec: TransferSpec, opts: ApiOptions = {}): Promise<BurnIntent> {
  const [first] = await gatewayPost<{ burnIntent: { maxBlockHeight: string; maxFee: string } }[]>(
    "/v1/estimate",
    [{ spec: { ...spec, value: spec.value.toString() } }],
    opts,
  );
  if (!first?.burnIntent?.maxFee || !first.burnIntent.maxBlockHeight) throw new Error("Gateway /v1/estimate returned no fee");
  // Our own spec is kept: only the two numbers are taken from the response.
  return { maxBlockHeight: BigInt(first.burnIntent.maxBlockHeight), maxFee: BigInt(first.burnIntent.maxFee), spec };
}

export interface TransferAttestation {
  transferId: string;
  /** Passed to `gatewayMint` as `attestationPayload`. */
  attestation: Hex;
  /** Gateway's signature over the attestation; passed to `gatewayMint` as `signature`. */
  signature: Hex;
  /** Destination-chain block after which the attestation expires (about 10 minutes). */
  expirationBlock?: string;
  fees?: { total?: string; token?: string };
}

/** Submits a signed burn intent. Gateway debits the depositor's balance and returns the attestation to mint with. */
export async function requestTransferAttestation(intent: BurnIntent, signature: Hex, opts: ApiOptions = {}): Promise<TransferAttestation> {
  const out = await gatewayPost<TransferAttestation>("/v1/transfer", [{ burnIntent: burnIntentToJson(intent), signature }], opts);
  if (!out.attestation || !out.signature) throw new Error("Gateway /v1/transfer returned no attestation");
  return out;
}

/** Submits the mint on the destination chain. The caller only pays gas; USDC goes to the intent's recipient. */
export async function gatewayMint(params: {
  wallet: WalletClient & { account: Account };
  destination: TestnetChain;
  attestation: Hex;
  signature: Hex;
}): Promise<Hex> {
  const chain = viemChain(params.destination);
  const client = createPublicClient({ chain, transport: transportFor(params.destination) });
  const hash = await params.wallet.writeContract({
    chain,
    account: params.wallet.account,
    address: GATEWAY_TESTNET.gatewayMinter,
    abi: gatewayMinterAbi,
    functionName: "gatewayMint",
    args: [params.attestation, params.signature],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`gatewayMint reverted: ${hash}`);
  return hash;
}

/** The most a transfer can take from the depositor's Gateway balance. */
export function maxDebit(intent: BurnIntent): bigint {
  return intent.spec.value + intent.maxFee;
}

/** A bytes32-padded address back to an address, for display. */
export function bytes32ToAddress(value: Hex): Address {
  return `0x${hexToBigInt(value).toString(16).padStart(40, "0")}` as Address;
}
