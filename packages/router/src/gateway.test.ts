import { describe, expect, it } from "vitest";
import { baseUnitsToUsdc, readUnifiedBalance, usdcToBaseUnits } from "./gateway.ts";

describe("USDC amount parsing", () => {
  it("parses decimals without floating point", () => {
    expect(usdcToBaseUnits("0")).toBe(0n);
    expect(usdcToBaseUnits("0.128000")).toBe(128000n);
    expect(usdcToBaseUnits("12.5")).toBe(12500000n);
    expect(usdcToBaseUnits("99999999791.053850")).toBe(99999999791053850n);
  });

  it("rejects amounts finer than 6 decimals and non-numbers", () => {
    expect(() => usdcToBaseUnits("1.0000001")).toThrow();
    expect(() => usdcToBaseUnits("-1")).toThrow();
    expect(() => usdcToBaseUnits("1e6")).toThrow();
  });

  it("round-trips", () => {
    expect(baseUnitsToUsdc(usdcToBaseUnits("20.000001"))).toBe("20.000001");
  });
});

describe("readUnifiedBalance", () => {
  it("asks for each test chain and sums the result", async () => {
    let sent: unknown;
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          token: "USDC",
          balances: [
            { domain: 26, depositor: "0xabc", balance: "5.250000" },
            { domain: 0, depositor: "0xabc", balance: "0" },
            { domain: 6, depositor: "0xabc", balance: "14.750000" },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const out = await readUnifiedBalance("0x000000000000000000000000000000000000dEaD", { fetchImpl });
    expect(sent).toEqual({
      token: "USDC",
      sources: [26, 0, 6].map((domain) => ({ domain, depositor: "0x000000000000000000000000000000000000dEaD" })),
    });
    expect(out.total).toBe("20.000000");
    expect(out.perDomain.map((b) => b.chain)).toEqual(["Arc Testnet", "Ethereum Sepolia", "Base Sepolia"]);
  });

  it("surfaces a Gateway error instead of returning a zero balance", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(readUnifiedBalance("0x000000000000000000000000000000000000dEaD", { fetchImpl })).rejects.toThrow(/500/);
  });
});
