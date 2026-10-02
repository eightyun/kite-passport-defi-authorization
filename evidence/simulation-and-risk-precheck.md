# Simulation and risk precheck report

Generated from Base mainnet transaction vectors. Each RPC simulation replays the call at the block immediately before the observed transaction.

| Fixture | Protocol | Parsed operation | Transaction | Policy | Historical RPC simulation |
|---|---|---|---|---|---|
| aerodrome-native-to-token.base.json | aerodrome | aerodrome-native-to-token | 0x7428694f963a813ffec6fbff8c1c412985bba9bf388fd2262e7dc4e88ba9ce4c | reject | pass |
| aerodrome-swap-usdc-aero.base.json | aerodrome | aerodrome-token-to-token | 0x4ae4c26c79314c635cde20f42371ef5621ec2f543281508a3d84665eff0b3a81 | pass | pass |
| aerodrome-token-to-native.base.json | aerodrome | aerodrome-token-to-native | 0x81e4244c39b24e142355e197a709a88ee7dd84a77539fb8b9b7bba3739c7d2fc | reject | pass |
| moonwell-borrow-usdc.base.json | moonwell | moonwell-borrow | 0x5eec6902b6f43617cacff4c4c78ad9853ad33860978d176bd4dfb89cb1816575 | reject | pass |
| moonwell-disable-collateral.base.json | moonwell | moonwell-disable-collateral | 0xfa41cb14ff31739c4ba213a29d956408efb4f49a5794497d042c871bc25f8e57 | pass | pass |
| moonwell-enable-collateral.base.json | moonwell | moonwell-enable-collateral | 0x3ffebe8b41bf8d40b5bf8faa7d82ce16ba7a677eae49c9f4772f821442005549 | pass | pass |
| moonwell-redeem-cash-rejection.base.json | moonwell | moonwell-redeem-protocol-rejection | 0x83fe375c66d58489f8b1f8917ec7b61f812a41a79567d9d3b75ee911efde1311 | reject | expected protocol rejection (14) |
| moonwell-redeem-mtokens.base.json | moonwell | moonwell-redeem-receipts | 0x4cad47b6aad60765ab73444797d8a5804147e9a0c0a4d209586a04b37cc516be | pass | pass |
| moonwell-repay-on-behalf-usdc.base.json | moonwell | moonwell-repay-on-behalf | 0x2bea773f811cde503301ddffb620a9c847a75bc15ac2749b87aa23352d402de1 | reject | pass |
| moonwell-repay-usdc.base.json | moonwell | moonwell-repay | 0x3abd0a6b5c62d480018f5574271d0211e1af180455f2791595950d52ca2004cc | pass | pass |
| moonwell-supply-usdc.base.json | moonwell | moonwell-supply | 0x5aab6990eae508c972c1db9cf04cb2e2dd97c8ed3aa9c1e409e1c07ea3784c73 | pass | pass |
| moonwell-withdraw-usdc.base.json | moonwell | moonwell-withdraw-underlying | 0x169f9aded536ee0df26f87af015f60a16d19d0004cb794c60a06cd4daf03c690 | pass | pass |
| morpho-borrow-usdc.base.json | morpho | morpho-borrow | 0x0db10dd594fa19fda8d024feaf226d3f2e11c537b5fef7f32298f0b091b2fb94 | reject | pass |
| morpho-repay-usdc.base.json | morpho | morpho-repay | 0xd84c249552ff34dc2af15e63858473415b5098dee37ec3b84ab608792d15ca2d | pass | pass |
| morpho-supply-collateral-weth.base.json | morpho | morpho-supply-collateral | 0x00ea59a177daa71470146ca641ecb2ec0a4af0663b8739cb2d36d2e837350b8e | pass | pass |
| morpho-supply-usdc.base.json | morpho | morpho-supply | 0xac1c679de0a782d61de0a0d8d047921158b01d1be19bfb8e48fc0870f40dbcb6 | pass | pass |
| morpho-withdraw-collateral-weth.base.json | morpho | morpho-withdraw-collateral | 0x893208373a743f260a60bf7ab409f4ce79f41d597ec6fcd20da78835497d1eb9 | pass | pass |
| morpho-withdraw-usdc.base.json | morpho | morpho-withdraw | 0xb1b19cb25cda86b015f50efe8b6991b9f5e34db981eafb9ff3f90b7d5b2cee33 | pass | pass |
| uniswap-permit2-transfer.base.json | uniswap | permit2-single-transfer | 0x112820be97fd5cbd253d7774a39d8db8f7ee128de15c18c79913e58bc1723753 | reject | pass |
| uniswap-permit2-usdc.base.json | uniswap | permit2-single-permit | 0x264113c7264f36e1029f24d1ced8461dbdd92975663fd1338a8378aed254238c | reject | pass |
| uniswap-router-transfer.base.json | uniswap | universal-router-transfer, universal-router-wrap | 0xb67e08f2bb63a6ecbdd0900159381580e32ecbfd96f47e2cf4b3c622f77c5106 | reject | pass |
| uniswap-v2-exact-input-single.base.json | uniswap | uniswap-v2-exact-input-single, universal-router-unwrap | 0xc31836d1054bf7028109a6dbe13e89a938c65f3232583d08b938bf85b79b0764 | reject | pass |
| uniswap-v2-exact-output-single.base.json | uniswap | uniswap-v2-exact-output-single, universal-router-wrap, universal-router-sweep, universal-router-unwrap | 0xff964689c5fdac04dc6fa584635ff6eb77619b63f57f49bb7b6cfe2357bce27a | pass | pass |
| uniswap-v3-exact-input-single.base.json | uniswap | uniswap-v3-exact-input-single, universal-router-wrap | 0xb593a6a8346db61bd1d91fd10fecaeaeb694af12adc2eb55832003b2d9f632ab | pass | pass |
| uniswap-v3-exact-input.base.json | uniswap | uniswap-v3-exact-input-multihop | 0x4ae30763adbc67dda8b268123961950390996252a8dade837358b5a35af7224c | pass | pass |
| uniswap-v3-exact-output-single-multihop.base.json | uniswap | uniswap-v3-exact-output-single, uniswap-v3-exact-output-multihop, universal-router-wrap, universal-router-unwrap | 0x846797907326f4de54c5c829f1d30008d666b7246079449aeb1786a3aafb89c4 | pass | pass |
| uniswap-v4-exact-input-multihop.base.json | uniswap | uniswap-v4-exact-input-multihop, uniswap-v4-settle, uniswap-v4-take | 0x1b0fa17a11b3af83549e255ba5d8a2b202b022b03cf9fa99f1b71348cd7da7d4 | reject | pass |
| uniswap-v4-exact-input.base.json | uniswap | uniswap-v4-exact-input-single, uniswap-v4-native-input, uniswap-v4-settle, uniswap-v4-take | 0x05365bdae052690a649ccb3499c41dc029f4aed119dbf76a30abbc42dfef6e28 | pass | pass |
| uniswap-v4-exact-output-multihop.base.json | uniswap | uniswap-v4-exact-output-multihop, uniswap-v4-settle, uniswap-v4-take | 0x910314f070ebdab4d4dfe593fe53a4ed23918d13f4d8eb7bbe81b02347895a9b | reject | pass |
| uniswap-v4-exact-output-single.base.json | uniswap | uniswap-v4-exact-output-single, uniswap-v4-native-input, uniswap-v4-settle, uniswap-v4-take, uniswap-v4-sweep | 0x6b5a13a439a2c59dfc388980305159b849147a216d33c3fd091eb827c068654c | pass | pass |
| uniswap-v4-native-output.base.json | uniswap | uniswap-v4-exact-input-single, uniswap-v4-native-output, uniswap-v4-settle, uniswap-v4-take | 0x5e9b223330444ba31a1dd820d069caa823c993b9144333f58db66f6db0210ab4 | pass | pass |

