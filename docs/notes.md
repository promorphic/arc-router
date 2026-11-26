# Integration notes

Dated notes on where Circle, Arc or Dinari behave differently from their documentation, or where the documentation is silent and we had to find out. Newest first within each date.

## 26 Nov 2026

### Agent Wallet spending policies are mainnet-only

- The spending-policy how-to says: "Policies apply to mainnet agent wallets only" and "Spending policies require a mainnet agent wallet. Testnet is not supported." The quickstart repeats it: "Spending policies aren't available on testnet."
  Sources: https://developers.circle.com/agent-stack/agent-wallets/wallet-operations/custom-policies and https://developers.circle.com/agent-stack/agent-wallets/quickstart
- Consequence for us: a policy pass and a policy rejection cannot be demonstrated on Arc testnet. On testnet the "inside the limit succeeds, outside is rejected" pair is enforced by our Mandate contract; the Circle policy is the second layer on mainnet.
- The default when no custom transfer limit applies is 100 USDC per month. By the same pages this is a mainnet policy, so it cannot be observed on testnet either.
- Policies are set through the Circle CLI (`circle wallet limit set`, CLI 1.4.0 or later). We found no public REST endpoint or JSON schema for policies, and no documented error shape for an out-of-policy request; we will record the actual response when we first see one.
- A transfer limit needs all four caps (`--per-tx`, `--daily`, `--weekly`, `--monthly`) with per-tx ≤ daily ≤ weekly ≤ monthly. Windows are rolling; there is no absolute expiry, so the mandate's expiry lives in the Mandate contract only.

### Agent Wallet login is email one-time-password

- `circle wallet login <email> --testnet` authenticates with an emailed one-time code, not an API key. Each policy change sends a second code.
- Circle's quickstart warns not to give an AI agent access to the inbox: whoever reads the code can change the wallet's policies. In our design the customer enters the code; the agent never sees the inbox.

### CCTP V2 Fast Transfer into Arc testnet

- The supported-chains page lists Fast Transfer sources by mainnet name and says a mainnet's testnet is also supported; it does not name the Sepolia to Arc Testnet routes.
- Observed: `GET https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/0/26` and `/6/26` each return a `finalityThreshold: 1000` entry (0.25 bps and 0.325 bps when read), so the Fast route is offered from both Ethereum Sepolia and Base Sepolia. Fees are set by Circle and are fetched before each burn, never hardcoded.
- The technical guide is not consistent on `minFinalityThreshold` clamping (one passage: above 1000 is treated as 2000; another: above 2000 is treated as 2000). We only ever send 1000 or 2000.

### Arc: USDC has two decimal views

- USDC is Arc's gas token. The native balance uses 18 decimals; the ERC-20 interface at `0x3600000000000000000000000000000000000000` uses 6. A zero `balanceOf` does not imply a zero native balance. The router uses the ERC-20 interface for amounts and never mixes it with `msg.value`.
  Source: https://docs.arc.io/arc/references/evm-differences

### USYC Teller on Arc testnet

- The Arc contract-addresses page gives the Teller address and says to "call the USYC Teller contract" to mint or redeem, without an ABI. The only documented Teller ABI (`deposit(uint256,address)`, `redeem(uint256,address,address)`) is for Ethereum Sepolia.
  Sources: https://docs.arc.io/arc/references/contract-addresses and https://developers.circle.com/tokenized/usyc/subscribe-and-redeem
- Observed by read-only calls on Arc testnet: the Teller answers `asset()` (Arc USDC), `share()` (the USYC token), `authority()` (the Entitlements contract), `oracle()` and `mintPrice()` (an 18-decimal price). Whether `deposit` and `redeem` have the Sepolia signatures on Arc is still to be confirmed once an address is allowlisted.

### Gateway

- `POST /v1/balances` returns a `pendingBatch` field per domain alongside `balance`. The router sums `balance` only.
- Gateway's testnet API and contracts need no API key. The wallet and minter addresses are the same on every testnet and are also returned by `GET /v1/info`, which `pnpm verify:chains` checks.
- The CLI's contract-allowlist example uses the mainnet GatewayWallet address; the testnet address is different.

### CCTP V1

- V1 deprecation began 31 Oct 2026 and completes 1 Dec 2026. Nothing here uses V1.
  Source: https://developers.circle.com/cctp/migration-from-v1-to-v2

### Tooling

- pnpm 12 ships `bin/pnpm.mjs`; Corepack 0.33 looks for `bin/pnpm.cjs` and fails to launch it. `packageManager` is pinned to pnpm 10 for that reason.
