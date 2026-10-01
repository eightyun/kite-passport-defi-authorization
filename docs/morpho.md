# Morpho authorization and exposure verification

The adapter supports the canonical Morpho Blue singleton on Base for:

- supply and withdraw;
- borrow and repay;
- collateral supply and withdrawal.

Liquidation, flash loans and authorization mutation are unsupported and fail closed. Supply and repay callback data must be empty because callback-controlled asset flows are outside the normalized intent.

## Market identity

Morpho markets do not have separate contract addresses. A market ID is the keccak256 hash of the ABI-encoded loan token, collateral token, oracle, interest-rate model and LLTV. Authorization requires both:

1. the computed ID to appear in `allowedMorphoMarkets`; and
2. `idToMarketParams(id)` at the checked block to exactly match the calldata tuple.

This prevents a permitted token pair from silently selecting a different oracle, rate model or LLTV.

## Fixed-block state and simulation

Before policy evaluation, the tool reads the beneficiary position, market totals and delegated authorization at one fixed block. The full transaction is then replayed at that same block. Matching transaction fingerprints, block numbers and block hashes are required.

For supply, withdraw, borrow and repay, Morpho returns the exact asset and share quantities after interest accrual and rounding. The report decodes these return values and applies them to the verified position shares. Collateral operations use their exact calldata amount. Policy caps are evaluated only after share-denominated operations have an exact simulated asset amount.

The report includes:

- supply shares before and conditionally after execution;
- borrow shares before and conditionally after execution;
- collateral units before and conditionally after execution;
- exact operation asset/share quantities;
- stored market totals at the checked block.

These values are conditional predictions for one historical chain state. They are not a USD valuation or a guarantee at a later block.

## References

- [Morpho Blue contracts](https://github.com/morpho-org/morpho-blue)
- [Morpho deployments](https://docs.morpho.org/get-started/resources/addresses/)
