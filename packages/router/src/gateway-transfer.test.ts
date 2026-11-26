import { decodeFunctionData, getAddress, hashTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ARC_TESTNET, ETH_SEPOLIA, GATEWAY_TESTNET } from "./chains.ts";
import {
  BURN_INTENT_DOMAIN,
  BURN_INTENT_TYPES,
  buildTransferSpec,
  burnIntentFromJson,
  burnIntentToJson,
  burnIntentTypedDataJson,
  bytes32ToAddress,
  encodeGatewayDeposit,
  estimateBurnIntent,
  gatewayWalletAbi,
  maxDebit,
  recoverBurnIntentSigner,
  requestTransferAttestation,
  type BurnIntent,
} from "./gateway-transfer.ts";

const customer = privateKeyToAccount(generatePrivateKey());
const SALT: Hex = `0x${"5a".repeat(32)}`;
const spec = () => buildTransferSpec({ source: ETH_SEPOLIA, destination: ARC_TESTNET, depositor: customer.address, recipient: customer.address, value: 2_000_000n, salt: SALT });
const intent = (): BurnIntent => ({ maxBlockHeight: 12_275_124n, maxFee: 1_100_000n, spec: spec() });
const { EIP712Domain: _domain, ...signTypes } = BURN_INTENT_TYPES;
const sign = (i: BurnIntent, account = customer) => account.signTypedData({ domain: BURN_INTENT_DOMAIN, types: signTypes, primaryType: "BurnIntent", message: i });

function fakeGateway(responses: { status?: number; json?: unknown; text?: string }[]) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const r = responses.shift() ?? { status: 500, text: "no response queued" };
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("Gateway deposit", () => {
  it("encodes GatewayWallet.deposit(token, value)", () => {
    const decoded = decodeFunctionData({ abi: gatewayWalletAbi, data: encodeGatewayDeposit(ETH_SEPOLIA.usdc, 5_000_000n) });
    expect(decoded.functionName).toBe("deposit");
    expect(decoded.args).toEqual([ETH_SEPOLIA.usdc, 5_000_000n]);
  });

  it("refuses a zero deposit", () => {
    expect(() => encodeGatewayDeposit(ETH_SEPOLIA.usdc, 0n)).toThrow(/positive/);
  });
});

describe("transfer spec", () => {
  it("moves USDC from the depositor's Sepolia balance to the recipient on Arc, through Gateway's own contracts", () => {
    const s = spec();
    expect(s).toMatchObject({ version: 1, sourceDomain: 0, destinationDomain: 26, value: 2_000_000n, salt: SALT, hookData: "0x" });
    expect(bytes32ToAddress(s.sourceContract)).toBe(GATEWAY_TESTNET.gatewayWallet.toLowerCase());
    expect(bytes32ToAddress(s.destinationContract)).toBe(GATEWAY_TESTNET.gatewayMinter.toLowerCase());
    expect(bytes32ToAddress(s.sourceToken)).toBe(ETH_SEPOLIA.usdc.toLowerCase());
    expect(bytes32ToAddress(s.destinationToken)).toBe(ARC_TESTNET.usdc.toLowerCase());
  });

  it("names the depositor as signer, so no delegate can be slipped in", () => {
    const s = spec();
    expect(s.sourceSigner).toBe(s.sourceDepositor);
    expect(getAddress(bytes32ToAddress(s.sourceDepositor))).toBe(customer.address);
  });

  it("pads every address field to 32 bytes and lets any address submit the mint", () => {
    const s = spec();
    for (const f of ["sourceContract", "destinationContract", "sourceToken", "destinationToken", "sourceDepositor", "destinationRecipient", "sourceSigner", "destinationCaller"] as const) {
      expect(s[f]).toMatch(/^0x0{24}[0-9a-f]{40}$/);
    }
    expect(s.destinationCaller).toBe(`0x${"00".repeat(32)}`);
  });

  it("refuses a zero value and a malformed salt", () => {
    const base = { source: ETH_SEPOLIA, destination: ARC_TESTNET, depositor: customer.address, recipient: customer.address };
    expect(() => buildTransferSpec({ ...base, value: 0n, salt: SALT })).toThrow(/positive/);
    expect(() => buildTransferSpec({ ...base, value: 1n, salt: "0x1234" })).toThrow(/32 bytes/);
  });
});

