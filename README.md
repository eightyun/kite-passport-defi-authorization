# Kite Passport DeFi Authorization

An auditable TypeScript authorization layer for decoding DeFi calldata, evaluating transaction policy, simulating execution, and reporting expected balance changes before a Kite Passport agent submits a transaction.

It supports Uniswap, Aerodrome, Moonwell, Morpho, Aave V3, Compound III and Avantis/Veranta on Base and never signs or broadcasts transactions.

All committed tests, real transaction vectors and historical simulations currently target Base mainnet only (chain ID `8453`). No other network is claimed as tested or supported by this repository.

## Supported protocols

| Protocol           | Supported operations                                                                    |
| ------------------ | --------------------------------------------------------------------------------------- |
| Uniswap v2         | exact-input and exact-output swaps through Universal Router                             |
| Uniswap v3         | single-hop and multi-hop exact-input/exact-output swaps                                 |
| Uniswap v4         | standard exact-input/exact-output swaps, settlement and take actions                    |
| Universal Router   | nested sub-plans, Permit2 permits/transfers, wrap, unwrap, sweep and transfer           |
| Permit2            | direct single/batch witness transfers with signature and unordered-nonce verification   |
| Aerodrome Router   | token/token, native/token and token/native exact-input swaps                            |
| Moonwell Core      | supply, withdraw, borrow, repay and collateral enable/disable                           |
| Morpho Blue        | supply, withdraw, borrow, repay and collateral supply/withdraw                          |
| Aave V3 Pool       | supply, withdraw, variable-rate borrow/repay and collateral enable/disable              |
| Compound III Comet | base supply/withdraw/borrow/repay, collateral supply/withdraw and manager authorization |
| Avantis/Veranta v2 | open/close/increase, margin and limit updates, and signed global TP/SL updates          |

Uniswap v4 hooks and dynamic-fee pools are rejected by the example policy unless explicitly allowed. Unknown commands and actions are always rejected.

## Authorization pipeline

```text
transaction envelope
        │
        ▼
target and protocol adapter
        │
        ▼
normalized intent and expected balance changes
        │
        ▼
policy evaluation ──────────► reject with exact reason code
        │
        ▼
historical or latest-state RPC simulation
        │
        ▼
pass / review / reject report
```

The output format is versioned by [`schemas/authorization-report.schema.json`](schemas/authorization-report.schema.json).

## Install and verify

Requirements: Node.js 20 or newer.

```bash
npm ci
npm run check
npm test
npm run build
```

The test suite covers real calldata vectors, protocol operation decoding, thirty-nine documented policy rejection paths and additional Permit2 signature, allowance and policy rejection cases.

## Analyze a transaction

```bash
npx tsx src/cli.ts analyze \
  --transaction fixtures/transactions/uniswap-v4-exact-input.base.json \
  --policy config/policy.example.json \
  --rpc-url https://mainnet.base.org
```

The command emits JSON containing:

- normalized protocol intent;
- decoded token route, amount bounds, recipient and deadline;
- expected asset, receipt-token and debt changes;
- policy decision and machine-readable reason codes;
- RPC simulation result;
- source transaction provenance when supplied.
- Permit2 signature verification, checked allowances and expected authorization exposure changes when applicable.
- Moonwell resolved underlying/receipt amounts and account-level supplied, debt and collateral exposures at the checked block.
- Morpho fixed-block market identity, exact simulated asset/share amounts and account exposure changes.
- Aave fixed-block reserve configuration, aToken and variable-debt exposure, cap checks and projected health factor.
- Compound III fixed-block base and collateral exposure, permissions, cap checks and projected collateralization.
- Avantis v2 EIP-712 signer recovery, unordered nonce status, delegation expiry and same-block simulation.
- an integrity receipt containing the analyzer version, policy hash, report hash, transaction fingerprint and exact valid block.

Exit code `2` means the policy rejected the transaction. Invalid input or an internal error returns exit code `1`.

## Verify a report receipt

```bash
npx tsx src/cli.ts verify-report \
  --report evidence/reports/uniswap-v4-exact-input.report.json \
  --policy config/policy.example.json \
  --block 51999748
```

The verifier recomputes the canonical report and policy hashes, checks the transaction fingerprint and policy outcome, and requires the requested block to match the report's fixed simulation block. Omit `--block` to verify integrity without asserting a use-time block. The receipt proves report integrity against the supplied policy; it is not a publisher signature. See [authorization receipts](docs/receipts.md).

