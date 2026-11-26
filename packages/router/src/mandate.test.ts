import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { MANDATE_REASONS, encodeApproveProposal, encodeSetMandate, mandateAbi, proposalId } from "./mandate.ts";

const AGENT = getAddress("0x00000000000000000000000000000000000a6e47");
const USDC = getAddress("0x3600000000000000000000000000000000000000");
const ISSUER = getAddress("0x0000000000000000000000000000000000001550");

describe("mandate calldata", () => {
  it("encodes setMandate with the terms the customer chose", () => {
    const data = encodeSetMandate({
      agent: AGENT,
      settlementToken: USDC,
      mode: "Autopilot",
      perOrderCap: 2_000_000n,
      dailyCap: 5_000_000n,
      expiry: 1_900_000_000n,
      assets: [USDC],
      recipients: [ISSUER],
    });
    const decoded = decodeFunctionData({ abi: mandateAbi, data });
    expect(decoded.functionName).toBe("setMandate");
    expect(decoded.args).toEqual([AGENT, USDC, 1, 2_000_000n, 5_000_000n, 1_900_000_000n, [USDC], [ISSUER]]);
  });

  it("encodes Copilot as mode 0", () => {
    const data = encodeSetMandate({
      agent: AGENT, settlementToken: USDC, mode: "Copilot", perOrderCap: 1n, dailyCap: 1n, expiry: 1n, assets: [], recipients: [],
    });
    expect(decodeFunctionData({ abi: mandateAbi, data }).args![2]).toBe(0);
  });

  it("refuses caps the contract would refuse, before the customer is asked to sign", () => {
    const base = { agent: AGENT, settlementToken: USDC, mode: "Autopilot" as const, expiry: 1n, assets: [], recipients: [] };
    expect(() => encodeSetMandate({ ...base, perOrderCap: 6n, dailyCap: 5n })).toThrow();
    expect(() => encodeSetMandate({ ...base, perOrderCap: 0n, dailyCap: 5n })).toThrow();
  });

  it("derives a stable proposal id from the proposal's reference", () => {
    expect(proposalId("m1b-in-limit-1")).toBe(proposalId("m1b-in-limit-1"));
    expect(proposalId("m1b-in-limit-1")).not.toBe(proposalId("m1b-in-limit-2"));
    expect(proposalId("x")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("encodes a Copilot approval for exactly one proposal", () => {
    const data = encodeApproveProposal({ reference: "p1", asset: USDC, recipient: ISSUER, amount: 1_000_000n });
    const decoded = decodeFunctionData({ abi: mandateAbi, data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([proposalId("p1"), USDC, ISSUER, 1_000_000n]);
  });

  it("names every reason in the contract's enum order", () => {
    // contracts/src/Mandate.sol: enum Reason { None, Revoked, Expired, AssetNotAllowed, RecipientNotAllowed, OverPerOrderCap, OverDailyCap, NotApproved }
    expect(MANDATE_REASONS).toEqual([
      "None", "Revoked", "Expired", "AssetNotAllowed", "RecipientNotAllowed", "OverPerOrderCap", "OverDailyCap", "NotApproved",
    ]);
  });
});
