# Authorization report receipts

Every generated report includes an integrity receipt with:

- analyzer package name and version;
- canonical policy hash;
- canonical report payload hash;
- transaction fingerprint;
- exact simulation block and block hash when fixed-block RPC evidence is present.

The valid block range is intentionally one block. Protocol state, balances, allowances, nonces and prices can change in the next block, so the analyzer does not claim a wider validity period.

Verify a committed report with the same normalized policy:

```bash
npx tsx src/cli.ts verify-report \
  --report evidence/reports/uniswap-v4-exact-input.report.json \
  --policy config/policy.example.json \
  --block 51999748
```

Verification fails if the report payload, policy, transaction, final decision, analyzer version, simulation block or block hash changes. A report produced without fixed-block simulation can be integrity-checked without `--block`, but cannot be verified for a requested block.

The receipt is a deterministic integrity record. It does not contain a publisher signature and therefore does not prove who ran the analyzer. A deployment that needs issuer authenticity must sign or externally anchor the receipt hash with its own audited key-management process.
