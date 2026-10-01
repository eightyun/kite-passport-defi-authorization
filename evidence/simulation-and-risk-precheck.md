# Simulation and risk precheck report

Generated from Base mainnet transaction vectors. Each RPC simulation replays the call at the block immediately before the observed transaction.

| Fixture | Protocol | Parsed operation | Transaction | Policy | Historical RPC simulation |
|---|---|---|---|---|---|
| moonwell-redeem-cash-rejection.base.json | moonwell | withdraw | 0x83fe375c66d58489f8b1f8917ec7b61f812a41a79567d9d3b75ee911efde1311 | reject | expected protocol rejection (14) |
| moonwell-redeem-mtokens.base.json | moonwell | withdraw | 0x4cad47b6aad60765ab73444797d8a5804147e9a0c0a4d209586a04b37cc516be | pass | pass |
| moonwell-supply-usdc.base.json | moonwell | supply | 0x5aab6990eae508c972c1db9cf04cb2e2dd97c8ed3aa9c1e409e1c07ea3784c73 | pass | pass |
| moonwell-withdraw-usdc.base.json | moonwell | withdraw | 0x169f9aded536ee0df26f87af015f60a16d19d0004cb794c60a06cd4daf03c690 | pass | pass |
| uniswap-permit2-usdc.base.json | uniswap | v3 exact-input | 0x264113c7264f36e1029f24d1ced8461dbdd92975663fd1338a8378aed254238c | reject | pass |
| uniswap-v3-exact-input.base.json | uniswap | v3 exact-input | 0x4ae30763adbc67dda8b268123961950390996252a8dade837358b5a35af7224c | pass | pass |
| uniswap-v4-exact-input.base.json | uniswap | v4 exact-input | 0x05365bdae052690a649ccb3499c41dc029f4aed119dbf76a30abbc42dfef6e28 | pass | pass |

## Enforced controls

- Only configured chains, targets, tokens and recipients are accepted.
- Token and native-value limits are checked before execution.
- Expired or excessively distant deadlines are rejected.
- Exact-input swaps with zero minimum output are rejected.
- Unknown Universal Router commands and v4 actions are rejected.
- Universal Router allow-revert commands are rejected by the authorization policy.
- Non-zero Uniswap v4 hooks and dynamic-fee pools are rejected unless explicitly enabled.
- Moonwell borrowing is denied by the example policy.
- Failed RPC simulation is a rejection.

## Balance-change interpretation

- Exact calldata bounds are reported as exact, minimum or maximum amounts.
- Moonwell amounts identify the calldata asset. Policy caps always compare underlying units after conversion at a fixed, accrued exchange rate.
- Moonwell receipt balances, underlying-valued supplied positions, debt and collateral membership/exposure are reported before and conditionally after execution. Missing verified state requires review.
- Mint and redeemUnderlying receipt calculations use floor rounding, matching the contract; max-uint sentinels apply only to redemption and repayment. Protocol return codes are checked for market and controller calls.
- Uniswap outputs are minimum guarantees; realized output still depends on pool state.

## Moonwell fixed-block exposure evidence

All values are raw token units. Receipt quantities use mToken decimals; underlying and debt quantities use the underlying token decimals. These are conditional predictions valued at the checked accrued rate, not measured post-transaction balances.

| Fixture | Underlying amount | Receipt amount | Receipt balance before → after | Debt before → after | Collateral underlying before → after | Executability |
|---|---|---|---|---|---|---|
| moonwell-redeem-cash-rejection.base.json | 79 | 329344 | 1111467744208 → 1111467414864 | 0 → 0 | 266612295 → 266612216 | not executable |
| moonwell-redeem-mtokens.base.json | 100 | 418133 | 418133 → 0 | 0 → 0 | 0 → 0 | simulation passed |
| moonwell-supply-usdc.base.json | 58413 | 243552516 | 0 → 243552516 | 0 → 0 | 0 → 0 | simulation passed |
| moonwell-withdraw-usdc.base.json | 58413 | 243552509 | 243552514 → 5 | 0 → 0 | 0 → 0 | simulation passed |

## Limitations

- The cash-rejection vector is marked successful by the explorer at EVM level, but preceding-block simulation returns Moonwell error 14 (insufficient cash). It is intentionally rejected; its conditional exposure calculation must not be interpreted as executed movement. Explorer status alone is not protocol-success evidence.
- Moonwell support is limited to registered Base USDC/WETH markets. Fee-on-transfer and rebasing assets are outside this registry. Supplied/collateral valuation holds the checked accrued exchange rate fixed; post-operation rounding may change the eventual exchange rate. USD valuation and portfolio-wide liquidation health are not inferred.
- PermitSingle and PermitBatch signatures are independently checked using the Permit2 EIP-712 domain. EOA signatures support 65-byte and EIP-2098 encodings; contract wallets use EIP-1271 at the checked block.
- All four Router Permit2 commands are decoded. Nonce and explicit-transfer allowance consumption are checked in command order, with full-transaction simulation required for chain-state-dependent execution.
- The real Permit2 vector has a valid signature and successful historical execution. The default policy rejects its unlimited allowance and approximately 30-day authorization lifetime. This is an expected rejection, not a failed signature check.
- Allowance updates describe the authorization assigned by a permit and the maximum exposure change relative to the checked allowance. They are conditional on execution and are not the final residual allowance after swaps.
- Balance changes are operation-level calldata bounds, not a measured net portfolio delta. Exact swap output, token balances and ERC-20 approval sufficiency depend on the simulated chain state.
- Direct Permit2 SignatureTransfer/witness calls and nested Router subplans are outside the supported command set and fail closed. EIP-1271 coverage uses controlled RPC tests; the committed live Permit2 transaction is an EOA vector.
- All chain reads and simulation use a fixed block number; matching block hashes are required before policy pass. Historical preflight uses the preceding block, so transactions depending on earlier writes in the same block may fail this replay.
- Arbitrary Uniswap v4 hooks are outside the supported trust boundary.
- RPC simulation verifies call success at a fixed historical state; it does not guarantee execution against a later state.
- This project does not sign or broadcast transactions and is not production risk control without an independent audit.
