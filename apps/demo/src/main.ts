/**
 * Demo page. Each button asks the server to prepare one transaction as a Circle challenge,
 * then hands the challenge to Circle's SDK, which opens Circle's own frame for the customer's
 * PIN. This page never sees the PIN and never holds a key.
 */
import { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";

interface State {
  appId: string;
  source: string;
  destination: string;
  wallets: { source?: { id: string; address: string }; arc?: { id: string; address: string } } | null;
  agentWallet: string | null;
  allowedRecipient: string;
  mandateContract: string;
  cctp: { amount: string; burnTxHash?: string; mintTxHash?: string; attestationSeconds?: number; totalSeconds?: number } | null;
  balances?: { sourceUsdc: string; sourceGasWei: string; arcUsdc: string };
  gateway?: { total: string; perDomain: { chain: string; domain: number; balance: string }[] };
  mandate?: { agent: string; mode: string; revoked: boolean; version: string; perOrderCap: string; dailyCap: string; spentInWindow: string; expiry: string } | null;
  record?: { kind: string; proposalId?: string; actor?: string; recipient?: string; amount?: string; reason?: string; mandateVersion: string; txHash: string; url: string }[];
}

const app = document.getElementById("app")!;
const sdk = new W3SSdk();
let state: State | undefined;
let busy = false;
const status: Record<string, { text: string; error?: boolean }> = {};

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `${path} failed with ${res.status}`);
  return json as T;
}

/** Hands a challenge to Circle's frame and resolves once the customer has approved it with their PIN. */
async function approveInCircleFrame(challengeId: string): Promise<void> {
  const session = await api<{ appId: string; userToken: string; encryptionKey: string }>("POST", "/api/session");
  sdk.setAppSettings({ appId: session.appId });
  sdk.setAuthentication({ userToken: session.userToken, encryptionKey: session.encryptionKey });
  await new Promise<void>((resolve, reject) => {
    sdk.execute(challengeId, (error) => {
      if (error) reject(new Error(error.message ?? "The challenge was not approved."));
      else resolve();
    });
  });
}

async function run(card: string, steps: () => Promise<string>) {
  if (busy) return;
  busy = true;
  status[card] = { text: "Working…" };
  render();
  try {
    status[card] = { text: await steps() };
  } catch (err) {
    status[card] = { text: (err as Error).message, error: true };
  } finally {
    busy = false;
    await refresh();
  }
}

/** One customer action: prepare, approve with PIN, wait for the chain. */
async function customerAction(card: string, action: string, body: Record<string, unknown>, done: (r: Record<string, string>) => string) {
  await run(card, async () => {
    const { challengeId } = await api<{ challengeId: string }>("POST", "/api/challenge", { action, ...body });
    status[card] = { text: "Enter your PIN in the Circle window…" };
    render();
    await approveInCircleFrame(challengeId);
    status[card] = { text: action === "cctp-burn" ? "Burn sent. Waiting for Circle's attestation, then minting on Arc…" : "Approved. Waiting for the transaction to confirm…" };
    render();
    return done(await api<Record<string, string>>("POST", "/api/complete", { action, challengeId }));
  });
}

async function refresh() {
  try {
    state = await api<State>("GET", "/api/state");
  } catch (err) {
    status.global = { text: (err as Error).message, error: true };
  }
  render();
}

