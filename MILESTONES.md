# Milestone evidence

One row per piece of evidence, added as it is produced. A row is only added once the hash or response exists; nothing here is forward-looking.

## Evidence log

| Date (UTC) | Milestone | Chain | Evidence | What it proves |
|---|---|---|---|---|
| 2026-11-26 | M1 (prep) | Arc Testnet, Ethereum Sepolia, Base Sepolia | `pnpm verify:chains`: 35 of 35 read-only checks passed (no transaction) | The chain ids, CCTP V2 domains, CCTP V2 and Gateway contract addresses, USDC addresses and USYC testnet contracts hardcoded in `packages/router/src/chains.ts` match the live networks. |
| 2026-11-26 | M1 (prep) | Circle Iris sandbox | `GET /v2/burn/USDC/fees/0/26` and `/6/26` each return a `finalityThreshold: 1000` entry (0.25 bps and 0.325 bps at the time of reading) | A CCTP V2 Fast Transfer route into Arc Testnet is offered from both Ethereum Sepolia and Base Sepolia. |
| 2026-11-26 | M1(c) (partial) | Circle Gateway testnet | `POST /v1/balances` read through `readUnifiedBalance` in `packages/router/src/gateway.ts` | The router can read a depositor's Gateway USDC balance per chain and in total. Not yet shown for the demo wallet, and funding an Arc-side action from it is not yet shown. |
| 2026-11-26 | M1(b) (contract) | Arc Testnet | [deploy 0x3e2cabf8…dbdcd6](https://explorer.testnet.arc.io/tx/0x3e2cabf82f132f72be57b51649c0e5e9470b4d053a58d54232c909e9a2dbdcd6) | The Mandate contract is deployed at `0x2D1CBBEea337a30dF22C0446dB2528B98B543D10`. The deployer (the test wallet) has no role in it. |
| 2026-11-26 | M1(b) (contract, test keys) | Arc Testnet | [executed 0x2d7acfb6…5b6820](https://explorer.testnet.arc.io/tx/0x2d7acfb67b4a4758191c7f8db3b635915cc1dc4eac784ff37cf1860da65b6820) | An in-limit proposal (0.10 USDC, cap 0.10) moved USDC from the customer straight to the allowlisted recipient. Customer and agent here are test keys, not Circle wallets. |
| 2026-11-26 | M1(b) (contract, test keys) | Arc Testnet | [rejected 0x572e489c…1ee5e6](https://explorer.testnet.arc.io/tx/0x572e489cc09cae11b4632281c5850a245629f238650d9ccf74a62901181ee5e6) | A proposal over the per-order cap (0.11 USDC) was rejected with reason `OverPerOrderCap`; the transaction succeeded and nothing moved. |
| 2026-11-26 | M1(b) (contract, test keys) | Arc Testnet | [rejected 0xa550547d…04e0d5](https://explorer.testnet.arc.io/tx/0xa550547da32f14375ecfb1cb94ad29551664286378aa9a7ea4dbd629bc04e0d5) | A proposal to a recipient outside the allowlist was rejected with reason `RecipientNotAllowed`. |
| 2026-11-26 | M1(b) (contract, test keys) | Arc Testnet | [rejected 0x722763a5…4da1c9](https://explorer.testnet.arc.io/tx/0x722763a585a42d307e8f8f942682261691d9c5147abc0d38cc9bd31c444da1c9) | The order that would have exceeded the rolling daily cap was rejected with reason `OverDailyCap`. |
| 2026-11-26 | M1(b) (Agent Wallet) | Arc Testnet | [approve 0x7dc957f1…6aa0a6](https://explorer.testnet.arc.io/tx/0x7dc957f159a3c2dc0959e8d0e2d33f438fc42d79a3adf1b4ea59b20a8d6aa0a6), [setMandate 0x5e329b2d…44ecb0](https://explorer.testnet.arc.io/tx/0x5e329b2d76cdbfa1ec62cf60d94305b4a9212f1bf319696c656632973644ecb0) | The customer (`0x43fc…E4d9`, a test wallet with faucet funds standing in for the customer) allowed the Mandate contract 5 USDC and named the Circle Agent Wallet `0x1023fe642ca99b40028d187fe491c0e56a038c6e` as agent: per-order cap 2 USDC, rolling daily cap 5 USDC, one allowlisted recipient, 7-day expiry. |
| 2026-11-26 | M1(b) (Agent Wallet) | Arc Testnet | [executed 0x3a978f2a…12f43d](https://explorer.testnet.arc.io/tx/0x3a978f2aba74e571aa68adbb4cce491888bedeb5fb382eb0c0c9d0c85112f43d) | The Circle Agent Wallet, signed for by Circle through the Circle CLI, submitted a 1 USDC proposal inside the limits. The contract moved 1 USDC from the customer straight to the allowlisted recipient `0x1413…D3F0`; the Agent Wallet's own balance did not change. |
| 2026-11-26 | M1(b) (Agent Wallet) | Arc Testnet | [rejected 0xcb6bd140…465e5d](https://explorer.testnet.arc.io/tx/0xcb6bd14046870eb9d43e22554de6b57540296043b5d3fe9033c137a930465e5d) | The same Agent Wallet submitted 3 USDC against the 2 USDC per-order cap. Rejected with `OverPerOrderCap`; the transaction succeeded and nothing moved. |
| 2026-11-26 | M1(b) (Agent Wallet) | Arc Testnet | [rejected 0x8fb5ba17…a0cca8](https://explorer.testnet.arc.io/tx/0x8fb5ba177df411e80433790f87f87921e7b594bb896822b1e7f7e0a7f9a0cca8) | The same Agent Wallet submitted 1 USDC to an address outside the allowlist. Rejected with `RecipientNotAllowed`; nothing moved. |
| 2026-11-26 | M1(b) (export) | Arc Testnet | [`evidence/m1b-agent-wallet-2026-11-26.json`](evidence/m1b-agent-wallet-2026-11-26.json), [`.csv`](evidence/m1b-agent-wallet-2026-11-26.csv), [`evidence/m1.json`](evidence/m1.json) | The audit record of that run (mandate version 3 and the three decisions, with the Agent Wallet as actor), and the script's own evidence entries. Re-run with `pnpm m1b:agent`. |
| 2026-11-26 | M3 (contract, test keys) | Arc Testnet | [approved 0x3b2bf9f7…b4d49e](https://explorer.testnet.arc.io/tx/0x3b2bf9f7027254ef9f6e97b9ed568586d063534c270574db39e803244fb4d49e), [executed 0x0f99f574…217415](https://explorer.testnet.arc.io/tx/0x0f99f574fe75f85ebbd752e1fa4a8c2432c51f88817cf7ff9da4eb2d84217415) | Copilot: the customer approved one proposal on-chain and the agent then executed exactly that proposal. An unapproved one ([0x7146d53b…5c1f56](https://explorer.testnet.arc.io/tx/0x7146d53bb2865bdcc6a43943473e9a3c7c8d35317ecb42896e55b053575c1f56)) and one changed after approval ([0x66b53944…7aa116](https://explorer.testnet.arc.io/tx/0x66b53944496401d42c956f39ac1c463c648f3750fb8c211277ab5c884f7aa116)) were rejected with `NotApproved`. |
| 2026-11-26 | M3 (contract, test keys) | Arc Testnet | [revoked 0x89d4ac41…0b9ff0](https://explorer.testnet.arc.io/tx/0x89d4ac41c43abc4034f7a049de84514e1bd7b79087350c48cb427ba1c30b9ff0), [rejected 0x2283937d…058e53](https://explorer.testnet.arc.io/tx/0x2283937d664ce65f8877a0b05c82b4c04b5eac23ad674909c3785c282f058e53) | The customer revoked the mandate; the next proposal was rejected with `Revoked`. |
| 2026-11-26 | M3(e) (export) | Arc Testnet | [`evidence/mandate-e2e-2026-11-26.json`](evidence/mandate-e2e-2026-11-26.json), [`.csv`](evidence/mandate-e2e-2026-11-26.csv) | The audit record export for that run: 16 lines, each with timestamp, actor, mandate version, outcome and transaction hash, read from the contract's event log by `pnpm record`. |

Every transaction above is on a testnet. No mainnet transaction has been sent.

Reading the Agent Wallet rows on the explorer: the Agent Wallet is a smart account, so each of its transactions is sent by a bundler to the ERC-4337 EntryPoint (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`) and the explorer's "from" is the bundler. The caller the Mandate contract saw is in the `agent` field of the `ProposalExecuted` or `ProposalRejected` event in the same transaction, and it is the Agent Wallet.

## M1: USDC settlement leg on Arc (testnet)

| Item | Status | Evidence |
|---|---|---|
| 1a. CCTP V2 transfer, Sepolia to Arc testnet, into a Circle user-controlled wallet | Demo app and server flow built and tested with fakes; Circle's testnet API checked live (user, session, wallet challenge on `ARC-TESTNET`). Not run yet: needs the customer to set a PIN and the wallet funded from the Console faucet. | |
| 1b. Agent Wallet on Arc testnet; transfer inside the limits succeeds, outside is rejected (limits enforced by the Mandate contract on testnet) | Done with the Circle Agent Wallet as agent: executed, over cap and wrong recipient, each with a hash (26 Nov 2026). The customer in that run was a test wallet with faucet funds. Still to do: repeat with the customer's Circle user-controlled wallet setting the mandate (needs the customer's PIN). | See the evidence log, rows "M1(b) (Agent Wallet)" |
| 1c. Gateway unified balance read in the router; Arc-side action funded from it | Read implemented; demo wallet evidence pending | |
| `scripts/m1-evidence.ts` end-to-end re-run | Written for 1a and 1c with a local test key as the source; not run (the test wallet has no Sepolia funds). `pnpm test:e2e` re-runs the Mandate flow live. | |
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
