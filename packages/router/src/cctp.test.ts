import { describe, expect, it } from "vitest";
import { addressToBytes32, fetchFee, maxFeeFor, waitForAttestation } from "./cctp.ts";

describe("maxFeeFor", () => {
  it("is zero for a Standard transfer", () => {
    expect(maxFeeFor(10_000_000n, 0)).toBe(0n);
  });

  it("covers the quoted fee plus the margin, rounded up", () => {
    // 10 USDC at 0.25 bps + 1 bps margin = 10_000_000 * 1.25 / 10_000 = 1250 base units.
    expect(maxFeeFor(10_000_000n, 0.25)).toBe(1250n);
    // Fractional result rounds up, never down: 1 base unit at any positive fee costs 1.
    expect(maxFeeFor(1n, 0.325)).toBe(1n);
    // 0.325 bps stays exact: 20 USDC * 1.325 / 10_000 = 2650.
    expect(maxFeeFor(20_000_000n, 0.325)).toBe(2650n);
  });

  it("is never below the quoted fee itself", () => {
    for (const bps of [0.25, 0.325, 1, 14]) {
      const amount = 123_456_789n;
      const quoted = (amount * BigInt(Math.round(bps * 1_000_000))) / 10_000_000_000n;
      expect(maxFeeFor(amount, bps, 0)).toBeGreaterThanOrEqual(quoted);
    }
  });

  it("rejects a negative fee", () => {
    expect(() => maxFeeFor(1n, -1)).toThrow();
  });
});

describe("addressToBytes32", () => {
  it("left-pads to 32 bytes", () => {
    expect(addressToBytes32("0x3600000000000000000000000000000000000000")).toBe(
      "0x0000000000000000000000003600000000000000000000000000000000000000",
    );
  });
});

describe("fetchFee", () => {
  const feeApi = (async () =>
    new Response(
      JSON.stringify([
        { finalityThreshold: 1000, minimumFee: 0.25 },
        { finalityThreshold: 2000, minimumFee: 0 },
      ]),
    )) as typeof fetch;

  it("picks the entry for the requested finality threshold", async () => {
    expect(await fetchFee(0, 26, 1000, { fetchImpl: feeApi })).toEqual({ finalityThreshold: 1000, minimumFeeBps: 0.25 });
    expect(await fetchFee(0, 26, 2000, { fetchImpl: feeApi })).toEqual({ finalityThreshold: 2000, minimumFeeBps: 0 });
  });

  it("fails loudly when the route has no entry for the threshold", async () => {
    const standardOnly = (async () => new Response(JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0 }]))) as typeof fetch;
    await expect(fetchFee(26, 0, 1000, { fetchImpl: standardOnly })).rejects.toThrow(/no fee entry/);
  });
});

describe("waitForAttestation", () => {
  it("keeps polling through 404 and pending, then returns the attested message", async () => {
    const replies = [
      new Response("not found", { status: 404 }),
      new Response(JSON.stringify({ messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations" }] })),
      new Response(JSON.stringify({ messages: [{ message: "0xabcd", attestation: "0x1234", status: "complete" }] })),
    ];
    let calls = 0;
    const fetchImpl = (async () => replies[calls++]!) as typeof fetch;
    const out = await waitForAttestation(0, "0xdead", { fetchImpl, pollMs: 1 });
    expect(calls).toBe(3);
    expect(out.message).toBe("0xabcd");
    expect(out.attestation).toBe("0x1234");
  });

  it("throws on a server error rather than waiting forever", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(waitForAttestation(0, "0xdead", { fetchImpl, pollMs: 1 })).rejects.toThrow(/500/);
  });

  it("times out", async () => {
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    await expect(waitForAttestation(0, "0xdead", { fetchImpl, pollMs: 1, timeoutMs: 5 })).rejects.toThrow(/no attestation/);
  });
});