// ------------------------------------------------------------------ rendering

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  Object.assign(node, rest);
  if (className) node.className = className;
  node.append(...children);
  return node;
}
const mono = (text: string) => el("span", { class: "mono" }, text);
const link = (text: string, href: string) => el("a", { href, target: "_blank", rel: "noreferrer" }, text);
const short = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-8)}`;

function defs(rows: [string, Node | string][]) {
  const dl = el("dl");
  for (const [k, v] of rows) dl.append(el("dt", {}, k), el("dd", {}, v));
  return dl;
}

function card(id: string, title: string, intro: string, opts: { done?: boolean; locked?: boolean }, ...body: Node[]) {
  const s = status[id];
  return el(
    "section",
    { class: `card${opts.done ? " done" : ""}${opts.locked ? " locked" : ""}`, id: `card-${id}` },
    el("h2", {}, title),
    el("p", {}, intro),
    ...body,
    el("div", { class: `status${s?.error ? " error" : ""}` }, s?.text ?? ""),
  );
}

function button(label: string, onClick: () => void, opts: { disabled?: boolean; secondary?: boolean } = {}) {
  return el("button", { textContent: label, onclick: onClick, disabled: busy || !!opts.disabled, class: opts.secondary ? "secondary" : "" });
}

function render() {
  if (!state) {
    app.replaceChildren(el("p", { class: status.global?.error ? "status error" : "muted" }, status.global?.text ?? "Loading…"));
    return;
  }
  const s = state;
  const w = s.wallets;
  const hasWallet = !!(w?.source && w.arc);
  const amountInput = (document.getElementById("amount") as HTMLInputElement | null)?.value ?? "5";
  const funded = hasWallet && Number(s.balances?.sourceUsdc ?? 0) > 0 && BigInt(s.balances?.sourceGasWei ?? "0") > 0n;
  const arrived = !!s.cctp?.mintTxHash;

  // 1. Wallet
  const walletCard = card(
    "wallet",
    "1. Your wallet",
    "A Circle user-controlled wallet. You set the PIN; Promorphic cannot sign for you.",
    { done: hasWallet },
    hasWallet
      ? defs([
          [`${s.source} address`, mono(w!.source!.address)],
          [`${s.source} wallet ID`, mono(w!.source!.id)],
          [`${s.destination} address`, mono(w!.arc!.address)],
          [`${s.source} balance`, `${s.balances?.sourceUsdc ?? "…"} USDC, ${(Number(BigInt(s.balances?.sourceGasWei ?? "0") / 10n ** 12n) / 1e6).toFixed(4)} ETH for gas`],
          [`${s.destination} balance`, `${s.balances?.arcUsdc ?? "…"} USDC`],
        ])
      : el("div", { class: "row" },
          button("Create wallet and set PIN", () =>
            run("wallet", async () => {
              const init = await api<{ challengeId?: string; alreadyInitialized?: boolean }>("POST", "/api/wallet/init");
              if (init.challengeId) {
                status.wallet = { text: "Set your PIN and recovery questions in the Circle window…" };
                render();
                await approveInCircleFrame(init.challengeId);
              }
              // Wallet creation finishes a moment after the PIN is set.
              for (let i = 0; i < 20; i++) {
                const { wallets } = await api<{ wallets: State["wallets"] }>("POST", "/api/wallet/refresh");
                if (wallets?.source && wallets.arc) return "Wallet created.";
                await new Promise((r) => setTimeout(r, 1500));
              }
              throw new Error("The wallet has not appeared yet. Try again in a moment.");
            }),
          ),
        ),
    ...(hasWallet && !funded
      ? [el("p", { class: "muted" }, `Fund it with testnet USDC and gas on ${s.source}: Circle Console → Faucet → paste the ${s.source} wallet ID above.`)]
      : []),
  );

  // 2. CCTP
  const cctpCard = card(
    "cctp",
    "2. Move USDC to Arc",
    `CCTP V2 Fast Transfer: USDC is burned on ${s.source} and minted to your own wallet on ${s.destination}. No bridge, no wrapped token.`,
    { done: arrived, locked: !funded && !arrived },
    el("div", { class: "row" },
      el("label", {}, "Amount (USDC) ", el("input", { id: "amount", value: amountInput, inputMode: "decimal" })),
      button("1. Allow the transfer", () =>
        customerAction("cctp", "cctp-approve", { amount: (document.getElementById("amount") as HTMLInputElement).value }, (r) => `Allowance set (${short(r.txHash!)}). Now send.`),
        { disabled: !funded, secondary: true }),
      button("2. Burn and send to Arc", () =>
        customerAction("cctp", "cctp-burn", { amount: (document.getElementById("amount") as HTMLInputElement).value }, (r) => `Arrived on Arc in ${r.totalSeconds} s.`),
        { disabled: !funded }),
      ...(s.cctp?.burnTxHash && !s.cctp.mintTxHash
        ? [button("Resume", () => run("cctp", async () => { await api("POST", "/api/cctp/resume"); return "Arrived on Arc."; }), { secondary: true })]
        : []),
    ),
    ...(s.cctp?.burnTxHash
      ? [defs([
          ["Burn", link(short(s.cctp.burnTxHash), `https://sepolia.etherscan.io/tx/${s.cctp.burnTxHash}`)],
          ...(s.cctp.mintTxHash
            ? ([
                ["Mint", link(short(s.cctp.mintTxHash), `https://explorer.testnet.arc.io/tx/${s.cctp.mintTxHash}`)],
                ["Latency", `attestation ${s.cctp.attestationSeconds} s; approval to mint ${s.cctp.totalSeconds} s`],
              ] as [string, Node | string][])
            : []),
        ])]
      : []),
  );

  // 3. Gateway
  const gatewayCard = card(
    "gateway",
    "3. Unified balance",
    "Circle Gateway: one USDC balance across chains, read by the router.",
    { locked: !hasWallet },
    ...(s.gateway
      ? [defs([...s.gateway.perDomain.map((d): [string, string] => [d.chain, `${d.balance} USDC`]), ["Total in Gateway", `${s.gateway.total} USDC`]])]
      : []),
  );

  // 4. Mandate
  const m = s.mandate;
  const mandateCard = card(
    "mandate",
    "4. Your mandate",
    "The limits your agent works inside, enforced by the Mandate contract on Arc. You can revoke it at any time.",
    { done: !!m && !m.revoked, locked: !arrived },
    defs([
      ["Agent", s.agentWallet ? mono(s.agentWallet) : "Circle Agent Wallet not created yet"],
      ["Allowed recipient", mono(s.allowedRecipient)],
      ["Mandate contract", link(s.mandateContract, `https://explorer.testnet.arc.io/address/${s.mandateContract}`)],
      ...(m
        ? ([
            ["In force", `version ${m.version}, ${m.mode}${m.revoked ? " (revoked)" : ""}`],
            ["Per order", `${m.perOrderCap} USDC`],
            ["Per rolling day", `${m.dailyCap} USDC (${m.spentInWindow} used)`],
            ["Expires", new Date(m.expiry).toLocaleString()],
          ] as [string, string][])
        : [["Proposed limits", "2 USDC per order, 5 USDC per rolling day, 7 days"] as [string, string]]),
    ]),
    el("div", { class: "row" },
      button("1. Allow the Mandate contract", () =>
        customerAction("mandate", "mandate-approve-usdc", {}, (r) => `Allowance set (${short(r.txHash!)}). Now set the mandate.`),
        { disabled: !arrived || !s.agentWallet, secondary: true }),
      button("2. Set mandate", () =>
        customerAction("mandate", "mandate-set", {}, (r) => `Mandate set (${short(r.txHash!)}).`),
        { disabled: !arrived || !s.agentWallet }),
    ),
  );

  // 5. Record
  const rows = s.record ?? [];
  const recordCard = card(
    "record",
    "5. Record",
    "Every mandate change, execution and refusal, read from the contract's event log.",
    { locked: rows.length === 0 },
    rows.length === 0
      ? el("p", { class: "muted" }, "Nothing recorded yet.")
      : el("div", { class: "scroll" },
          el("table", {},
            el("thead", {}, el("tr", {}, ...["What", "Amount", "To", "Outcome", "Transaction"].map((h) => el("th", {}, h)))),
            el("tbody", {}, ...rows.map((r) =>
              el("tr", {},
                el("td", {}, r.kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()),
                el("td", {}, r.amount ? `${(Number(r.amount) / 1e6).toFixed(2)} USDC` : ""),
                el("td", {}, r.recipient ? mono(short(r.recipient)) : ""),
                el("td", { class: r.kind === "ProposalRejected" ? "bad" : r.kind === "ProposalExecuted" ? "ok" : "" },
                  r.kind === "ProposalRejected" ? `rejected: ${r.reason}` : r.kind === "ProposalExecuted" ? "executed" : `v${r.mandateVersion}`),
                el("td", {}, link(short(r.txHash), r.url)),
              ),
            )),
          ),
        ),
  );

  app.replaceChildren(walletCard, cctpCard, gatewayCard, mandateCard, recordCard, el("div", { class: "row" }, button("Refresh", () => void refresh(), { secondary: true })));
}

void refresh();

// While the wallet waits for faucet funds, poll so the transfer buttons unlock without a reload.
setInterval(() => {
  const b = state?.balances;
  const waitingForFunds = !!state?.wallets?.source && !state.cctp?.burnTxHash && !(Number(b?.sourceUsdc ?? 0) > 0 && BigInt(b?.sourceGasWei ?? "0") > 0n);
  if (waitingForFunds && !busy && document.visibilityState === "visible") void refresh();
}, 8000);
