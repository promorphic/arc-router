/**
 * Circle Wallets, user-controlled: the customer's operational wallet.
 *
 * Why user-controlled and not developer-controlled: with user-controlled wallets every
 * signature needs the customer's own PIN, entered in Circle's SDK frame. This server can only
 * *prepare* a transaction as a "challenge"; it can never sign one. With developer-controlled
 * wallets our entity secret would sign, which would make Promorphic the custodian. That is the
 * line this product does not cross.
 *
 * API reference: https://developers.circle.com/api-reference/wallets/user-controlled-wallets
 * (endpoint shapes checked against https://developers.circle.com/openapi/user-controlled-wallets.yaml,
 * 26 Nov 2026)
 */
import { randomUUID } from "node:crypto";
import type { Address } from "./chains.ts";

export const CIRCLE_API_URL = "https://api.circle.com";

export type CircleBlockchain = "ARC-TESTNET" | "ETH-SEPOLIA" | "BASE-SEPOLIA";

export interface CircleWallet {
  id: string;
  address: Address;
  blockchain: string;
  accountType?: string;
  state?: string;
}

export interface CircleTransaction {
  id: string;
  state: string;
  txHash?: `0x${string}`;
  blockchain?: string;
  errorReason?: string;
  errorDetails?: string;
}

export interface CircleChallenge {
  id: string;
  type: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETE" | "FAILED" | "EXPIRED";
  correlationIds?: string[];
  errorCode?: number;
  errorMessage?: string;
}

export class CircleApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  constructor(status: number, code: number | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Circle's code for "this user id already exists". */
export const USER_ALREADY_EXISTS = 155101;
/** Circle's code for "this user has already been initialized" (PIN already set). */
export const USER_ALREADY_INITIALIZED = 155106;

/** States after which a transaction will not change again. */
const FINAL_OK = new Set(["CONFIRMED", "COMPLETE"]);
const FINAL_BAD = new Set(["FAILED", "CANCELLED", "DENIED"]);

export class CircleWalletsClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; apiUrl?: string; fetchImpl?: typeof fetch }) {
    // Testnet by default, enforced: a LIVE key is refused outright.
    if (!opts.apiKey.startsWith("TEST_API_KEY:")) {
      throw new Error("CIRCLE_API_KEY must be a testnet key (TEST_API_KEY:...). Live keys are refused.");
    }
    this.apiKey = opts.apiKey;
    this.apiUrl = opts.apiUrl ?? CIRCLE_API_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, opts: { body?: unknown; userToken?: string } = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        ...(opts.userToken ? { "X-User-Token": opts.userToken } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: { data?: T; code?: number; message?: string } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // fall through with the raw text in the error below
    }
    if (!res.ok) {
      throw new CircleApiError(res.status, json.code, `Circle ${method} ${path} -> ${res.status}: ${json.message ?? text}`);
    }
    return (json.data ?? {}) as T;
  }

  /** Creates the end user. Idempotent: an existing user id is not an error. */
  async createUser(userId: string): Promise<void> {
    try {
      await this.call("POST", "/v1/w3s/users", { body: { userId } });
    } catch (err) {
      if (err instanceof CircleApiError && err.code === USER_ALREADY_EXISTS) return;
      throw err;
    }
  }

  /** A 60-minute session for the SDK. The encryption key lets the SDK frame protect the PIN. */
  async createUserToken(userId: string): Promise<{ userToken: string; encryptionKey: string }> {
    return this.call("POST", "/v1/w3s/users/token", { body: { userId } });
  }

  /** Challenge that has the customer set a PIN and creates their wallets. */
  async initializeUser(
    userToken: string,
    opts: { blockchains: CircleBlockchain[]; accountType?: "EOA" | "SCA" },
  ): Promise<{ challengeId: string }> {
    return this.call("POST", "/v1/w3s/user/initialize", {
      userToken,
      body: { idempotencyKey: randomUUID(), accountType: opts.accountType ?? "EOA", blockchains: opts.blockchains },
    });
  }

  async listWallets(userToken: string): Promise<CircleWallet[]> {
    const data = await this.call<{ wallets?: CircleWallet[] }>("GET", "/v1/w3s/wallets?pageSize=50", { userToken });
    return data.wallets ?? [];
  }

  /**
   * Challenge for a contract call from the customer's wallet. Nothing is signed or sent until
   * the customer enters their PIN in the SDK frame.
   */
  async createContractExecutionChallenge(
    userToken: string,
    tx: { walletId: string; contractAddress: Address; callData: `0x${string}`; refId?: string },
  ): Promise<{ challengeId: string }> {
    return this.call("POST", "/v1/w3s/user/transactions/contractExecution", {
      userToken,
      body: {
        idempotencyKey: randomUUID(),
        walletId: tx.walletId,
        contractAddress: tx.contractAddress,
        callData: tx.callData,
        feeLevel: "MEDIUM",
        ...(tx.refId ? { refId: tx.refId } : {}),
      },
    });
  }

  async getChallenge(userToken: string, challengeId: string): Promise<CircleChallenge> {
    const data = await this.call<{ challenge: CircleChallenge }>("GET", `/v1/w3s/user/challenges/${challengeId}`, { userToken });
    return data.challenge;
  }

  async getTransaction(userToken: string, id: string): Promise<CircleTransaction> {
    const data = await this.call<{ transaction: CircleTransaction }>("GET", `/v1/w3s/transactions/${id}`, { userToken });
    return data.transaction;
  }

  /**
   * After the customer has approved a challenge: resolves the transaction it created and waits
   * for it to confirm on-chain.
   */
  async waitForChallengeTransaction(
    userToken: string,
    challengeId: string,
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<CircleTransaction & { txHash: `0x${string}` }> {
    const pollMs = opts.pollMs ?? 1500;
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    let txId: string | undefined;
    for (;;) {
      if (!txId) {
        const challenge = await this.getChallenge(userToken, challengeId);
        if (challenge.status === "FAILED" || challenge.status === "EXPIRED") {
          throw new Error(`challenge ${challengeId} ${challenge.status}: ${challenge.errorMessage ?? "no reason given"}`);
        }
        if (challenge.status === "COMPLETE") txId = challenge.correlationIds?.[0];
      }
      if (txId) {
        const tx = await this.getTransaction(userToken, txId);
        if (FINAL_BAD.has(tx.state)) {
          throw new Error(`transaction ${txId} ${tx.state}: ${tx.errorReason ?? ""} ${tx.errorDetails ?? ""}`.trim());
        }
        if (FINAL_OK.has(tx.state) && tx.txHash) return { ...tx, txHash: tx.txHash };
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for challenge ${challengeId}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
