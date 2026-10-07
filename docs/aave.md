# Aave V3 authorization and exposure verification

The adapter supports direct calls to the canonical Aave V3 Pool on Base mainnet for:

- supply and withdraw;
- variable-rate borrow and repay;
- collateral enable and disable.

The tested scope is Base mainnet only (chain ID `8453`). Flash loans, liquidation, stable-rate debt, credit delegation, permit helpers, external adapters and collateral-changing operations for eMode accounts are unsupported and fail closed.

## Canonical contracts

The verifier reads the Pool from the Base PoolAddressesProvider at the checked block and requires it to equal the configured Pool address. Reserve and account state is read through the canonical ProtocolDataProvider and Pool, while reserve prices come from the Aave Oracle.

| Contract              | Base address                                 |
| --------------------- | -------------------------------------------- |
| PoolAddressesProvider | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` |
| Pool                  | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| ProtocolDataProvider  | `0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A` |
| Oracle                | `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156` |

## Fixed-block checks

Before policy evaluation, the tool reads all required state at one fixed block and replays the complete transaction at the same block. The report binds the preflight and simulation to the transaction fingerprint, block number and block hash.

The preflight verifies:

- canonical Pool identity;
- reserve active, frozen and paused flags;
- collateral and borrowing configuration;
- supply and borrow caps;
- aToken and variable-debt token addresses;
- beneficiary scaled/current aToken, scaled/current variable debt and collateral state;
- account collateral, debt, available borrowing power and health factor;
- the reserve oracle price and user eMode category.

Only variable-rate debt mode `2` is accepted. Max-uint withdraw and repay amounts are resolved from the checked aToken or variable-debt balance before policy limits are applied.

## Exposure projection

The report records the account and reserve state before execution and conditionally projects:

- underlying asset movement;
- aToken balance movement;
- variable-debt movement;
- collateral membership;
- total collateral and debt in Aave base-currency units;
- projected health factor using Aave's `1e18` health-factor scale.

The projection uses integer arithmetic, normalized liquidity and variable-borrow indexes, and the reserve liquidation threshold read at the checked block. It applies Pool revision 11 floor/ceiling rules to aToken mint/burn and variable-debt mint/burn. A first supply automatically enables collateral when the reserve has nonzero LTV, matching the deployed Pool behavior for the supported non-eMode path. Full-transaction simulation is still required before a transaction can pass.

These values are conditional predictions for one block state. They are not measured post-transaction balances and do not guarantee execution at a later block.

## Policy controls

`allowedAaveReserves` restricts the underlying reserve addresses. `minimumAaveHealthFactor` sets the minimum projected health factor as a raw `1e18` fixed-point integer. Existing token amount limits, recipient allowlists, target allowlists and `allowBorrow` also apply.

Invalid or unavailable Aave state never produces a pass. It returns a precise Aave reason code or `AAVE_STATE_REQUIRED` when matching fixed-block evidence is absent.

## Evidence

Six real Base transactions cover supply, withdraw, variable-rate borrow, variable-rate repay and collateral enable/disable. Their calldata and explorer provenance are stored in `fixtures/transactions`, and generated fixed-block reports are stored in `evidence/reports`.

```bash
npx tsx --test tests/aave.test.ts
npm run evidence
```

## References

- [Aave V3 Pool interface](https://aave.com/docs/aave-v3/smart-contracts/pool)
- [Aave Base address book](https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Base.sol)
