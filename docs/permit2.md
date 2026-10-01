# Permit2 verification

The Base Universal Router adapter decodes all four Permit2 AllowanceTransfer commands:

| Command | Decoded intent |
|---|---|
| 0x0a PERMIT2_PERMIT | owner, token, amount, expiration, nonce, spender, signature deadline and signature |
| 0x03 PERMIT2_PERMIT_BATCH | the same authorization fields for every token in the batch |
| 0x02 PERMIT2_TRANSFER_FROM | token, owner, resolved recipient and amount |
| 0x0d PERMIT2_TRANSFER_FROM_BATCH | every literal owner, recipient, token and amount |

Single transfers resolve the Router's sender/router recipient placeholders. Batch transfers preserve literal addresses, matching the deployed command behavior. Every transfer owner must equal the Router sender.

## Verification and policy

1. Confirm the RPC chain ID, Base Router target and Permit2 deployment.
2. Pin reads to a block number and record its hash and timestamp.
3. Reconstruct the Permit2 EIP-712 digest using the domain name, chain ID and Permit2 address. There is no domain version field.
4. Inspect owner code at that block. Recover EOA signatures, including EIP-2098 compact signatures; for a contract owner, call EIP-1271 with Permit2 as caller and require the correct magic value.
5. Check the signed nonce against AllowanceTransfer state. Apply preceding explicit permit and transfer commands in order, including nonce increments and finite allowance consumption.
6. Enforce sender, spender, token, recipient, amount, expiration and signature-deadline policies. Explicit transfer amounts accumulate across the entire transaction.
7. Simulate the entire Router transaction against the same block. This checks chain execution including implicit swap payments, balances, ERC-20 approvals and interactions between commands.
8. Require matching verification/simulation fingerprints and block hashes before allowing a transaction.

The command does not sign or broadcast transactions. RPC failure, unverified authorization or a failed simulation cannot produce a policy pass.

## Authorization exposure

Each permit includes its authorized amount and expiration. The verification report records the checked allowance and an expected allowance update:

- beforeAmount: allowance amount observed on chain or resulting from preceding explicit commands;
- authorizedAmount: amount assigned by the permit, not added to the old allowance;
- maximumExposureChange: new authorized amount minus the previous unexpired allowance;
- expiration: effective expiration, including Permit2's zero-expiration convention.

These are conditional authorization changes. Subsequent swaps can consume allowance, so these fields do not claim the final residual allowance. The explicit-command tracker does not calculate implicit swap consumption; the complete RPC simulation is required to validate that execution. Balance changes describe operation-level calldata bounds and must not be added indiscriminately as net portfolio changes.

## Default limits and compatibility

The example policy permits a maximum allowance lifetime of 86,400 seconds and a signature deadline horizon of 3,600 seconds. Each authorization token must have an explicit maximumAmountByToken entry. Unlimited grants exceed ordinary finite limits.

Older policy files remain readable. When omitted, maximumPermit2ExpirationSeconds defaults to 86,400 and maximumPermit2SignatureDeadlineSeconds defaults to maximumDeadlineSeconds.

The synchronous createAuthorizationReport API remains available. It rejects Permit2 when verified evidence is absent. Use analyzeTransaction or the CLI for RPC-backed verification; supplied verification/simulation objects in the synchronous API are trusted library inputs, not an externally authenticated attestation format.

## Reproduce the real transaction audit

The unmodified Base transaction is [0x264113c7264f36e1029f24d1ced8461dbdd92975663fd1338a8378aed254238c](https://base.blockscout.com/tx/0x264113c7264f36e1029f24d1ced8461dbdd92975663fd1338a8378aed254238c).

```bash
npm ci
npx tsx src/cli.ts analyze \
  --transaction fixtures/transactions/uniswap-permit2-usdc.base.json \
  --policy config/policy.example.json \
  --rpc-url https://mainnet.base.org \
  --now 1790835373
```

Expected result: valid EOA signature, nonce 0 matching historical allowance state, successful simulation at block 52023012, and policy reject with AMOUNT_LIMIT_EXCEEDED and PERMIT2_EXPIRATION_TOO_FAR. CLI exit code 2 is expected. The original transaction succeeded on chain; the stricter example policy rejects its unlimited allowance and approximately 30-day authorization.

```bash
npm run evidence
```

This regenerates the historical audit reports, general rejection evidence and TAP test results. Set BASE_RPC_URL for an archive-capable Base RPC endpoint if needed. Historical replay uses the previous block's state; dependencies on earlier transactions in the same block can cause replay failure.

## Coverage and boundaries

The real Permit2 vector proves EOA decoding, digest recovery, historical nonce checking and full-call replay. Deterministic tests additionally cover PermitBatch, EIP-2098, EIP-1271, explicit single/batch transfers, repeated nonces, expired authorizations, wrong spender, amount caps, unknown tokens, recipient/owner restrictions, missing RPC state and simulation failure.

EIP-1271 behavior is tested with a controlled RPC fixture; no live smart-wallet transaction is claimed. Direct SignatureTransfer/witness entrypoints and nested Router subplans are not supported. Unknown commands fail closed. External security auditing is still required before using this project as production risk control.

## Primary references

- [Universal Router Dispatcher](https://github.com/Uniswap/universal-router/blob/main/contracts/base/Dispatcher.sol)
- [Router Permit2 payments](https://github.com/Uniswap/universal-router/blob/main/contracts/modules/Permit2Payments.sol)
- [Permit2 AllowanceTransfer](https://github.com/Uniswap/permit2/blob/main/src/AllowanceTransfer.sol)
- [Permit2 EIP-712 domain](https://github.com/Uniswap/permit2/blob/main/src/EIP712.sol)
- [Permit2 signature verification](https://github.com/Uniswap/permit2/blob/main/src/libraries/SignatureVerification.sol)
- [Permit2 typed-data hashes](https://github.com/Uniswap/permit2/blob/main/src/libraries/PermitHash.sol)