## Enforced controls

- Only configured chains, targets, tokens and recipients are accepted.
- Token and native-value limits are checked before execution.
- Expired or excessively distant deadlines are rejected.
- Exact-input swaps with zero minimum output are rejected.
- Unknown Universal Router commands and v4 actions are rejected.
- Universal Router allow-revert commands are rejected by the authorization policy.
- Non-zero Uniswap v4 hooks and dynamic-fee pools are rejected unless explicitly enabled.
- Aerodrome routes must use configured factories; unsafe and fee-on-transfer selectors fail closed.
- Moonwell borrowing is denied by the example policy.
- Morpho markets must match an explicit market-ID allowlist and verified canonical parameters.
- Failed RPC simulation is a rejection.

## Operation coverage

The machine-readable coverage manifest is [fixtures/operation-coverage.json](../fixtures/operation-coverage.json). It maps every committed Base transaction to the operations it proves and records the expected policy and simulation outcomes. Operations without an observed top-level transaction remain explicitly identified as deterministic-only coverage:

- permit2-batch-permit: No matching top-level call to the registered Base Universal Router is included in the observed transaction sample. Test: `tests/permit2.test.ts`.
- permit2-batch-transfer: No matching top-level call to the registered Base Universal Router is included in the observed transaction sample. Test: `tests/permit2.test.ts`.
- uniswap-v4-explicit-wrap-unwrap-actions: Native-input and native-output swaps have real vectors, but no matching v4 action-level WRAP or UNWRAP command is included in the observed transaction sample. Test: `tests/operations.test.ts`.

