import { describe, expect, it } from "vitest";
import { ARC_TESTNET, ETH_SEPOLIA } from "./chains.ts";
import { rpcUrls } from "./rpc.ts";

describe("rpcUrls", () => {
  it("puts the default endpoint first and the documented fallbacks after it", () => {
    expect(rpcUrls(ARC_TESTNET, {})).toEqual([
      "https://rpc.testnet.arc.io",
      "https://rpc.drpc.testnet.arc.io",
      "https://rpc.quicknode.testnet.arc.io",
    ]);
  });

  it("puts an operator's own endpoint first when one is configured", () => {
    expect(rpcUrls(ARC_TESTNET, { ARC_TESTNET_RPC_URL: "https://my-node.example" })[0]).toBe("https://my-node.example");
  });

  it("does not list the same endpoint twice", () => {
    expect(rpcUrls(ARC_TESTNET, { ARC_TESTNET_RPC_URL: "https://rpc.drpc.testnet.arc.io" })).toEqual([
      "https://rpc.drpc.testnet.arc.io",
      "https://rpc.quicknode.testnet.arc.io",
    ]);
  });

  it("works for a chain with no fallbacks", () => {
    expect(rpcUrls(ETH_SEPOLIA, {})).toEqual(["https://ethereum-sepolia-rpc.publicnode.com"]);
  });
});
