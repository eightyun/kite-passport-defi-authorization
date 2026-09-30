# Simulation and risk precheck report

Generated from Base mainnet transaction vectors. Each RPC simulation replays the call at the block immediately before the observed transaction.

| Fixture | Protocol | Parsed operation | Transaction | Policy | Historical RPC simulation |
|---|---|---|---|---|---|
| moonwell-supply-usdc.base.json | moonwell | supply | 0x5aab6990eae508c972c1db9cf04cb2e2dd97c8ed3aa9c1e409e1c07ea3784c73 | pass | pass |
| moonwell-withdraw-usdc.base.json | moonwell | withdraw | 0x169f9aded536ee0df26f87af015f60a16d19d0004cb794c60a06cd4daf03c690 | pass | pass |
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
- Moonwell mToken mint/burn amounts are marked unknown because the exchange rate is state-dependent.
- Uniswap outputs are minimum guarantees; realized output still depends on pool state.

## Limitations

- Permit2 commands are recognized, but the tool does not independently verify EIP-712 signatures.
- Arbitrary Uniswap v4 hooks are outside the supported trust boundary.
- RPC simulation verifies call success at a fixed historical state; it does not guarantee execution against a later state.
- This project does not sign or broadcast transactions and is not production risk control without an independent audit.