describe("burn intent", () => {
  it("survives the JSON form used by the API and by wallets, with uint256 as decimal strings", () => {
    const json = burnIntentToJson(intent());
    expect(json.maxFee).toBe("1100000");
    expect(json.maxBlockHeight).toBe("12275124");
    expect(json.spec.value).toBe("2000000");
    expect(burnIntentFromJson(JSON.parse(JSON.stringify(json)))).toEqual(intent());
  });

  it("produces a typed-data document whose hash is the one the signer signs", () => {
    const doc = JSON.parse(burnIntentTypedDataJson(intent()));
    expect(doc.primaryType).toBe("BurnIntent");
    expect(doc.domain).toEqual({ name: "GatewayWallet", version: "1" });
    expect(Object.keys(doc.types)).toEqual(["EIP712Domain", "TransferSpec", "BurnIntent"]);
    expect(doc.types.TransferSpec.map((f: { name: string }) => f.name)).toEqual([
      "version", "sourceDomain", "destinationDomain", "sourceContract", "destinationContract", "sourceToken", "destinationToken",
      "sourceDepositor", "destinationRecipient", "sourceSigner", "destinationCaller", "value", "salt", "hookData",
    ]);
    // A wallet hashing the JSON document gets the same digest as the typed object.
    const { EIP712Domain: _d, ...types } = doc.types;
    expect(hashTypedData({ domain: doc.domain, types, primaryType: "BurnIntent", message: doc.message })).toBe(
      hashTypedData({ domain: BURN_INTENT_DOMAIN, types: signTypes, primaryType: "BurnIntent", message: intent() }),
    );
  });

  it("recovers the signer, and a changed intent no longer recovers to them", async () => {
    const signature = await sign(intent());
    expect(await recoverBurnIntentSigner(intent(), signature)).toBe(customer.address);
    const tampered = { ...intent(), spec: { ...spec(), value: 3_000_000n } };
    expect(await recoverBurnIntentSigner(tampered, signature)).not.toBe(customer.address);
    const elsewhere = { ...intent(), spec: { ...spec(), destinationRecipient: `0x${"00".repeat(12)}${"be".repeat(20)}` as Hex } };
    expect(await recoverBurnIntentSigner(elsewhere, signature)).not.toBe(customer.address);
  });

  it("counts the fee cap in what a transfer can take from the balance", () => {
    expect(maxDebit(intent())).toBe(3_100_000n);
  });
});

describe("Gateway API", () => {
  it("asks for an estimate with the spec and keeps its own spec, taking only the fee cap and expiry", async () => {
    // Gateway echoes addresses unpadded; the response's spec must not replace ours.
    const { calls, fetchImpl } = fakeGateway([{ json: [{ burnIntent: { maxBlockHeight: "12275124", maxFee: "1100000", spec: { value: "999", sourceDepositor: "0xbeef" } } }] }]);
    const out = await estimateBurnIntent(spec(), { fetchImpl });
    expect(calls[0]!.url).toBe(`${GATEWAY_TESTNET.apiUrl}/v1/estimate`);
    expect(calls[0]!.body).toEqual([{ spec: { ...spec(), value: "2000000" } }]);
    expect(out).toEqual(intent());
  });

  it("fails loudly when the estimate has no fee", async () => {
    const { fetchImpl } = fakeGateway([{ json: [{}] }]);
    await expect(estimateBurnIntent(spec(), { fetchImpl })).rejects.toThrow(/no fee/);
  });

  it("submits the signed intent as a one-item array and returns the attestation", async () => {
    const { calls, fetchImpl } = fakeGateway([{ status: 201, json: { transferId: "t-1", attestation: "0xa77e", signature: "0x516e", expirationBlock: "74240000", fees: { total: "0.01", token: "USDC" } } }]);
    const signature = await sign(intent());
    const out = await requestTransferAttestation(intent(), signature, { fetchImpl });
    expect(calls[0]!.url).toBe(`${GATEWAY_TESTNET.apiUrl}/v1/transfer`);
    expect(calls[0]!.body).toEqual([{ burnIntent: burnIntentToJson(intent()), signature }]);
    expect(out).toMatchObject({ transferId: "t-1", attestation: "0xa77e", signature: "0x516e" });
  });

  it("surfaces Gateway's own message on a refusal", async () => {
    const { fetchImpl } = fakeGateway([{ status: 400, json: { success: false, message: "Insufficient balance for depositor" } }]);
    await expect(requestTransferAttestation(intent(), "0x00", { fetchImpl })).rejects.toThrow(/\/v1\/transfer returned 400: Insufficient balance/);
  });

  it("treats a success without an attestation as a failure", async () => {
    const { fetchImpl } = fakeGateway([{ status: 201, json: { transferId: "t-1" } }]);
    await expect(requestTransferAttestation(intent(), "0x00", { fetchImpl })).rejects.toThrow(/no attestation/);
  });
});
