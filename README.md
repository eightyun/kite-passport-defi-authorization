# Kite Passport DeFi Authorization

An auditable TypeScript authorization layer for decoding DeFi calldata, evaluating transaction policy, simulating execution, and reporting expected balance changes before a Kite Passport agent submits a transaction.

It supports Uniswap and Moonwell on Base and never signs or broadcasts transactions.

## Supported protocols

| Protocol | Supported operations |
|---|---|
| Uniswap v2 | exact-input and exact-output swaps through Universal Router |
| Uniswap v3 | single-hop and multi-hop exact-input/exact-output swaps |
| Uniswap v4 | standard exact-input/exact-output swaps, settlement and take actions |
| Universal Router | Permit2 single/batch permits and transfers, wrap, unwrap, sweep and transfer |
| Moonwell Core | supply, withdraw, borrow, repay and collateral enable/disable |

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

The test suite covers real calldata vectors, protocol operation decoding, fifteen general policy rejection paths and additional Permit2 signature, allowance and policy rejection cases.

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

Exit code `2` means the policy rejected the transaction. Invalid input or an internal error returns exit code `1`.

## Policy controls

[`config/policy.example.json`](config/policy.example.json) demonstrates:

- allowed chain IDs and target contracts;
- token and recipient allowlists;
- per-token and native-value limits;
- maximum deadline horizon;
- Uniswap v4 hook and dynamic-fee controls;
- Moonwell borrowing control;
- optional mandatory RPC simulation.
- Permit2 signature and allowance lifetime limits; Permit2 always requires independent verification and full-transaction simulation at the same block.

Implemented rejection reason codes include:

| Code | Condition |
|---|---|
| `UNSUPPORTED_CHAIN` | chain is outside the policy |
| `UNAUTHORIZED_TARGET` | target contract is not allowed |
| `UNKNOWN_ACTION` | selector, router command or v4 action is unsupported |
| `UNAPPROVED_TOKEN` | a route or lending asset is not allowed |
| `UNAPPROVED_RECIPIENT` | funds would be sent to an unapproved address |
| `AMOUNT_LIMIT_EXCEEDED` | input or lending amount exceeds its token cap |
| `NATIVE_VALUE_LIMIT_EXCEEDED` | transaction value exceeds the native-token cap |
| `DEADLINE_EXPIRED` | deadline is in the past |
| `DEADLINE_TOO_FAR` | deadline exceeds the permitted horizon |
| `ZERO_MINIMUM_OUTPUT` | exact-input swap lacks output protection |
| `V4_HOOK_NOT_ALLOWED` | v4 pool uses an unapproved hook |
| `DYNAMIC_V4_FEE_NOT_ALLOWED` | v4 dynamic fee is disabled |
| `BORROW_NOT_ALLOWED` | Moonwell borrow is disabled |
| `UNVERIFIED_AUTHORIZATION` | Permit2 details were not independently verified |
| `PERMIT2_SIGNATURE_INVALID` | EOA signature or EIP-1271 result is invalid |
| `PERMIT2_SPENDER_NOT_ALLOWED` | signed spender differs from the approved Router |
| `PERMIT2_OWNER_MISMATCH` | transfer owner differs from the Router sender |
| `PERMIT2_SIGNATURE_EXPIRED` | signature deadline has passed |
| `PERMIT2_SIGNATURE_DEADLINE_TOO_FAR` | signature validity exceeds the configured horizon |
| `PERMIT2_ALLOWANCE_EXPIRED` | allowance is expired |
| `PERMIT2_EXPIRATION_TOO_FAR` | allowance lifetime exceeds the configured horizon |
| `PERMIT2_NONCE_MISMATCH` | signed nonce is already used or incorrect |
| `PERMIT2_ALLOWANCE_INSUFFICIENT` | explicit transfers exceed remaining allowance |
| `PERMIT2_LIMIT_MISSING` | token has no explicit authorization amount cap |
| `PERMIT2_STATE_UNAVAILABLE` | required chain or contract state could not be verified |
| `PERMIT2_EMPTY_BATCH` | a permit or transfer batch has no entries |
| `SIMULATION_FAILED` | pre-execution RPC call reverted or failed |

## Real transaction vectors

The repository includes raw Base mainnet calldata and immutable explorer provenance:

