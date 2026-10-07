# Compound III authorization and exposure verification

The Compound adapter supports direct calls to the canonical Base USDC Comet market at `0xb125E6687d4313864e53df431d5425969c15Eb2F`. The committed evidence and tests target Base mainnet only (chain ID `8453`).

## Supported calls

| Comet method                             | Authorization interpretation                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `supply`, `supplyTo`, `supplyFrom`       | Supply collateral, repay base debt, supply base USDC, or repay debt and supply the remainder                    |
| `withdraw`, `withdrawTo`, `withdrawFrom` | Withdraw collateral, withdraw supplied base USDC, borrow base USDC, or withdraw supply and borrow the remainder |
| `allow`                                  | Enable or disable an approved manager                                                                           |
| `allowBySig`                             | Enable or disable an approved manager after EIP-712 signer, nonce and expiry verification                       |

Compound III uses one signed base balance per account. A positive base position represents supplied USDC and a negative base position represents borrowed USDC. The adapter therefore reads the account at the simulation block before classifying a base-token call. For example, `supply(USDC, amount)` repays existing debt first and supplies only the excess; `withdraw(USDC, amount)` consumes supplied USDC first and borrows only the excess.

## Fixed-block checks

Before a Compound action can pass, the tool reads and records the following state at the same block used for full transaction simulation:

- canonical market base token, scale, price feed and borrow minimum;
- supply and withdrawal pause state;
- account base supply and borrow balances;
- every listed collateral asset, oracle price, account balance, market total, supply cap and collateral factors;
- operator permission for `supplyFrom` and `withdrawFrom`;
- manager authorization and nonce for manager updates;
- the block number, block hash and timestamp.

The preflight projects base supply, base debt, selected collateral balance, collateral market total, borrow capacity and liquidation capacity. It rejects operations that exceed a collateral cap, leave debt below the market minimum, or leave projected debt above borrow capacity. A changed block hash, missing state or mismatched simulation block prevents authorization.

## Manager signatures

`allowBySig` is checked against the Comet `Authorization` EIP-712 type and domain read from the market. The recovered signer must be the owner encoded in calldata, the nonce must match `userNonce(owner)`, and the expiry must be later than the checked block timestamp. Enabling a manager also requires that manager to appear in `allowedCompoundManagers`.

## Policy controls

The example policy provides:

- `allowedCompoundAssets` for base and collateral assets;
- `allowedCompoundManagers` for manager grants;
- `maximumAmountByToken` limits applied after base-token semantic resolution;
- `allowBorrow`, which rejects projected Compound borrowing when disabled;
- target, token, recipient and simulation controls shared with the other adapters.

Rejections include a stable reason code and message for market mismatch, pause state, asset or manager allowlist failure, collateral cap overflow, missing operator permission, invalid manager signatures, nonce or expiry failure, minimum borrow violation and insufficient collateralization.

## Evidence and trust boundary

Seven successful Base transactions cover base supply, base withdrawal, base borrow, base repayment, collateral supply, collateral withdrawal and manager authorization. Reports under `evidence/reports` retain calldata, transaction provenance, fixed-block exposure, policy findings and historical simulation results.

The adapter deliberately supports direct Comet calls only. Bulker batches, Comet transfers, liquidation, absorption, reserve purchases and unknown selectors fail closed. The tool does not sign, submit or approve transactions. Its projected balances are conditional on execution at the checked state and do not replace an independent production security audit.

## Primary references

- [Compound III protocol documentation](https://docs.compound.finance/)
- [Compound III Comet repository](https://github.com/compound-finance/comet)
- [Official Base USDC deployment](https://github.com/compound-finance/comet/tree/main/deployments/base/usdc)