## Policy controls

[`config/policy.example.json`](config/policy.example.json) demonstrates:

- allowed chain IDs and target contracts;
- token and recipient allowlists;
- per-token and native-value limits;
- maximum deadline horizon;
- Uniswap v4 hook and dynamic-fee controls;
- Aerodrome factory allowlist;
- Morpho market-ID allowlist and canonical market verification;
- Aave reserve allowlist, borrow control and minimum projected health factor;
- Compound III asset and manager allowlists, borrow control, amount limits and fixed-block collateral checks;
- Avantis pair allowlist, open-position switch, leverage and slippage limits;
- Moonwell borrowing control;
- optional mandatory RPC simulation.
- Permit2 signature and allowance lifetime limits; Permit2 always requires independent verification and full-transaction simulation at the same block.
- Permit2 witness type-hash allowlist; unknown application-defined witness semantics fail closed.

Implemented rejection reason codes include:

| Code                                  | Condition                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `UNSUPPORTED_CHAIN`                   | chain is outside the policy                                                      |
| `UNAUTHORIZED_TARGET`                 | target contract is not allowed                                                   |
| `UNKNOWN_ACTION`                      | selector, router command or v4 action is unsupported                             |
| `UNAPPROVED_TOKEN`                    | a route or lending asset is not allowed                                          |
| `UNAPPROVED_RECIPIENT`                | funds would be sent to an unapproved address                                     |
| `AMOUNT_LIMIT_EXCEEDED`               | input or lending amount exceeds its token cap                                    |
| `NATIVE_VALUE_LIMIT_EXCEEDED`         | transaction value exceeds the native-token cap                                   |
| `DEADLINE_EXPIRED`                    | deadline is in the past                                                          |
| `DEADLINE_TOO_FAR`                    | deadline exceeds the permitted horizon                                           |
| `ZERO_MINIMUM_OUTPUT`                 | exact-input swap lacks output protection                                         |
| `V4_HOOK_NOT_ALLOWED`                 | v4 pool uses an unapproved hook                                                  |
| `DYNAMIC_V4_FEE_NOT_ALLOWED`          | v4 dynamic fee is disabled                                                       |
| `BORROW_NOT_ALLOWED`                  | lending borrow is disabled                                                       |
| `AERODROME_FACTORY_NOT_ALLOWED`       | route uses an unapproved Aerodrome factory                                       |
| `MORPHO_MARKET_NOT_ALLOWED`           | Morpho market ID is not explicitly allowed                                       |
| `MORPHO_CALLBACK_NOT_ALLOWED`         | supply or repay callback data is non-empty                                       |
| `MORPHO_STATE_REQUIRED`               | verified Morpho position state or matching simulation is missing                 |
| `MORPHO_PRECHECK_FAILED`              | market identity, delegation or expected position change is invalid               |
| `AAVE_STATE_REQUIRED`                 | matching Aave fixed-block state and simulation evidence is missing               |
| `AAVE_PRECHECK_FAILED`                | Pool identity or projected account state is invalid                              |
| `AAVE_RESERVE_NOT_ALLOWED`            | reserve is outside the configured Aave allowlist                                 |
| `AAVE_RESERVE_INACTIVE`               | reserve is inactive                                                              |
| `AAVE_RESERVE_PAUSED`                 | reserve is paused                                                                |
| `AAVE_RESERVE_FROZEN`                 | reserve is frozen for new supply or borrowing                                    |
| `AAVE_BORROWING_DISABLED`             | reserve does not permit borrowing                                                |
| `AAVE_COLLATERAL_DISABLED`            | reserve does not permit collateral usage                                         |
| `AAVE_SUPPLY_CAP_EXCEEDED`            | projected reserve supply exceeds its cap                                         |
| `AAVE_BORROW_CAP_EXCEEDED`            | projected reserve debt exceeds its cap                                           |
| `AAVE_ACCOUNT_MISMATCH`               | calldata beneficiary conflicts with verified account state                       |
| `AAVE_INTEREST_RATE_MODE_NOT_ALLOWED` | debt operation is not variable-rate mode `2`                                     |
| `AAVE_EMODE_NOT_SUPPORTED`            | collateral-changing operation targets an eMode account                           |
| `AAVE_HEALTH_FACTOR_TOO_LOW`          | projected health factor is below policy                                          |
| `COMPOUND_STATE_REQUIRED`             | matching Compound fixed-block state and simulation evidence is missing           |
| `COMPOUND_PRECHECK_FAILED`            | Compound state or projected account change is invalid                            |
| `COMPOUND_MARKET_MISMATCH`            | target market is not the canonical Base USDC Comet                               |
| `COMPOUND_ASSET_NOT_ALLOWED`          | base or collateral asset is outside the configured allowlist                     |
| `COMPOUND_SUPPLY_PAUSED`              | market supply is paused                                                          |
| `COMPOUND_WITHDRAW_PAUSED`            | market withdrawal is paused                                                      |
| `COMPOUND_SUPPLY_CAP_EXCEEDED`        | projected collateral total exceeds the market cap                                |
| `COMPOUND_OPERATOR_NOT_ALLOWED`       | delegated source operation lacks account permission                              |
| `COMPOUND_MANAGER_NOT_ALLOWED`        | manager grant targets an unapproved address                                      |
| `COMPOUND_SIGNATURE_INVALID`          | manager authorization signature is invalid                                       |
| `COMPOUND_NONCE_MISMATCH`             | signed manager authorization nonce does not match chain state                    |
| `COMPOUND_SIGNATURE_EXPIRED`          | signed manager authorization has expired                                         |
| `COMPOUND_BORROW_TOO_SMALL`           | projected nonzero base debt is below the market minimum                          |
| `COMPOUND_NOT_COLLATERALIZED`         | projected base debt exceeds verified borrow capacity                             |
| `AVANTIS_STATE_REQUIRED`              | signed intent verification or same-block simulation is missing                   |
| `AVANTIS_PRECHECK_FAILED`             | signed intent preflight is invalid                                               |
| `AVANTIS_PAIR_NOT_ALLOWED`            | pair index is outside the configured allowlist                                   |
| `AVANTIS_SIGNATURE_INVALID`           | EIP-712 signature or encoded intent is invalid                                   |
| `AVANTIS_NONCE_USED`                  | unordered intent nonce is already consumed                                       |
| `AVANTIS_DELEGATION_INVALID`          | recovered signer lacks an active trader delegation                               |
| `AVANTIS_OPEN_NOT_ALLOWED`            | policy disables new positions                                                    |
| `AVANTIS_LEVERAGE_LIMIT_EXCEEDED`     | requested leverage exceeds policy                                                |
| `AVANTIS_SLIPPAGE_LIMIT_EXCEEDED`     | requested slippage exceeds policy                                                |
| `UNVERIFIED_AUTHORIZATION`            | Permit2 details were not independently verified                                  |
| `PERMIT2_SIGNATURE_INVALID`           | EOA signature or EIP-1271 result is invalid                                      |
| `PERMIT2_SPENDER_NOT_ALLOWED`         | signed spender differs from the approved Router                                  |
| `PERMIT2_OWNER_MISMATCH`              | transfer owner differs from the Router sender                                    |
| `PERMIT2_SIGNATURE_EXPIRED`           | signature deadline has passed                                                    |
| `PERMIT2_SIGNATURE_DEADLINE_TOO_FAR`  | signature validity exceeds the configured horizon                                |
| `PERMIT2_ALLOWANCE_EXPIRED`           | allowance is expired                                                             |
| `PERMIT2_EXPIRATION_TOO_FAR`          | allowance lifetime exceeds the configured horizon                                |
| `PERMIT2_NONCE_MISMATCH`              | signed nonce is already used or incorrect                                        |
| `PERMIT2_ALLOWANCE_INSUFFICIENT`      | explicit transfers exceed remaining allowance                                    |
| `PERMIT2_LIMIT_MISSING`               | token has no explicit authorization amount cap                                   |
| `PERMIT2_STATE_UNAVAILABLE`           | required chain or contract state could not be verified                           |
| `PERMIT2_EMPTY_BATCH`                 | a permit or transfer batch has no entries                                        |
| `PERMIT2_WITNESS_TYPE_NOT_ALLOWED`    | a direct witness transfer uses an unapproved witness type                        |
| `MOONWELL_STATE_REQUIRED`             | review required because verified account state or matching simulation is missing |
| `MOONWELL_PRECHECK_FAILED`            | redemption exceeds receipts or repayment exceeds accrued debt                    |
| `SIMULATION_FAILED`                   | pre-execution RPC call reverted or failed                                        |

