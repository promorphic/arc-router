/**
 * Audit record export: who authorised what, when, under which mandate version, with the
 * on-chain reference for every line. Reads the Mandate contract's event log on Arc testnet.
 *
 *   pnpm record 0xCustomer            # JSON
 *   pnpm record 0xCustomer --csv      # CSV
 *   pnpm record 0xCustomer --last 20000   # only the last N blocks
 */
import { createPublicClient } from "viem";
import { ARC_TESTNET, MANDATE_ARC_TESTNET, explorerTxUrl, readRecord, transportFor, type Address, type RecordEntry } from "@promorphic/router";

const customer = process.argv[2];
if (!customer || !/^0x[0-9a-fA-F]{40}$/.test(customer)) {
  console.error("usage: pnpm record 0x<customer address> [--csv] [--last <blocks>]");
  process.exit(2);
}
const lastIndex = process.argv.indexOf("--last");
const client = createPublicClient({ transport: transportFor(ARC_TESTNET) });
const head = await client.getBlockNumber();
const fromBlock = lastIndex === -1 ? MANDATE_ARC_TESTNET.deployBlock : head - BigInt(process.argv[lastIndex + 1] ?? "10000");

const entries = await readRecord(customer as Address, { client, fromBlock });

// Block timestamps turn "which block" into "when".
const times = new Map<string, string>();
for (const blockNumber of new Set(entries.map((e) => e.blockNumber))) {
  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  times.set(blockNumber, new Date(Number(block.timestamp) * 1000).toISOString());
}

export interface ExportRow extends RecordEntry {
  timestamp: string;
  chain: string;
  mandateContract: Address;
  explorerUrl: string;
}
const rows: ExportRow[] = entries.map((e) => ({
  ...e,
  timestamp: times.get(e.blockNumber)!,
  chain: ARC_TESTNET.name,
  mandateContract: MANDATE_ARC_TESTNET.address,
  explorerUrl: explorerTxUrl(ARC_TESTNET, e.txHash),
}));

if (process.argv.includes("--csv")) {
  const columns = ["timestamp", "kind", "mandateVersion", "actor", "proposalId", "asset", "recipient", "amount", "reason", "blockNumber", "txHash", "explorerUrl"] as const;
  const cell = (v: unknown) => (v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  console.log(columns.join(","));
  for (const r of rows) console.log(columns.map((c) => cell(r[c])).join(","));
} else {
  console.log(JSON.stringify({ customer, chain: ARC_TESTNET.name, mandateContract: MANDATE_ARC_TESTNET.address, fromBlock: fromBlock.toString(), toBlock: head.toString(), entries: rows }, null, 2));
}
