/**
 * RPC transport for the router's testnets.
 *
 * The public Arc testnet endpoint rate-limits (HTTP 429, "rate limit exceeded") under a modest
 * burst of reads, so every client goes through a fallback over the endpoints Arc documents,
 * with retries. Observed 26 Nov 2026; see docs/notes.md.
 */
import { fallback, http, type Transport } from "viem";
import { rpcUrl, type TestnetChain } from "./chains.ts";

export function rpcUrls(chain: TestnetChain, env: Record<string, string | undefined> = process.env): string[] {
  return [...new Set([rpcUrl(chain, env), ...(chain.fallbackRpcUrls ?? [])])];
}

export function transportFor(chain: TestnetChain, env: Record<string, string | undefined> = process.env): Transport {
  const urls = rpcUrls(chain, env);
  if (urls.length === 1) return http(urls[0], { retryCount: 5, retryDelay: 400 });
  return fallback(
    urls.map((url) => http(url, { retryCount: 2, retryDelay: 300 })),
    { retryCount: 3, retryDelay: 500 },
  );
}
