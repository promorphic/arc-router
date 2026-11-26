# M2 plan: Dinari dShares, issuer-primary leg, volume page (sandbox only)

Status on 26 Nov 2026: **planned, not built.** No M2 code exists yet. No order has been placed with Dinari, in its sandbox or anywhere else, and no Dinari account or key exists for this repository. The facts this plan builds on, with source URLs, are in [notes.md](notes.md) under "Dinari API".

Ground rules for M2: sandbox only, until a separate explicit go for mainnet. Auth is mocked behind an interface until a sandbox key exists. The customer's USDC and dShares stay in the customer's own wallet; no Promorphic key takes custody.

## 1. Dinari client: `packages/router/src/dinari.ts`

A thin `fetch` client in the style of `circle-wallets.ts`, rather than Dinari's SDK, because the SDK defaults to production and the rest of the router injects `fetch` for tests.

- **Sandbox only, by allowlist.** The constructor accepts exactly the sandbox base URL and throws on any other host, the live host included. There is no production option in the type. `DINARI_ENV` must be `sandbox`. Dinari documents no key prefix that separates sandbox keys from live ones; if the dashboard shows one, add a key check like the Circle `TEST_API_KEY:` check.
- **Injectable auth.** `interface DinariAuth { headers(): Promise<Record<string, string>>; kind: "api-key" | "mock" }`. `apiKeyAuth()` sends the two documented headers, `X-API-Key-Id` and `X-API-Secret-Key`. `mockAuth()` sends labelled placeholders and only works with an injected `fetch`, so mock credentials can never reach Dinari.
- **Methods, one per documented endpoint:**
  - onboarding handoff: create and read an entity, managed KYC URL, read KYC, create an account (always `BASELINE`; `US` is refused in code), wallet nonce, connect wallet, read wallet;
  - market data: list stocks (following pagination), current quote, market hours;
  - orders, self-custody path only: create the EIP-155 order permit, submit it, read the order request, read and list orders, list fulfillments, cancel;
  - balances and income: dividend payments, cash, portfolio;
  - sandbox faucet.
- **Not implemented, on purpose:** Dinari's managed-order endpoints. They need a Dinari-managed wallet, which Dinari offers only for the partner's own accounts. That would be an omnibus account holding customer positions, which this design rules out.
- `DinariApiError` carries `status`, `error_id`, `message` and the field errors of a 422.

Pure helpers in `dinari-sessions.ts`:

- `classifySession()` returns `regular`, `extended`, `overnight`, `open` or `closed`, from the market-hours endpoint, with the documented Eastern-time clock as a labelled fallback.
- `effectiveOrder()` says what Dinari will actually do. A market order outside the Regular session, or a market buy of a non-fractionable stock, becomes a marketable limit at the latest ASK (buy) or BID (sell). The customer is shown that price before signing.
- Precision checks with the documented limits, and a 24/7-ticker gate for the Open session.

`dinari-fake.ts`: an in-memory implementation of exactly those endpoints, shaped by the documented schemas, with a controllable clock, quotes, fills and failures. The unit tests use it, and so does the demo until a key exists. Every record it produces is marked `dataSource: "mock"`.

## 2. Circle wallet addition

Linking the customer's wallet to their Dinari account needs a signed message. Add `createSignMessageChallenge` to `CircleWalletsClient`, after checking the endpoint shape against Circle's OpenAPI file. The customer signs with their PIN in Circle's frame, as for the Gateway burn intent.

## 3. Router leg "issuer primary": `packages/router/src/issuer-primary.ts`

Four steps, each over injected dependencies, returning data and never signing:

1. **Quote.** Find the stock; require it to be tradable and to have a token on the Arc chain id, else "not available on Arc". Read market hours and the quote, compute the effective order, and compute the USDC needed including Dinari's fee from the permit response.
2. **Eligibility.** Returns a list of reasons, empty when eligible:
   - the customer's KYC or KYB is complete;
   - the customer is an organisation;
   - the account is active and `BASELINE`;
   - the country is not on Dinari's restricted list;
   - the wallet linked at Dinari is the customer's own Circle user-controlled wallet on Arc;
   - the stock trades in the current session.