## Balance-change interpretation

- Exact calldata bounds are reported as exact, minimum or maximum amounts.
- Moonwell amounts identify the calldata asset. Policy caps always compare underlying units after conversion at a fixed, accrued exchange rate.
- Moonwell receipt balances, underlying-valued supplied positions, debt and collateral membership/exposure are reported before and conditionally after execution. Missing verified state requires review.
- Mint and redeemUnderlying receipt calculations use floor rounding, matching the contract; max-uint sentinels apply only to redemption and repayment. Protocol return codes are checked for market and controller calls.
- Uniswap outputs are minimum guarantees; realized output still depends on pool state.
- Morpho share-denominated amounts are resolved from the successful fixed-block call return data before policy caps are applied.

## Moonwell fixed-block exposure evidence

All values are raw token units. Receipt quantities use mToken decimals; underlying and debt quantities use the underlying token decimals. These are conditional predictions valued at the checked accrued rate, not measured post-transaction balances.

| Fixture | Underlying amount | Receipt amount | Receipt balance before → after | Debt before → after | Collateral underlying before → after | Executability |
|---|---|---|---|---|---|---|
| moonwell-borrow-usdc.base.json | 24000000000 | 0 | 0 → 0 | 576231934730 → 600231934730 | 0 → 0 | simulation passed |
| moonwell-disable-collateral.base.json | 0 | 0 | 49714860 → 49714860 | 0 → 0 | 0 → 0 | simulation passed |
| moonwell-enable-collateral.base.json | 0 | 0 | 0 → 0 | 0 → 0 | 0 → 0 | simulation passed |
| moonwell-redeem-cash-rejection.base.json | 79 | 329344 | 1111467744208 → 1111467414864 | 0 → 0 | 266612295 → 266612216 | not executable |
| moonwell-redeem-mtokens.base.json | 100 | 418133 | 418133 → 0 | 0 → 0 | 0 → 0 | simulation passed |
| moonwell-repay-on-behalf-usdc.base.json | 1203072701 | 0 | 0 → 0 | 2163328387802 → 2162125315101 | 0 → 0 | simulation passed |
| moonwell-repay-usdc.base.json | 18170723 | 0 | 0 → 0 | 935435111 → 917264388 | 0 → 0 | simulation passed |
| moonwell-supply-usdc.base.json | 58413 | 243552516 | 0 → 243552516 | 0 → 0 | 0 → 0 | simulation passed |
| moonwell-withdraw-usdc.base.json | 58413 | 243552509 | 243552514 → 5 | 0 → 0 | 0 → 0 | simulation passed |

## Morpho fixed-block exposure evidence

The exact asset/share result comes from the historical call. Position shares and collateral are read immediately before that call at the same block and reported as conditional before/after values.

| Fixture | Operation | Assets | Shares | Supply shares before → after | Borrow shares before → after | Collateral before → after |
|---|---|---|---|---|---|---|
| morpho-borrow-usdc.base.json | borrow | 1000000 | 881421948202 | 0 → 0 | 0 → 881421948202 | 1200000000000000 → 1200000000000000 |
| morpho-repay-usdc.base.json | repay | 1000000000 | 881389147223115 | 0 → 0 | 2779190797260197 → 1897801650037082 | 6250000000000000000 → 6250000000000000000 |
| morpho-supply-collateral-weth.base.json | supply-collateral | 1200000000000000 | 0 | 0 → 0 | 0 → 0 | 0 → 1200000000000000 |
| morpho-supply-usdc.base.json | supply | 500000 | 447469270447 | 0 → 447469270447 | 0 → 0 | 0 → 0 |
| morpho-withdraw-collateral-weth.base.json | withdraw-collateral | 1200000000000000 | 0 | 0 → 0 | 0 → 0 | 1200000000000000 → 0 |
| morpho-withdraw-usdc.base.json | withdraw | 50000 | 44746841279 | 447469269212 → 402722427933 | 0 → 0 | 0 → 0 |

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
- Aerodrome support covers the three standard exact-input methods. Fee-on-transfer and unsafe methods are deliberately unsupported.
- Morpho liquidation, flash loans and authorization mutation are outside the supported operation set. Market totals are recorded as stored at the checked block; operation asset/share deltas come from full call simulation after Morpho interest accrual.
- RPC simulation verifies call success at a fixed historical state; it does not guarantee execution against a later state.
- This project does not sign or broadcast transactions and is not production risk control without an independent audit.
