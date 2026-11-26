/**
 * Gateway unified-balance read (milestone 1c).
 *
 * Read-only. Gateway's balance endpoint is permissionless and takes no API
 * key. Endpoint and shapes:
 * https://developers.circle.com/gateway/quickstarts/unified-balance
 */
import { GATEWAY_TESTNET, TESTNET_CHAINS, chainByDomain, type Address } from "./chains.ts";

export interface GatewayDomainBalance {
  domain: number;
  /** Chain name where the router knows the domain, else `domain <n>`. */
  chain: string;
  /** Decimal USDC string as returned by Gateway, e.g. "12.500000". */
  balance: string;
}

export interface UnifiedBalance {
  depositor: Address;
  /** Sum across the domains returned, in USDC base units (6 decimals). */
  totalBaseUnits: bigint;
  /** Same sum as a decimal string. */
  total: string;
  perDomain: GatewayDomainBalance[];
}

interface BalancesResponse {
  token: string;
  balances: { domain: number; depositor: string; balance: string }[];
}

const USDC_DECIMALS = 6;

/** Parses a decimal USDC string into base units without floating point. */
export function usdcToBaseUnits(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`not a decimal USDC amount: "${value}"`);
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > USDC_DECIMALS && /[1-9]/.test(frac.slice(USDC_DECIMALS))) {
    throw new Error(`more than ${USDC_DECIMALS} decimals: "${value}"`);
  }
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, "0"));
}

export function baseUnitsToUsdc(units: bigint): string {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  return `${units / scale}.${(units % scale).toString().padStart(USDC_DECIMALS, "0")}`;
}

/**
 * Reads the depositor's Gateway USDC balance on each of the router's test
 * chains and sums it. This is the balance an Arc-side action can draw on
 * without a bridge step first.
 */
export async function readUnifiedBalance(
  depositor: Address,
  opts: { apiUrl?: string; domains?: number[]; fetchImpl?: typeof fetch } = {},
): Promise<UnifiedBalance> {
  const apiUrl = opts.apiUrl ?? GATEWAY_TESTNET.apiUrl;
  const domains = opts.domains ?? TESTNET_CHAINS.map((c) => c.cctpDomain);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${apiUrl}/v1/balances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: domains.map((domain) => ({ domain, depositor })) }),
  });
  if (!res.ok) throw new Error(`Gateway /v1/balances returned ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as BalancesResponse;
  const perDomain = body.balances.map((b) => ({
    domain: b.domain,
    chain: chainByDomain(b.domain)?.name ?? `domain ${b.domain}`,
    balance: b.balance,
  }));
  const totalBaseUnits = perDomain.reduce((sum, b) => sum + usdcToBaseUnits(b.balance), 0n);
  return { depositor, totalBaseUnits, total: baseUnitsToUsdc(totalBaseUnits), perDomain };
}
