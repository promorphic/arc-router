import { describe, expect, it } from "vitest";
import { CircleApiError, CircleWalletsClient, USER_ALREADY_EXISTS } from "./circle-wallets.ts";

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };

/** A fake Circle API: replies come from a queue, every request is recorded. */
function fakeCircle(replies: { status?: number; json: unknown }[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(url).replace("https://api.circle.com", ""),
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error("fake Circle API: no reply queued");
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, client: new CircleWalletsClient({ apiKey: "TEST_API_KEY:id:secret", fetchImpl }) };
}

describe("CircleWalletsClient", () => {
  it("refuses a live key", () => {
    expect(() => new CircleWalletsClient({ apiKey: "LIVE_API_KEY:id:secret" })).toThrow(/testnet key/);
    expect(() => new CircleWalletsClient({ apiKey: "" })).toThrow(/testnet key/);
  });

  it("sends the API key as a bearer token and the user token only where given", async () => {
    const { client, calls } = fakeCircle([{ json: { data: { userToken: "ut", encryptionKey: "ek" } } }, { json: { data: { wallets: [] } } }]);
    await client.createUserToken("u1");
    await client.listWallets("ut");
    expect(calls[0]!.headers.authorization).toBe("Bearer TEST_API_KEY:id:secret");
    expect(calls[0]!.headers["X-User-Token"]).toBeUndefined();
    expect(calls[1]!.headers["X-User-Token"]).toBe("ut");
  });

  it("treats an existing user as success and any other error as an error", async () => {
    const existing = fakeCircle([{ status: 409, json: { code: USER_ALREADY_EXISTS, message: "exists" } }]);
    await expect(existing.client.createUser("u1")).resolves.toBeUndefined();

    const broken = fakeCircle([{ status: 401, json: { code: 401, message: "Invalid credentials." } }]);
    await expect(broken.client.createUser("u1")).rejects.toThrow(CircleApiError);
  });

  it("asks for an EOA on the requested chains when initializing", async () => {
    const { client, calls } = fakeCircle([{ status: 201, json: { data: { challengeId: "c1" } } }]);
    const out = await client.initializeUser("ut", { blockchains: ["ETH-SEPOLIA", "ARC-TESTNET"] });
    expect(out.challengeId).toBe("c1");
    expect(calls[0]!.path).toBe("/v1/w3s/user/initialize");
    expect(calls[0]!.body).toMatchObject({ accountType: "EOA", blockchains: ["ETH-SEPOLIA", "ARC-TESTNET"] });
    expect((calls[0]!.body as { idempotencyKey: string }).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("prepares a contract call as a challenge and never sends a signature", async () => {
    const { client, calls } = fakeCircle([{ status: 201, json: { data: { challengeId: "c2" } } }]);
    await client.createContractExecutionChallenge("ut", {
      walletId: "w1",
      contractAddress: "0x3600000000000000000000000000000000000000",
      callData: "0xabcdef",
    });
    expect(calls[0]!.path).toBe("/v1/w3s/user/transactions/contractExecution");
    expect(calls[0]!.body).toMatchObject({ walletId: "w1", callData: "0xabcdef", feeLevel: "MEDIUM" });
    // The developer-controlled API takes an entitySecretCiphertext. This client must never send one.
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/entitySecret/i);
  });

  describe("waitForChallengeTransaction", () => {
    const challenge = (status: string, extra = {}) => ({ json: { data: { challenge: { id: "c", type: "CONTRACT_EXECUTION", status, ...extra } } } });
    const tx = (state: string, extra = {}) => ({ json: { data: { transaction: { id: "t1", state, ...extra } } } });

    it("waits for the PIN, then for the chain, and returns the hash", async () => {
      const { client, calls } = fakeCircle([
        challenge("PENDING"),
        challenge("COMPLETE", { correlationIds: ["t1"] }),
        tx("SENT"),
        tx("CONFIRMED", { txHash: "0xfeed" }),
      ]);
      const out = await client.waitForChallengeTransaction("ut", "c", { pollMs: 1 });
      expect(out.txHash).toBe("0xfeed");
      // Once the transaction id is known the challenge is not polled again.
      expect(calls.map((c) => c.path)).toEqual([
        "/v1/w3s/user/challenges/c",
        "/v1/w3s/user/challenges/c",
        "/v1/w3s/transactions/t1",
        "/v1/w3s/transactions/t1",
      ]);
    });

    it("fails when the customer does not approve", async () => {
      const { client } = fakeCircle([challenge("FAILED", { errorMessage: "incorrect PIN" })]);
      await expect(client.waitForChallengeTransaction("ut", "c", { pollMs: 1 })).rejects.toThrow(/incorrect PIN/);
    });

    it("fails when the transaction fails on-chain", async () => {
      const { client } = fakeCircle([challenge("COMPLETE", { correlationIds: ["t1"] }), tx("FAILED", { errorReason: "INSUFFICIENT_NATIVE_TOKEN" })]);
      await expect(client.waitForChallengeTransaction("ut", "c", { pollMs: 1 })).rejects.toThrow(/INSUFFICIENT_NATIVE_TOKEN/);
    });

    it("times out instead of polling forever", async () => {
      const { client } = fakeCircle(Array.from({ length: 50 }, () => challenge("PENDING")));
      await expect(client.waitForChallengeTransaction("ut", "c", { pollMs: 1, timeoutMs: 10 })).rejects.toThrow(/timed out/);
    });
  });
});
