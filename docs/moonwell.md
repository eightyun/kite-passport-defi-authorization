# Moonwell amount and exposure verification

The adapter supports the registered Base mUSDC and mWETH markets and their Comptroller. It preserves the original calldata amount and records `amountAsset` to distinguish underlying token units from receipt-token units.

## Amount semantics

| Method                                                       | Calldata unit | Interpretation                                                |
| ------------------------------------------------------------ | ------------- | ------------------------------------------------------------- |
| `mint(amount)`                                               | underlying    | exact deposit; max uint is an exact number                    |
| `redeem(tokens)`                                             | mToken        | exact receipt burn; max uint redeems the full receipt balance |
| `redeemUnderlying(amount)`                                   | underlying    | exact withdrawal; max uint redeems the full receipt balance   |
| `borrow(amount)`                                             | underlying    | exact new borrowing; max uint is an exact number              |
| `repayBorrow(amount)` / `repayBorrowBehalf(account, amount)` | underlying    | exact repayment; max uint resolves to accrued debt            |
| `enterMarkets(markets)` / `exitMarket(market)`               | none          | collateral membership changes without token movement          |

At one fixed block, read-only calls to `exchangeRateCurrent()` and `borrowBalanceCurrent(account)` accrue interest inside `eth_call`. No transaction is signed or broadcast. The verifier also checks receipt balance, underlying address, Comptroller address and collateral membership. It checks the block hash again before returning evidence.

For accrued exchange rate `R` and scale `S = 10^18`, all arithmetic uses integer raw units:

- Minted receipts: `floor(underlying * S / R)`.
- Underlying redeemed from receipt quantity: `floor(receipts * R / S)`.
- Receipts burned by an exact underlying withdrawal: `floor(underlying * S / R)`.
- Supplied position value: `floor(receiptBalance * R / S)`.

Decimal differences are already incorporated into the contract's exchange rate. Applying another decimal adjustment would be incorrect. Repayment above accrued debt and redemption above available receipt balance are rejected; amounts are not silently clamped.

## Policy and simulation

Per-token lending limits compare the resolved **underlying amount**, never the numeric mToken amount. Resolution and successful full-transaction simulation must have the same transaction fingerprint, block number and block hash. Direct policy evaluation uses the same resolution path as report generation.

Missing or mismatched state returns `review` with `MOONWELL_STATE_REQUIRED`, even when general simulation is optional. An invalid balance precheck returns `MOONWELL_PRECHECK_FAILED`. A revert, nonzero market/exit error code, nonzero entry in the `enterMarkets` error array, or malformed result returns `SIMULATION_FAILED`. A successful EVM call alone is insufficient.

This tightens previous offline behavior: callers that previously received `pass` for Moonwell without an RPC now receive `review`. Existing report fields remain; `moonwell`, `amountAsset`, `underlyingAmount` and `receiptAmount` are additive fields. The incorrect `redeem().amount.mode = "maximum"` is corrected to `"exact"` for ordinary receipt quantities. Consumers must use `amountAsset` or the resolved `underlyingAmount`, rather than assuming every lending calldata amount is denominated in underlying tokens.

RPC reads use bounded exponential retries. The Base public endpoint's nonstandard `-32016` rate-limit error is normalized for retry only when its message explicitly identifies rate limiting; other errors retain their rejection behavior. Retry exhaustion still prevents authorization.

## Expected exposure

`moonwell.exposures` identifies the market and affected account and reports:

- original-state accrued exchange rate;
- resolved underlying and receipt amounts;
- receipt balance and underlying-valued supplied position before/after;
- accrued debt before/after;
- collateral membership and underlying-valued collateral before/after.

For repayment on behalf, the sender pays and the designated borrower's debt decreases. Borrowing enrolls the borrower in the market as collateral, as the Comptroller requires. Enter/exit operations change collateral exposure without claiming asset transfers.

These are conditional predictions assuming the simulated operation succeeds. Supplied and collateral valuations hold the checked accrued exchange rate fixed. Transaction rounding may change the subsequent rate. The report does not claim observed post-transaction balances, USD exposure, or portfolio-wide health factors. The registered standard USDC/WETH assets are assumed; arbitrary fee-on-transfer or rebasing markets are unsupported.

## Reproduce

```bash
npx tsx --test tests/moonwell.test.ts
npx tsx src/cli.ts analyze \
  --transaction fixtures/transactions/moonwell-redeem-mtokens.base.json \
  --policy config/policy.example.json \
  --rpc-url https://mainnet.base.org
npm run evidence
```

A separate [cash-rejection fixture](../fixtures/transactions/moonwell-redeem-cash-rejection.base.json) records a transaction marked successful at EVM level whose preceding-block simulation returns protocol error 14. Its expected authorization is `reject`; calculated exposure does not imply that the failed call moves assets.

The real redemption fixture retains its unchanged calldata and explorer provenance. Its report is in [the evidence directory](../evidence/reports/moonwell-redeem-mtokens.report.json). Deterministic RPC tests separately cover rounding, all sentinels, repayment/borrow accounts, membership, state binding and error codes; those tests are not presented as live transactions.

Contract reference: [Moonwell MToken implementation](https://github.com/moonwell-fi/moonwell-contracts-v2/blob/main/src/MToken.sol) and [Comptroller implementation](https://github.com/moonwell-fi/moonwell-contracts-v2/blob/main/src/Comptroller.sol). This project requires independent security review before production risk-control use.