## Real transaction vectors

The repository includes 47 raw Base mainnet transaction envelopes with immutable explorer provenance. A transaction can prove several decoded actions.

| Protocol                     | Real-vector coverage                                                                                                                                                                               | Vector count |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------: |
| Uniswap and Universal Router | v2/v3/v4 exact input and output, single-hop and multi-hop routes, native-input and native-output v4 swaps, v4 settle/take/sweep, Permit2 single permit/transfer, Router wrap/unwrap/sweep/transfer |           13 |
| Aerodrome                    | token-to-token, native-to-token and token-to-native exact-input swaps                                                                                                                              |            3 |
| Moonwell                     | supply, underlying withdrawal, receipt redemption, borrow, direct repay, repay on behalf, collateral enable/disable and a protocol-level rejection                                                 |            9 |
| Morpho                       | supply, withdraw, borrow, repay and collateral supply/withdraw                                                                                                                                     |            6 |
| Aave V3                      | supply, withdraw, variable-rate borrow, variable-rate repay and collateral enable/disable                                                                                                          |            6 |
| Compound III                 | base supply, base withdrawal, base borrow, base repayment, collateral supply/withdraw and manager authorization                                                                                    |            7 |
| Avantis/Veranta v2           | delegated EIP-712 market open, market close and coin-exposure position increase                                                                                                                    |            3 |

