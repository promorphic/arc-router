/**
 * Demo backend. It prepares transactions as Circle "challenges" and reads chain state. It
 * cannot sign for the customer: every customer transaction needs the customer's PIN, entered
 * in Circle's SDK frame in the browser.
 *
 * The one key this server holds is the test relayer key, which pays gas to submit the CCTP
 * mint and the Gateway mint on Arc. Submitting either is permissionless and the minted USDC
 * goes to the recipient fixed in what the customer signed, so the relayer never has custody.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { encodeFunctionData, type Hex } from "viem";
import {
  ANY_DESTINATION_CALLER,
  ARC_TESTNET,
  CCTP_FINALITY,
  CCTP_V2_TESTNET,
  ETH_SEPOLIA,
  GATEWAY_TESTNET,
  MANDATE_ARC_TESTNET,
  USER_ALREADY_INITIALIZED,
  CircleApiError,
  addressToBytes32,
  baseUnitsToUsdc,
  buildTransferSpec,
  burnIntentFromJson,
  burnIntentToJson,
  burnIntentTypedDataJson,
  encodeGatewayDeposit,
  encodeSetMandate,
  erc20Abi,
  explorerTxUrl,
  maxDebit,
  maxFeeFor,
  recoverBurnIntentSigner,
  tokenMessengerV2Abi,
  usdcToBaseUnits,
  type Address,
  type BurnIntent,
  type CircleWallet,
  type CircleWalletsClient,
  type FeeQuote,
  type MandateTerms,
  type RecordEntry,
  type TestnetChain,
  type TransferAttestation,
  type TransferSpec,
  type UnifiedBalance,
} from "@promorphic/router";

export interface EvidenceEntry {
  date: string;
  milestone: string;
  chain: string;
  what: string;
  txHash?: Hex;
  url?: string;
  proves: string;
}

export interface DemoState {
  userId?: string;
  wallets?: { source?: { id: string; address: Address }; arc?: { id: string; address: Address } };
  /** In-flight CCTP transfer, kept so a page reload can resume it. */
  cctp?: { amount: string; burnTxHash?: Hex; mintTxHash?: Hex; attestationSeconds?: number; totalSeconds?: number };
  /** Gateway: the deposit on the source chain, and the transfer funded from it. */
  gateway?: {
    depositAmount?: string;
    depositTxHash?: Hex;
    /** The burn intent the customer has been asked to sign, until it is used. */
    pendingIntent?: ReturnType<typeof burnIntentToJson>;
    value?: string;
    feeCap?: string;
    transferId?: string;
    mintTxHash?: Hex;
  };
}

/** Everything the API touches outside this process, injectable so the flows can be tested. */
export interface ApiDeps {
  appId: string;
  circle: Pick<
    CircleWalletsClient,
    "createUser" | "createUserToken" | "initializeUser" | "listWallets" | "createContractExecutionChallenge" | "createSignTypedDataChallenge" | "waitForChallengeTransaction"
  >;
  /** The agent's address (Circle Agent Wallet), named in the mandate. Undefined until it exists. */
  agentWallet(): Promise<Address | undefined>;
  /** Stand-in for an issuer's settlement address: the one recipient the mandate allows. */
  allowedRecipient: Address;
  statePath: string;
  evidencePath: string;
  chain: {
    usdcBalance(chain: TestnetChain, who: Address): Promise<bigint>;
    nativeBalance(chain: TestnetChain, who: Address): Promise<bigint>;
    fetchFee(sourceDomain: number, destinationDomain: number, threshold: number): Promise<FeeQuote>;
    waitForAttestation(sourceDomain: number, burnTxHash: Hex): Promise<{ message: Hex; attestation: Hex; waitedMs: number }>;
    /** Submits the attested message on Arc from the test relayer. */
    relayMint(message: Hex, attestation: Hex): Promise<Hex>;
    unifiedBalance(who: Address): Promise<UnifiedBalance>;
    /** Gateway's fee cap and expiry for a transfer. */
    gatewayEstimate(spec: TransferSpec): Promise<BurnIntent>;
    /** Sends the customer's signed burn intent to Gateway; returns the attestation to mint with. */
    gatewayTransfer(intent: BurnIntent, signature: Hex): Promise<TransferAttestation>;
    /** Submits the Gateway mint on Arc from the test relayer. */
    relayGatewayMint(attestation: Hex, signature: Hex): Promise<Hex>;
    mandateTerms(customer: Address): Promise<MandateTerms | undefined>;
    mandateRecord(customer: Address): Promise<RecordEntry[]>;
    spentInWindow(customer: Address): Promise<bigint>;
  };
  now?: () => Date;
}

