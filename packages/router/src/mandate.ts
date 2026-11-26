/**
 * Client for the Mandate contract (contracts/src/Mandate.sol): calldata builders for the
 * customer's transactions, and a reader that turns the contract's event log into the audit
 * record. The design is in docs/mandate.md.
 */
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Hex,
  type PublicClient,
} from "viem";
import { ARC_TESTNET, type Address } from "./chains.ts";
import { transportFor } from "./rpc.ts";

/**
 * Mandate on Arc testnet. Deployed 26 Nov 2026 from the test wallet, which has no role in the
 * contract (there is no owner or admin).
 * Deploy transaction: 0x3e2cabf82f132f72be57b51649c0e5e9470b4d053a58d54232c909e9a2dbdcd6
 */
export const MANDATE_ARC_TESTNET = {
  address: "0x2D1CBBEea337a30dF22C0446dB2528B98B543D10",
  deployTxHash: "0x3e2cabf82f132f72be57b51649c0e5e9470b4d053a58d54232c909e9a2dbdcd6",
  deployBlock: 74194366n,
} as const satisfies { address: Address; deployTxHash: Hex; deployBlock: bigint };

/** The Arc testnet RPC refuses wide log queries ("requested range too large"), so logs are read in windows. */
const LOG_WINDOW = 10_000n;

export const MandateMode = { Copilot: 0, Autopilot: 1 } as const;
export type MandateModeName = keyof typeof MandateMode;

/** Index matches the contract's `Reason` enum. */
export const MANDATE_REASONS = [
  "None",
  "Revoked",
  "Expired",
  "AssetNotAllowed",
  "RecipientNotAllowed",
  "OverPerOrderCap",
  "OverDailyCap",
  "NotApproved",
] as const;
export type MandateReason = (typeof MANDATE_REASONS)[number];

export const mandateAbi = parseAbi([
  "struct Terms { address agent; address settlementToken; uint8 mode; bool revoked; uint64 expiry; uint64 version; uint256 perOrderCap; uint256 dailyCap; }",
  "function setMandate(address agent, address settlementToken, uint8 mode, uint256 perOrderCap, uint256 dailyCap, uint64 expiry, address[] assets, address[] recipients) returns (uint64 version)",
  "function revoke()",
  "function approve(bytes32 proposalId, address asset, address recipient, uint256 amount)",
  "function execute(address customer, bytes32 proposalId, address asset, address recipient, uint256 amount) returns (bool executed, uint8 reason)",
  "function preview(address customer, bytes32 proposalId, address asset, address recipient, uint256 amount) view returns (uint8)",
  "function terms(address customer) view returns (Terms)",
  "function spentInWindow(address customer) view returns (uint256)",
  "function proposalStatus(address customer, bytes32 proposalId) view returns (uint8)",
  "event MandateSet(address indexed customer, uint64 indexed version, address indexed agent, address settlementToken, uint8 mode, uint256 perOrderCap, uint256 dailyCap, uint64 expiry, address[] assets, address[] recipients)",
  "event MandateRevoked(address indexed customer, uint64 indexed version)",
  "event ProposalApproved(address indexed customer, bytes32 indexed proposalId, uint64 indexed version, address approver, address asset, address recipient, uint256 amount)",
  "event ProposalExecuted(address indexed customer, bytes32 indexed proposalId, uint64 indexed version, address agent, address asset, address recipient, uint256 amount)",
  "event ProposalRejected(address indexed customer, bytes32 indexed proposalId, uint64 indexed version, address agent, address asset, address recipient, uint256 amount, uint8 reason)",
  "error NoMandate()",
  "error NotAgent()",
  "error ProposalAlreadyDecided()",
  "error InvalidTerms()",
  "error TransferFailed()",
]);

/** The on-chain id of a proposal: the hash of its human-readable reference. */
export function proposalId(reference: string): Hex {
  return keccak256(stringToHex(reference));
}

export interface MandateTermsInput {
  agent: Address;
  settlementToken: Address;
  mode: MandateModeName;
  /** Settlement-token base units. */
  perOrderCap: bigint;
  dailyCap: bigint;
  /** Unix seconds. */
  expiry: bigint;
  assets: Address[];
  recipients: Address[];
}