3. **Funding the USDC leg on Arc.** Compares the customer's USDC on Arc with what the order needs. If it is short, the plan draws first from the customer's Gateway unified balance and otherwise uses a CCTP V2 transfer from their funding chain, both built with the existing modules. The result is a list of customer actions to approve. Every mint goes to the customer's own wallet, and a test asserts that no other recipient appears.
4. **Order and settlement record.** Create the permit with a `client_order_id`. The customer signs it as a Circle typed-data challenge. The router submits it, then follows the order request, the order and its fulfillments to a terminal state. Each order produces one settlement record, which holds:
   - the client order id and the proposal id (`keccak256` of the client order id, as in the Mandate);
   - the customer wallet and an opaque customer reference (never a name);
   - symbol, side, the order as asked and as Dinari converted it, the session and the quote;
   - Dinari's order request id, order id, order transaction hash and chain id;
   - every fulfillment and their sums, and the fees;
   - the funding legs' hashes or transfer ids;
   - an `incentivised` flag, `dataSource` (`mock`, `sandbox` or `mainnet`) and timestamps.

   Amounts come from fulfillments only. Dinari documents that an order's own quantities are what was requested, not what filled.

**Mandate.** `Mandate.execute` pays an allowlisted recipient from the customer's allowance. A Dinari order instead pulls payment under the customer's signed permit, so the Mandate cannot place a Dinari order by itself.

- Manual mode (the M2 test): the customer signs the permit.
- Copilot: the agent's proposal is checked with the Mandate's `preview`, the customer records approval with `Mandate.approve` and then signs the permit, and the settlement record links the two by proposal id.
- Autopilot for dShares needs either a Mandate extension or the Agent Wallet as the Dinari-linked wallet. That is M3 and is not part of M2.

## 4. Volume page and indexer stub: `apps/volume/`

A sibling static app rather than a route in `apps/demo`, because the demo needs Circle and relayer keys to start and a public page must not.

- `packages/router/src/volume.ts`: `aggregateVolume(records)` computes, per chain, the notional (USDC spent on buys plus USDC received on sells, from fulfillments), the trade count (orders with at least one fill), unique traders (distinct customer wallets), and the organic versus incentivised split, with `dataSource` and `generatedAt`.
- `apps/volume/indexer/`: one interface with two sources.
  - Settlement records: implemented in M2.
  - On-chain fills on Arc: a stub that throws "not implemented: needs Dinari's order contract address and ABI on Arc" rather than returning zeros.
  - `pnpm volume:index` writes `apps/volume/public/volume.json`.
- `apps/volume/index.html`: renders the numbers under a banner set by `dataSource`, either "Mock data. No real trade has happened." or "Dinari sandbox data. No real trade has happened." A file with no `dataSource` is not rendered.
- It is not deployed anywhere until the founders decide where it lives.

## 5. Demo

One card, "dShares order (mock issuer)", in `apps/demo`, through an injected `ApiDeps.dinari`, labelled mock or sandbox. This has the lowest priority.

## 6. Tests

All are unit tests in vitest, with Dinari faked and no network, in the style of `gateway-transfer.test.ts` and `apps/demo/server/api.test.ts`.

| Area | Cases |
|---|---|
| Client | Live and unknown hosts refused; `DINARI_ENV` other than `sandbox` refused; mock auth without an injected `fetch` refused; both auth headers sent; each method's path and body; pagination; `US` jurisdiction refused; error bodies surfaced |
| Sessions | Every boundary in Eastern time, including the Sunday 20:00 overnight start, the Friday 20:00 open start, a holiday, an early close and both DST changes; market to marketable limit at ASK or BID; non-fractionable market buy; precision limits; 24/7 gate |
| Issuer primary | Quote; stock with no Arc token; each eligibility reason alone; funding from the Arc balance, from Gateway and from CCTP, and insufficient everywhere; no non-customer recipient; a permit signed by the wrong wallet rejected before submission; full, partial, cancelled and rejected orders; the record sums fulfillments; Copilot refused when `preview` returns a reason |
| Volume | Empty set; buys and sells; partial fills; one trader with many orders; organic versus incentivised; per chain; an order with no fills is not a trade |
| Indexer | Records source end to end; on-chain stub throws; missing `dataSource` refused |
| Live (`tests/live`, read-only) | With no key: the sandbox host answers and refuses an unauthenticated call with the documented error shape. With a sandbox key, later: stocks, which have an Arc token, market hours, one quote |

A script, `scripts/dinari-arc-dshares.ts`, will print which stocks carry a token on Arc mainnet and Arc testnet once a sandbox key exists. Its output goes into `notes.md`.

## 7. Open questions

- Is Arc live for dShares? Dinari's supported-chains page does not list it, while its API schema accepts Arc's chain ids (see `notes.md`). Which dShares are on Arc, and is the payment token there USDC, USD+ or both?
- What are Dinari's order contract address and fill events on Arc? The on-chain indexer needs them.
- What counts as "incentivised" on the volume page?
- Where will the volume page be hosted?