[`fixtures/operation-coverage.json`](fixtures/operation-coverage.json) maps every operation to its fixture and records the expected policy and historical simulation outcomes. Uniswap v4 native-currency swaps are represented directly by the zero address and have real vectors in both directions; they do not require wrapping. Permit2 batch permit/transfer, direct witness transfer, Universal Router sub-plans, signed Avantis TP/SL updates and the separate v4 action-level WRAP/UNWRAP commands have deterministic executable test vectors. They are not presented as observed Base transactions because no matching transaction is included in the repository's provenance sample.

Each evidence simulation replays the call against the block immediately before the observed transaction. Set `BASE_RPC_URL` to an archive-capable Base endpoint when regenerating evidence.

```bash
npm run evidence
```

Moonwell always requires verified fixed-block account state and matching successful simulation before `pass`, even when general simulation is optional. [Moonwell units and exposure verification](docs/moonwell.md) documents amount conversions, rounding, error codes and offline behavior.

Morpho requires canonical market/account state and a matching successful fixed-block simulation before `pass`. [Morpho exposure verification](docs/morpho.md) documents this boundary. [Aerodrome authorization scope](docs/aerodrome.md) documents supported selectors and factory controls.

Aave requires canonical reserve/account state and a matching successful fixed-block simulation before `pass`. [Aave V3 authorization and exposure verification](docs/aave.md) documents supported calls, cap checks, projected health and failure boundaries.

Compound III requires canonical Comet market/account state and a matching successful fixed-block simulation before `pass`. [Compound III authorization and exposure verification](docs/compound.md) documents base-token netting, collateral capacity, manager signatures and failure boundaries.

Signed Avantis v2 operations require signature recovery, an unused bitmap nonce, an active delegation when applicable and a matching successful fixed-block simulation. [Avantis v2 authorization](docs/avantis.md) documents units, supported calls and failure boundaries.

The committed acceptance package is available in [`evidence`](evidence/README.md).

The Permit2 permit vector has a valid EOA signature, a matching historical nonce and a successful historical simulation. Its unlimited allowance and approximately 30-day lifetime exceed the example policy, so the expected decision is `reject`. A separate real vector verifies an explicit Permit2 transfer against historical allowance state. [Permit2 verification and evidence](docs/permit2.md) explains how to reproduce these results.

## Acceptance evidence