/** Calldata for the customer's `setMandate` transaction. */
export function encodeSetMandate(t: MandateTermsInput): Hex {
  if (t.perOrderCap <= 0n || t.perOrderCap > t.dailyCap) throw new Error("per-order cap must be positive and no larger than the daily cap");
  return encodeFunctionData({
    abi: mandateAbi,
    functionName: "setMandate",
    args: [t.agent, t.settlementToken, MandateMode[t.mode], t.perOrderCap, t.dailyCap, t.expiry, t.assets, t.recipients],
  });
}

/** Calldata for the customer's Copilot approval of one proposal. */
export function encodeApproveProposal(p: { reference: string; asset: Address; recipient: Address; amount: bigint }): Hex {
  return encodeFunctionData({
    abi: mandateAbi,
    functionName: "approve",
    args: [proposalId(p.reference), p.asset, p.recipient, p.amount],
  });
}

export interface MandateTerms {
  agent: Address;
  settlementToken: Address;
  mode: MandateModeName;
  revoked: boolean;
  expiry: bigint;
  version: bigint;
  perOrderCap: bigint;
  dailyCap: bigint;
}

function arcClient(): PublicClient {
  return createPublicClient({ transport: transportFor(ARC_TESTNET) });
}

/** The customer's current mandate, or undefined if they have never set one. */
export async function readTerms(
  customer: Address,
  opts: { client?: PublicClient; mandate?: Address } = {},
): Promise<MandateTerms | undefined> {
  const client = opts.client ?? arcClient();
  const t = await client.readContract({
    address: opts.mandate ?? MANDATE_ARC_TESTNET.address,
    abi: mandateAbi,
    functionName: "terms",
    args: [customer],
  });
  if (t.version === 0n) return undefined;
  return { ...t, mode: t.mode === MandateMode.Autopilot ? "Autopilot" : "Copilot" };
}

/** One line of the audit record. */
export interface RecordEntry {
  kind: "MandateSet" | "MandateRevoked" | "ProposalApproved" | "ProposalExecuted" | "ProposalRejected";
  customer: Address;
  mandateVersion: string;
  proposalId?: Hex;
  /** Who authorised or acted: the customer for a mandate or approval, the agent for an execution. */
  actor?: Address;
  asset?: Address;
  recipient?: Address;
  /** Settlement-token base units, as a string. */
  amount?: string;
  reason?: MandateReason;
  blockNumber: string;
  txHash: Hex;
  logIndex: number;
}

/**
 * The audit record for one customer: every mandate change, approval, execution and rejection,
 * in chain order, each with the transaction that carries it.
 */
export async function readRecord(
  customer: Address,
  opts: { client?: PublicClient; mandate?: Address; fromBlock?: bigint; toBlock?: bigint } = {},
): Promise<RecordEntry[]> {
  const client = opts.client ?? arcClient();
  const address = opts.mandate ?? MANDATE_ARC_TESTNET.address;
  const head = opts.toBlock ?? (await client.getBlockNumber());
  const logs = [];
  for (let from = opts.fromBlock ?? MANDATE_ARC_TESTNET.deployBlock; from <= head; from += LOG_WINDOW) {
    const to = from + LOG_WINDOW - 1n < head ? from + LOG_WINDOW - 1n : head;
    logs.push(...(await client.getContractEvents({ address, abi: mandateAbi, args: { customer }, fromBlock: from, toBlock: to })));
  }
  const entries = logs.map((log): RecordEntry => {
    const a = log.args as Record<string, unknown>;
    const base = {
      customer,
      mandateVersion: String(a.version),
      blockNumber: String(log.blockNumber),
      txHash: log.transactionHash as Hex,
      logIndex: Number(log.logIndex),
    };
    const proposal = {
      proposalId: a.proposalId as Hex,
      asset: a.asset as Address,
      recipient: a.recipient as Address,
      amount: a.amount === undefined ? undefined : String(a.amount),
    };
    switch (log.eventName) {
      case "MandateSet":
        return { ...base, kind: "MandateSet", actor: customer };
      case "MandateRevoked":
        return { ...base, kind: "MandateRevoked", actor: customer };
      case "ProposalApproved":
        return { ...base, ...proposal, kind: "ProposalApproved", actor: a.approver as Address };
      case "ProposalExecuted":
        return { ...base, ...proposal, kind: "ProposalExecuted", actor: a.agent as Address };
      default:
        return {
          ...base,
          ...proposal,
          kind: "ProposalRejected",
          actor: a.agent as Address,
          reason: MANDATE_REASONS[Number(a.reason)] ?? "None",
        };
    }
  });
  return entries.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || x.logIndex - y.logIndex);
}
