/**
 * Prints the Gateway unified USDC balance of an address across the router's
 * test chains (milestone 1c). Read-only.
 *
 *   pnpm gateway:balance 0xYourAddress
 */
import { readUnifiedBalance, type Address } from "@promorphic/router";

const depositor = process.argv[2];
if (!depositor || !/^0x[0-9a-fA-F]{40}$/.test(depositor)) {
  console.error("usage: pnpm gateway:balance 0x<address>");
  process.exit(2);
}

const balance = await readUnifiedBalance(depositor as Address);
console.log(`Gateway unified USDC balance for ${balance.depositor} (testnet)`);
for (const b of balance.perDomain) console.log(`  ${b.chain.padEnd(18)} domain ${String(b.domain).padEnd(3)} ${b.balance}`);
console.log(`  ${"total".padEnd(18)}            ${balance.total}`);