export const SOURCE = ETH_SEPOLIA;
export const DESTINATION = ARC_TESTNET;

function loadJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}
function saveJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApi(deps: ApiDeps) {
  const now = deps.now ?? (() => new Date());
  const state = (): DemoState => loadJson<DemoState>(deps.statePath, {});
  const setState = (patch: Partial<DemoState>) => saveJson(deps.statePath, { ...state(), ...patch });
  const addEvidence = (entry: Omit<EvidenceEntry, "date">) => {
    const all = loadJson<EvidenceEntry[]>(deps.evidencePath, []);
    all.push({ date: now().toISOString(), ...entry });
    saveJson(deps.evidencePath, all);
  };

  async function userToken(): Promise<{ userToken: string; encryptionKey: string }> {
    let { userId } = state();
    // Circle accepts user ids of 5 to 50 characters; an id saved by an earlier build may be longer.
    if (!userId || userId.length > 50) {
      userId = `promorphic-${randomUUID()}`;
      setState({ userId });
    }
    await deps.circle.createUser(userId);
    return deps.circle.createUserToken(userId);
  }

  function pickWallets(wallets: CircleWallet[]): NonNullable<DemoState["wallets"]> {
    const find = (chain: TestnetChain) => {
      const w = wallets.find((x) => x.blockchain === chain.circleBlockchain);
      return w ? { id: w.id, address: w.address } : undefined;
    };
    return { source: find(SOURCE), arc: find(DESTINATION) };
  }

  function requireWallets() {
    const w = state().wallets;
    if (!w?.source || !w.arc) throw new HttpError(409, "The customer wallet does not exist yet. Create it first.");
    return { source: w.source, arc: w.arc };
  }

  async function mandateTermsInput(body: { perOrderCap?: string; dailyCap?: string; days?: number }) {
    const agent = await deps.agentWallet();
    if (!agent) throw new HttpError(409, "No Circle Agent Wallet yet: log in with the Circle CLI first (see the README).");
    const perOrderCap = usdcToBaseUnits(body.perOrderCap ?? "2");
    const dailyCap = usdcToBaseUnits(body.dailyCap ?? "5");
    const days = body.days ?? 7;
    return {
      agent,
      settlementToken: DESTINATION.usdc,
      mode: "Autopilot" as const,
      perOrderCap,
      dailyCap,
      expiry: BigInt(Math.floor(now().getTime() / 1000) + days * 86_400),
      assets: [DESTINATION.usdc],
      recipients: [deps.allowedRecipient],
    };
  }

  /** Builds the challenge for one customer action. Nothing is signed here. */
  async function createChallenge(action: string, body: Record<string, unknown>): Promise<{ challengeId: string }> {
    const { userToken: token } = await userToken();
    const w = requireWallets();
    const amount = usdcToBaseUnits(String(body.amount ?? "5"));

    switch (action) {
      case "cctp-approve":
        return deps.circle.createContractExecutionChallenge(token, {
          walletId: w.source.id,
          contractAddress: SOURCE.usdc,
          callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CCTP_V2_TESTNET.tokenMessengerV2, amount] }),
          refId: "m1a-approve",
        });
      case "cctp-burn": {
        const fee = await deps.chain.fetchFee(SOURCE.cctpDomain, DESTINATION.cctpDomain, CCTP_FINALITY.fast);
        setState({ cctp: { amount: baseUnitsToUsdc(amount) } });
        return deps.circle.createContractExecutionChallenge(token, {
          walletId: w.source.id,
          contractAddress: CCTP_V2_TESTNET.tokenMessengerV2,
          callData: encodeFunctionData({
            abi: tokenMessengerV2Abi,
            functionName: "depositForBurn",
            args: [
              amount,
              DESTINATION.cctpDomain,
              addressToBytes32(w.arc.address), // minted to the customer's own wallet on Arc
              SOURCE.usdc,
              ANY_DESTINATION_CALLER,
              maxFeeFor(amount, fee.minimumFeeBps),
              CCTP_FINALITY.fast,
            ],
          }),
          refId: "m1a-burn",
        });
      }
      case "mandate-approve-usdc": {
        const terms = await mandateTermsInput(body);
        return deps.circle.createContractExecutionChallenge(token, {
          walletId: w.arc.id,
          contractAddress: DESTINATION.usdc,
          // The allowance is the daily cap: the most the agent could ever move in a day.
          callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MANDATE_ARC_TESTNET.address, terms.dailyCap] }),
          refId: "m1b-approve-usdc",
        });
      }
      case "mandate-set":
        return deps.circle.createContractExecutionChallenge(token, {
          walletId: w.arc.id,
          contractAddress: MANDATE_ARC_TESTNET.address,
          callData: encodeSetMandate(await mandateTermsInput(body)),
          refId: "m1b-set-mandate",
        });
      case "gateway-approve":
        return deps.circle.createContractExecutionChallenge(token, {
          walletId: w.source.id,
          contractAddress: SOURCE.usdc,
          callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [GATEWAY_TESTNET.gatewayWallet, amount] }),
          refId: "m1c-approve",
        });
      case "gateway-deposit":
        setState({ gateway: { ...state().gateway, depositAmount: baseUnitsToUsdc(amount) } });
        return deps.circle.createContractExecutionChallenge(token, {
          walletId: w.source.id,
          contractAddress: GATEWAY_TESTNET.gatewayWallet,
          callData: encodeGatewayDeposit(SOURCE.usdc, amount),
          refId: "m1c-deposit",
        });
      case "gateway-sign": {
        // From the customer's Gateway balance on the source chain to the customer's own wallet on Arc.
        const value = usdcToBaseUnits(String(body.value ?? "2"));
        const spec = buildTransferSpec({
          source: SOURCE,
          destination: DESTINATION,
          depositor: w.source.address,
          recipient: w.arc.address,
          value,
          salt: `0x${randomBytes(32).toString("hex")}`,
        });
        const intent = await deps.chain.gatewayEstimate(spec);
        const unified = await deps.chain.unifiedBalance(w.source.address);
        const available = usdcToBaseUnits(unified.perDomain.find((d) => d.domain === SOURCE.cctpDomain)?.balance ?? "0");
        if (available < maxDebit(intent)) {
          throw new HttpError(
            409,
            `Your Gateway balance on ${SOURCE.name} is ${baseUnitsToUsdc(available)} USDC; this transfer needs up to ${baseUnitsToUsdc(maxDebit(intent))} (${baseUnitsToUsdc(value)} plus a fee cap of ${baseUnitsToUsdc(intent.maxFee)}). A deposit counts once it is final on ${SOURCE.name}, about 13 to 19 minutes.`,
          );
        }
        setState({ gateway: { ...state().gateway, pendingIntent: burnIntentToJson(intent), value: baseUnitsToUsdc(value), feeCap: baseUnitsToUsdc(intent.maxFee) } });
        return deps.circle.createSignTypedDataChallenge(token, {
          walletId: w.source.id,
          data: burnIntentTypedDataJson(intent),
          memo: `Move ${baseUnitsToUsdc(value)} USDC from your Gateway balance to your wallet on ${DESTINATION.name}`,
        });
      }
      default:
        throw new HttpError(400, `unknown action "${action}"`);
    }
  }

  /** The customer signed the burn intent: Gateway attests, the relayer mints on Arc, evidence is recorded. */
  async function finishGatewayTransfer(signature: string) {
    const w = requireWallets();
    const pending = state().gateway?.pendingIntent;
    if (!pending) throw new HttpError(409, "No Gateway transfer is waiting for a signature.");
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new HttpError(400, "The signature from the Circle window is missing or malformed.");
    const intent = burnIntentFromJson(pending);
    const signer = await recoverBurnIntentSigner(intent, signature as Hex);
    if (signer.toLowerCase() !== w.source.address.toLowerCase()) {
      throw new HttpError(400, `The burn intent was signed by ${signer}, not the customer's wallet ${w.source.address}.`);
    }
    const started = now().getTime();
    const before = await deps.chain.usdcBalance(DESTINATION, w.arc.address);
    const attested = await deps.chain.gatewayTransfer(intent, signature as Hex);
    const mintTxHash = await deps.chain.relayGatewayMint(attested.attestation, attested.signature);
    const after = await deps.chain.usdcBalance(DESTINATION, w.arc.address);
    const seconds = Math.round((now().getTime() - started) / 100) / 10;
    setState({ gateway: { ...state().gateway, pendingIntent: undefined, transferId: attested.transferId, mintTxHash } });
    addEvidence({
      milestone: "M1(c)",
      chain: DESTINATION.name,
      what: "Gateway mint on Arc funded from the unified balance (GatewayMinter.gatewayMint)",
      txHash: mintTxHash,
      url: explorerTxUrl(DESTINATION, mintTxHash),
      proves: `${baseUnitsToUsdc(intent.spec.value)} USDC from the customer's Gateway balance on ${SOURCE.name} was minted to the customer's wallet ${w.arc.address} on ${DESTINATION.name}: balance ${baseUnitsToUsdc(before)} -> ${baseUnitsToUsdc(after)}. The customer signed one burn intent with their PIN (fee cap ${baseUnitsToUsdc(intent.maxFee)} USDC) and sent no transaction; Gateway transfer ${attested.transferId}; ${seconds} s from signature to mint.`,
    });
    return { mintTxHash, url: explorerTxUrl(DESTINATION, mintTxHash), seconds: String(seconds), transferId: attested.transferId };
  }

  /** After the customer approved a challenge in the SDK frame: wait for the chain, record evidence. */
  async function complete(action: string, challengeId: string, body: Record<string, unknown> = {}) {
    // Signing a burn intent creates no transaction, so there is nothing to wait for at Circle.
    if (action === "gateway-sign") return finishGatewayTransfer(String(body.signature ?? ""));
    const { userToken: token } = await userToken();
    const w = requireWallets();
    const started = now().getTime();
    const tx = await deps.circle.waitForChallengeTransaction(token, challengeId);

    switch (action) {
      case "cctp-approve":
      case "gateway-approve":
        return { txHash: tx.txHash, url: explorerTxUrl(SOURCE, tx.txHash) };
      case "gateway-deposit": {
        const amount = state().gateway?.depositAmount ?? "?";
        setState({ gateway: { ...state().gateway, depositTxHash: tx.txHash } });
        addEvidence({
          milestone: "M1(c)",
          chain: SOURCE.name,
          what: "Deposit into Circle Gateway (GatewayWallet.deposit)",
          txHash: tx.txHash,
          url: explorerTxUrl(SOURCE, tx.txHash),
          proves: `The customer's Circle user-controlled wallet ${w.source.address} deposited ${amount} USDC into Gateway on ${SOURCE.name}, signed with the customer's PIN. It becomes part of the customer's unified balance once final.`,
        });
        return { txHash: tx.txHash, url: explorerTxUrl(SOURCE, tx.txHash) };
      }
      case "cctp-burn": {
        const amount = state().cctp?.amount ?? "?";
        setState({ cctp: { amount, burnTxHash: tx.txHash } });
        addEvidence({
          milestone: "M1(a)",
          chain: SOURCE.name,
          what: "CCTP V2 burn (TokenMessengerV2.depositForBurn, Fast Transfer)",
          txHash: tx.txHash,
          url: explorerTxUrl(SOURCE, tx.txHash),
          proves: `${amount} USDC burned from the customer's Circle user-controlled wallet ${w.source.address} on ${SOURCE.name}, signed with the customer's PIN, for minting to the same customer's wallet ${w.arc.address} on ${DESTINATION.name}.`,
        });
        return { ...(await finishCctp(tx.txHash, started)), burnTxHash: tx.txHash, burnUrl: explorerTxUrl(SOURCE, tx.txHash) };
      }
      case "mandate-approve-usdc":
        addEvidence({
          milestone: "M1(b)",
          chain: DESTINATION.name,
          what: "USDC allowance granted to the Mandate contract",
          txHash: tx.txHash,
          url: explorerTxUrl(DESTINATION, tx.txHash),
          proves: `The customer's wallet ${w.arc.address} allows the Mandate contract to move at most the daily cap. Funds stay in the customer's wallet.`,
        });
        return { txHash: tx.txHash, url: explorerTxUrl(DESTINATION, tx.txHash) };
      case "mandate-set": {
        const terms = await deps.chain.mandateTerms(w.arc.address);
        addEvidence({
          milestone: "M1(b)",
          chain: DESTINATION.name,
          what: "Mandate set by the customer (Mandate.setMandate)",
          txHash: tx.txHash,
          url: explorerTxUrl(DESTINATION, tx.txHash),
          proves: terms
            ? `Customer ${w.arc.address} set mandate version ${terms.version}: agent ${terms.agent}, per-order cap ${baseUnitsToUsdc(terms.perOrderCap)} USDC, rolling daily cap ${baseUnitsToUsdc(terms.dailyCap)} USDC, recipient allowlist [${deps.allowedRecipient}], expiry ${new Date(Number(terms.expiry) * 1000).toISOString()}.`
            : `Customer ${w.arc.address} set a mandate.`,
        });
        return { txHash: tx.txHash, url: explorerTxUrl(DESTINATION, tx.txHash) };
      }
      default:
        throw new HttpError(400, `unknown action "${action}"`);
    }
  }

  /** Attestation, then the relayed mint on Arc. Safe to call again for a burn that is already known. */
  async function finishCctp(burnTxHash: Hex, startedMs: number) {
    const w = requireWallets();
    const before = await deps.chain.usdcBalance(DESTINATION, w.arc.address);
    const attested = await deps.chain.waitForAttestation(SOURCE.cctpDomain, burnTxHash);
    const mintTxHash = await deps.chain.relayMint(attested.message, attested.attestation);
    const after = await deps.chain.usdcBalance(DESTINATION, w.arc.address);
    const attestationSeconds = Math.round(attested.waitedMs / 100) / 10;
    const totalSeconds = Math.round((now().getTime() - startedMs) / 100) / 10;
    setState({ cctp: { ...state().cctp!, burnTxHash, mintTxHash, attestationSeconds, totalSeconds } });
    addEvidence({
      milestone: "M1(a)",
      chain: DESTINATION.name,
      what: "CCTP V2 mint (MessageTransmitterV2.receiveMessage)",
      txHash: mintTxHash,
      url: explorerTxUrl(DESTINATION, mintTxHash),
      proves: `USDC minted to the customer's Circle user-controlled wallet ${w.arc.address} on ${DESTINATION.name}: balance ${baseUnitsToUsdc(before)} -> ${baseUnitsToUsdc(after)}. Attestation took ${attestationSeconds} s after the burn confirmed; ${totalSeconds} s from the customer's approval to the mint.`,
    });
    return { mintTxHash, mintUrl: explorerTxUrl(DESTINATION, mintTxHash), attestationSeconds, totalSeconds };
  }

  async function overview() {
    const s = state();
    const w = s.wallets;
    const out: Record<string, unknown> = {
      appId: deps.appId,
      source: SOURCE.name,
      destination: DESTINATION.name,
      wallets: w ?? null,
      agentWallet: (await deps.agentWallet()) ?? null,
      allowedRecipient: deps.allowedRecipient,
      mandateContract: MANDATE_ARC_TESTNET.address,
      cctp: s.cctp ?? null,
      gatewayFlow: s.gateway ?? null,
      evidence: loadJson<EvidenceEntry[]>(deps.evidencePath, []),
    };
    if (w?.source && w.arc) {
      const [sourceUsdc, sourceGas, arcUsdc, unified, terms, record, spent] = await Promise.all([
        deps.chain.usdcBalance(SOURCE, w.source.address),
        deps.chain.nativeBalance(SOURCE, w.source.address),
        deps.chain.usdcBalance(DESTINATION, w.arc.address),
        deps.chain.unifiedBalance(w.arc.address),
        deps.chain.mandateTerms(w.arc.address),
        deps.chain.mandateRecord(w.arc.address),
        deps.chain.spentInWindow(w.arc.address),
      ]);
      out.balances = {
        sourceUsdc: baseUnitsToUsdc(sourceUsdc),
        sourceGasWei: sourceGas.toString(),
        arcUsdc: baseUnitsToUsdc(arcUsdc),
      };
      out.gateway = { total: unified.total, perDomain: unified.perDomain };
      out.mandate = terms
        ? {
            agent: terms.agent,
            mode: terms.mode,
            revoked: terms.revoked,
            version: terms.version.toString(),
            perOrderCap: baseUnitsToUsdc(terms.perOrderCap),
            dailyCap: baseUnitsToUsdc(terms.dailyCap),
            spentInWindow: baseUnitsToUsdc(spent),
            expiry: new Date(Number(terms.expiry) * 1000).toISOString(),
          }
        : null;
      out.record = record.map((r) => ({ ...r, url: explorerTxUrl(DESTINATION, r.txHash) }));
    }
    return out;
  }

  const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    "GET /api/state": () => overview(),
    // The SDK needs the session in the browser. It is a 60-minute token that can only *propose*
    // challenges; approving one still takes the customer's PIN.
    "POST /api/session": async () => ({ appId: deps.appId, ...(await userToken()) }),
    "POST /api/wallet/init": async () => {
      const { userToken: token } = await userToken();
      try {
        return await deps.circle.initializeUser(token, {
          accountType: "EOA",
          blockchains: [SOURCE.circleBlockchain, DESTINATION.circleBlockchain],
        });
      } catch (err) {
        if (err instanceof CircleApiError && err.code === USER_ALREADY_INITIALIZED) return { alreadyInitialized: true };
        throw err;
      }
    },
    "POST /api/wallet/refresh": async () => {
      const { userToken: token } = await userToken();
      const wallets = pickWallets(await deps.circle.listWallets(token));
      setState({ wallets });
      return { wallets };
    },
    "POST /api/challenge": (body) => createChallenge(String(body.action), body),
    "POST /api/complete": (body) => complete(String(body.action), String(body.challengeId), body),
    "POST /api/cctp/resume": async () => {
      const burn = state().cctp?.burnTxHash;
      if (!burn) throw new HttpError(409, "No burn to resume.");
      if (state().cctp?.mintTxHash) return state().cctp;
      return finishCctp(burn, now().getTime());
    },
  };

  /** Connect-style middleware: handles /api/*, passes everything else on. */
  return async function handle(req: IncomingMessage, res: ServerResponse, next?: () => void) {
    const path = (req.url ?? "").split("?")[0]!;
    const route = routes[`${req.method} ${path}`];
    if (!route) {
      if (path.startsWith("/api/")) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
        return;
      }
      next?.();
      return;
    }
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const result = await route(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof CircleApiError ? 502 : 500;
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
  };
}