| Vector | Transaction |
|---|---|
| Uniswap v3 multi-hop exact input | [`0x4ae307…224c`](https://base.blockscout.com/tx/0x4ae30763adbc67dda8b268123961950390996252a8dade837358b5a35af7224c) |
| Uniswap v4 exact input and settlement | [`0x05365b…6e28`](https://base.blockscout.com/tx/0x05365bdae052690a649ccb3499c41dc029f4aed119dbf76a30abbc42dfef6e28) |
| Moonwell USDC supply | [`0x5aab69…4c73`](https://base.blockscout.com/tx/0x5aab6990eae508c972c1db9cf04cb2e2dd97c8ed3aa9c1e409e1c07ea3784c73) |
| Moonwell USDC withdraw | [`0x169f9a…c690`](https://base.blockscout.com/tx/0x169f9aded536ee0df26f87af015f60a16d19d0004cb794c60a06cd4daf03c690) |
| Permit2 USDC permit and Uniswap v3 swap | [`0x264113…4238c`](https://base.blockscout.com/tx/0x264113c7264f36e1029f24d1ced8461dbdd92975663fd1338a8378aed254238c) |

Each evidence simulation replays the call against the block immediately before the observed transaction. Set `BASE_RPC_URL` to an archive-capable Base endpoint when regenerating evidence.

```bash
npm run evidence
```

The committed acceptance package is available in [`evidence`](evidence/README.md).

The Permit2 vector has a valid EOA signature, a matching historical nonce and a successful historical simulation. Its unlimited allowance and approximately 30-day lifetime exceed the example policy, so the expected decision is `reject`. [Permit2 verification and evidence](docs/permit2.md) explains how to reproduce this result.

## Acceptance evidence

| Requirement | Evidence |
|---|---|
| Correct intent parsing for main operations | adapter tests and generated reports |
| Real transaction test vectors | `fixtures/transactions/*.json` with explorer hashes |
| At least eight rejection paths | fifteen cases in `evidence/rejection-tests.json` |
| Exact rejection reasons | policy findings include code, message and supporting fields |
| Expected result and balance changes | every report contains `expectedBalanceChanges` |
| Transaction calldata | included in each fixture and generated report |
| Policy configuration | `config/policy.example.json` |
| Simulation and risk precheck | `evidence/simulation-and-risk-precheck.md` |
| Permit2 signatures and authorization exposure | `evidence/reports/uniswap-permit2-usdc.report.json` |
| Recorded automated assertions | `evidence/test-results.tap` |

## Project layout

```text
src/
  adapters/       protocol-specific calldata decoders
  decode.ts       target-to-adapter dispatch
  policy.ts       deterministic authorization decisions
  simulation.ts   read-only RPC preflight
  permit2.ts      Permit2 decoding, signatures and allowance verification
  report.ts       versioned authorization report
  cli.ts          command-line interface
fixtures/         real Base mainnet transaction vectors
tests/            protocol and policy behavior tests
evidence/         committed acceptance evidence
schemas/          report contract
```

## Security boundary

- The tool performs read-only analysis and RPC calls.
- It does not hold private keys, sign messages, submit transactions or approve spending.
- Permit2 PermitSingle and PermitBatch signatures are independently verified; contract-wallet checks require an EIP-1271 RPC response. Missing verification fails closed.
- Explicit Permit2 transfers are checked against allowances in command order. Full-transaction simulation covers implicit swap payments, ERC-20 approvals and token balances.
- Authorization exposure and per-operation balance bounds are conditional predictions; the tool does not claim measured net balance or final residual allowance changes.
- Unknown Uniswap v4 hooks are rejected because hook code can alter fees and asset flows.
- Moonwell health, liquidity, caps, interest and exchange rates remain state-dependent.
- A simulation is evidence for one chain state, not a guarantee for later execution.

This project has not received an external security audit and must not be treated as production risk control without one.

## References

- [Kite Passport skills](https://github.com/gokite-ai/passport-skills)
- [Uniswap Universal Router commands](https://developers.uniswap.org/docs/protocols/universal-router/concepts/commands)
- [Uniswap Universal Router source](https://github.com/Uniswap/universal-router)
- [Moonwell contracts](https://docs.moonwell.fi/moonwell/protocol-information/contracts)
- [Moonwell Core integration](https://docs.moonwell.fi/moonwell/developers/guides)

## License

[MIT](LICENSE)