| Requirement                                   | Evidence                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Correct intent parsing for main operations    | adapter tests and generated reports                                                                                  |
| Real transaction test vectors                 | `fixtures/transactions/*.json` with explorer hashes                                                                  |
| Per-operation vector coverage                 | `fixtures/operation-coverage.json`                                                                                   |
| At least eight rejection paths                | thirty-nine cases in `evidence/rejection-tests.json`                                                                 |
| Exact rejection reasons                       | policy findings include code, message and supporting fields                                                          |
| Expected result and balance changes           | `expectedBalanceChanges`, Permit2 allowance exposure, fixed-block lending exposures and Avantis authorization checks |
| Transaction calldata                          | included in each fixture and generated report                                                                        |
| Policy configuration                          | `config/policy.example.json`                                                                                         |
| Simulation and risk precheck                  | `evidence/simulation-and-risk-precheck.md`                                                                           |
| Permit2 signatures and authorization exposure | `evidence/reports/uniswap-permit2-usdc.report.json`                                                                  |
| Recorded automated assertions                 | `evidence/test-results.tap`                                                                                          |

## Project layout

```text
src/
  adapters/       protocol-specific calldata decoders
  decode.ts       target-to-adapter dispatch
  policy.ts       deterministic authorization decisions
  simulation.ts   read-only RPC preflight
  moonwell.ts     accrued rate, account state and exposure verification
  morpho.ts       market identity, account state and exposure verification
  aave.ts         reserve, account, cap and health-factor verification
  compound.ts     Comet market, account, permission and collateral verification
  avantis.ts      EIP-712 signature, unordered nonce and delegation verification
  permit2.ts      Permit2 decoding, signatures and allowance verification
  report.ts       versioned authorization report
  cli.ts          command-line interface
fixtures/         real Base mainnet transaction vectors
tests/            protocol and policy behavior tests
evidence/         committed acceptance evidence
schemas/          report contract
```

## Security boundary

- The tested network scope is limited to Base mainnet (chain ID `8453`); contract addresses, protocol behavior and evidence must be independently validated before use on another network.
- The tool performs read-only analysis and RPC calls.
- It does not hold private keys, sign messages, submit transactions or approve spending.
- Permit2 PermitSingle and PermitBatch signatures are independently verified; contract-wallet checks require an EIP-1271 RPC response. Missing verification fails closed.
- Permit2 witness transfers verify the official EIP-712 hash, EOA/EIP-1271 signature, unordered nonce bitmap, requested amounts and an explicit witness-type policy allowlist.
- Explicit Permit2 transfers are checked against allowances in command order. Full-transaction simulation covers implicit swap payments, ERC-20 approvals and token balances.
- Authorization exposure and per-operation balance bounds are conditional predictions; the tool does not claim measured net balance or final residual allowance changes.
- Unknown Uniswap v4 hooks are rejected because hook code can alter fees and asset flows.
- Aerodrome routes are restricted to approved factories and protected exact-input methods.
- Moonwell health, liquidity, caps, interest and exchange rates remain state-dependent.
- Morpho markets are restricted by their full parameter hash; exact share conversions require same-block simulation.
- Aave operations require the canonical Base Pool, explicit reserve approval, fixed-block reserve/account checks and same-block simulation.
- Compound III operations require the canonical Base USDC Comet, explicit asset and manager approval, fixed-block account/collateral checks and same-block simulation.
- Avantis signed intents, including global TP/SL updates, are bound to the v2 domain, nonce bitmap, delegation state and simulation block. The current TP/SL flow is submitted through the official price-trigger API and executed on chain by the operator.
- A simulation is evidence for one chain state, not a guarantee for later execution.

This project has not received an external security audit and must not be treated as production risk control without one.

## References

- [Kite Passport skills](https://github.com/gokite-ai/passport-skills)
- [Uniswap Universal Router commands](https://developers.uniswap.org/docs/protocols/universal-router/concepts/commands)
- [Uniswap Universal Router source](https://github.com/Uniswap/universal-router)
- [Moonwell contracts](https://docs.moonwell.fi/moonwell/protocol-information/contracts)
- [Moonwell Core integration](https://docs.moonwell.fi/moonwell/developers/guides)
- [Aerodrome contracts](https://github.com/aerodrome-finance/contracts)
- [Morpho Blue contracts](https://github.com/morpho-org/morpho-blue)
- [Aave V3 Pool](https://aave.com/docs/aave-v3/smart-contracts/pool)
- [Aave Base address book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Base.sol)
- [Compound III documentation](https://docs.compound.finance/)
- [Compound III Comet contracts](https://github.com/compound-finance/comet)
- [Avantis/Veranta trader SDK](https://github.com/Avantis-Labs/avantis_trader_sdk)

## License

[MIT](LICENSE)
