# Avantis/Veranta v2 authorization

The adapter recognizes the current Avantis/Veranta v2 TradingRouter on Base at `0x44914408af82bC9983bbb330e3578E1105e11d4e`. Reports retain the protocol name `avantis` so the authorization surface remains stable across the public product rename.

## Supported operations

- direct and signed market open;
- direct and signed market close;
- direct and signed position-size increase;
- direct margin update;
- direct open-limit update and cancellation.

Signed calls support the v2 USDC-sized and coin-exposure intent variants used by `executeMarketOrderBatched` and `executePositionUpdateBatched`. Keeper-only execution, TP/SL, TWAP, RFQ, referral and delegation-mutation calls fail closed as unknown actions.

## Signed-intent verification

The verifier reconstructs the exact `AvantisTrading` EIP-712 domain and typed message from calldata. At the block immediately before the observed transaction it:

1. recovers the signer from the submitted signature;
2. checks the signer's unordered `nonceBitmap` word and bit;
3. accepts a signer different from the trader only when `multipleDelegations(trader, signer)` is enabled and unexpired;
4. checks the millisecond deadline against the block timestamp;
5. binds these reads to the same block hash as the full transaction simulation.

Any signature, nonce or delegation failure rejects the transaction. Missing RPC state produces `review`, never `pass`.

## Units and expected changes

- USDC collateral uses 1e6 units.
- prices, leverage, slippage and coin exposure use 1e10 fixed-point units.
- intent deadlines are Unix milliseconds; delegation expiry is Unix seconds.
- opening and position-increase collateral are exact calldata debits.
- close proceeds are reported as unknown before execution because oracle fill, PnL and fees determine the final USDC credit.

Policy can restrict pair indexes, opening, leverage, slippage, USDC collateral and native transaction value. The example policy allows pairs 0 and 1, caps leverage at 50x and slippage at 3%.

## Evidence

Three successful Base mainnet transactions cover signed USDC market open, USDC market close and coin-exposure position increase. Generated reports preserve the calldata, recovered signer, EIP-712 digest, nonce state, delegation expiry, simulation block and policy result.

The adapter is a pre-execution authorization aid. It does not calculate liquidation health, oracle quality, realized PnL or guarantee execution against a later block. It has not received an external security audit.
