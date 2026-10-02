# Aerodrome authorization scope

The adapter recognizes the canonical Aerodrome Router on Base and normalizes three standard exact-input methods:

- `swapExactTokensForTokens`
- `swapExactETHForTokens`
- `swapExactTokensForETH`

Each route hop records its input token, output token, stable-pool flag and factory. The policy requires every factory to appear in `allowedAerodromeFactories`, checks every route token, applies the input-token amount cap, validates the recipient and deadline, and rejects a zero minimum output.

Native input and output are reported as the zero address while the encoded route is required to begin or end with WETH. Aerodrome's zero recipient is normalized to the transaction sender.

`UNSAFE_swapExactTokensForTokens`, fee-on-transfer variants and unknown selectors fail closed. They are excluded because their execution or balance semantics do not provide the same pre-execution amount guarantees as the supported methods.

The three committed real transaction vectors cover token-to-token, native-to-token and token-to-native calls with original Base calldata and Blockscout provenance. Evidence generation replays each one against the block immediately before execution. The native vectors intentionally demonstrate policy rejection for tokens outside the example allowlist while retaining successful historical simulation evidence.

## References

- [Aerodrome contracts](https://github.com/aerodrome-finance/contracts)
- [Aerodrome Router interface](https://github.com/aerodrome-finance/contracts/blob/main/contracts/interfaces/IRouter.sol)
