# Milestone evidence

One row per piece of evidence, added as it is produced. A row is only added once the hash or response exists; nothing here is forward-looking.

## Evidence log

| Date (UTC) | Milestone | Chain | Evidence | What it proves |
|---|---|---|---|---|
| 2026-11-26 | M1 (prep) | Arc Testnet, Ethereum Sepolia, Base Sepolia | `pnpm verify:chains`: 35 of 35 read-only checks passed (no transaction) | The chain ids, CCTP V2 domains, CCTP V2 and Gateway contract addresses, USDC addresses and USYC testnet contracts hardcoded in `packages/router/src/chains.ts` match the live networks. |
| 2026-11-26 | M1 (prep) | Circle Iris sandbox | `GET /v2/burn/USDC/fees/0/26` and `/6/26` each return a `finalityThreshold: 1000` entry (0.25 bps and 0.325 bps at the time of reading) | A CCTP V2 Fast Transfer route into Arc Testnet is offered from both Ethereum Sepolia and Base Sepolia. |
| 2026-11-26 | M1(c) (partial) | Circle Gateway testnet | `POST /v1/balances` read through `readUnifiedBalance` in `packages/router/src/gateway.ts` | The router can read a depositor's Gateway USDC balance per chain and in total. Not yet shown for the demo wallet, and funding an Arc-side action from it is not yet shown. |

No transaction has been sent yet, on any network.

## M1: USDC settlement leg on Arc (testnet)

| Item | Status | Evidence |
|---|---|---|
| 1a. CCTP V2 transfer, Sepolia to Arc testnet, into a Circle user-controlled wallet | Code written and unit-tested (`packages/router/src/cctp.ts`); not run yet. Waiting on faucet funds for the test wallet and on the user-controlled wallet. | |
| 1b. Agent Wallet on Arc testnet; transfer inside the limits succeeds, outside is rejected (limits enforced by the Mandate contract on testnet) | Mandate contract written, 20 Foundry tests passing locally including the cap breach; not deployed. Agent Wallet not created yet. | |
| 1c. Gateway unified balance read in the router; Arc-side action funded from it | Read implemented; demo wallet evidence pending | |
| `scripts/m1-evidence.ts` end-to-end re-run | Written for 1a and 1c; not run yet. 1b not covered yet. | |
| Screen recording of 1a and 1b | Not started | |

## M2: Dinari dShares on Arc

Not started. Sandbox only until an explicit mainnet go.

## M3: Copilot inside a mandate

Not started.

## M4: USYC on Arc testnet

Not started. Needs an Arc testnet address allowlisted on the USYC Entitlements contract (Circle Support ticket, 24 to 48 hours per the Arc docs).

## Phase summaries

### Phase 0, repository: 26 Nov 2026

- Repository created with the monorepo layout: `packages/router`, `packages/agent`, `contracts/`, `apps/demo`, `scripts/`, `docs/`.
- Proven: chain facts verified against the live testnets (35 of 35); Fast Transfer route into Arc testnet offered from both source testnets; Gateway balance read works.
- Mocked: nothing. `packages/agent`, `apps/demo` and `contracts/` are empty shells.
- Changed from the plan: M1(b)'s limit enforcement on testnet moves to the Mandate contract, because Circle spend policies are mainnet-only (see `docs/notes.md`).
- Open: Circle developer account and testnet API key; a funded test wallet on Sepolia for the source side of 1a.
