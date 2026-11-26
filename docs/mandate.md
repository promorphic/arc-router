# The mandate, and why it is enforced twice

A mandate is the set of limits a customer puts on what an agent may do with their money: which assets, which recipients, how much per order, how much per day, until when. The customer can revoke it at any time.

Promorphic enforces a mandate in two independent places. Neither is under Promorphic's control.

| | Layer 1: the Mandate contract | Layer 2: the Circle Agent Wallet spend policy |
|---|---|---|
| Where it runs | On Arc, in [`contracts/src/Mandate.sol`](../contracts/src/Mandate.sol) | In Circle's infrastructure, before the Agent Wallet signs |
| Who sets it | The customer's own wallet, by transaction | The customer, through the Circle CLI or Arc Portal, confirmed by a one-time code sent to the customer's email |
| What it limits | Asset allowlist, recipient allowlist, per-order cap, rolling 24-hour cap, expiry, revoke, and in Copilot mode a per-proposal approval | Per-transaction, daily, weekly and monthly transfer caps; recipient and contract allowlists and blocklists |
| What it sees | Every proposal the agent submits for that customer | Every transaction the Agent Wallet is asked to sign, whatever contract it targets |
| What a refusal looks like | A `ProposalRejected` event with the reason, in a successful transaction, so the refusal has a hash | Circle rejects the request before anything is signed |
| Availability | Any EVM network, including Arc testnet | Mainnet Agent Wallets only (Circle's docs, 26 Nov 2026) |

## How money moves

The customer's USDC stays in the customer's wallet. The customer grants the Mandate contract an ERC-20 allowance and names one agent address. When the agent submits a proposal that passes every check, the contract moves the USDC with `transferFrom` straight from the customer's wallet to the allowlisted recipient. The contract never holds a balance and the agent never holds the customer's USDC. The customer ends everything by revoking the mandate or setting the allowance to zero.

The contract has no admin, no owner, no upgrade path and no pause. Promorphic deploys it and then has no power over it.

## Why both layers

Each layer covers a failure the other cannot.

1. **The contract cannot see what the Agent Wallet does elsewhere.** The Mandate contract only limits calls made through it. If the agent's software were compromised, an attacker would try to use the Agent Wallet for something else entirely: approve a token to a contract they control, or send whatever balance the Agent Wallet holds for gas. The Circle policy stops that. The recommended policy is a contract allowlist containing only the Mandate contract, plus a low transfer cap sized for gas.

2. **The Circle policy cannot express the mandate.** Circle's policy has amounts over rolling windows and address lists. It has no notion of which asset an order is for, no expiry date, no per-proposal human approval, and no on-chain record of the decision. Those live in the contract.

3. **Different keys, different operators.** Changing the contract's limits needs a transaction from the customer's wallet. Changing the Circle policy needs a code from the customer's inbox. Getting past both means compromising two separate things the customer holds, and Promorphic holds neither.

4. **The record.** The contract writes every decision to the event log: who approved, under which mandate version, what was executed or rejected and why. That log is the audit record; an off-chain export only reformats it. A policy rejection at Circle leaves no on-chain trace, which is why the contract is the layer of record and the policy is the backstop.

## Modes

- **Manual.** No mandate. The customer signs everything.
- **Copilot.** The agent proposes; the customer approves each proposal on-chain (`approve`); the agent can then execute exactly that proposal, and only if it is still inside the limits. An approval never overrides a cap.
- **Autopilot.** The agent executes inside the limits without a per-proposal approval.

## The rolling 24-hour cap

Spend is counted in hourly buckets and the cap sums the current hour and the 24 before it. The window is therefore between 24 and 25 hours long, never shorter, so the agent can never move more than the cap in any 24-hour period. A fuzz test in `contracts/test/Mandate.t.sol` checks exactly that property. Setting a new mandate does not reset the window.

## What is not built yet

- Sell-side actions, where the asset rather than USDC leaves the customer's wallet.
- Actions that call an issuer contract on the customer's behalf (for example a USYC Teller deposit) rather than paying an allowlisted recipient.
- Deployment. The contract is tested locally and is not deployed on any network yet.
