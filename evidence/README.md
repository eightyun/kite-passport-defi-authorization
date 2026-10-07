# Acceptance evidence

This directory contains reproducible evidence for the Passport DeFi authorization acceptance criteria.

## Evidence map

- Real transaction calldata: [../fixtures/transactions](../fixtures/transactions)
- Operation-to-vector coverage and expected outcomes: [../fixtures/operation-coverage.json](../fixtures/operation-coverage.json)
- Parsed intent, expected balance changes, policy decision and RPC result: [reports](./reports)
- Policy configuration: [../config/policy.example.json](../config/policy.example.json)
- Thirty-nine explicit rejection paths: [rejection-tests.json](./rejection-tests.json)
- Simulation and risk precheck: [simulation-and-risk-precheck.md](./simulation-and-risk-precheck.md)
- Automated assertions: [../tests](../tests)
- Recorded assertion results, including Permit2 rejection paths: [test-results.tap](./test-results.tap)
- Moonwell units, conversion rules and exposure interpretation: [../docs/moonwell.md](../docs/moonwell.md)
- Permit2 scope and reproducible real-transaction audit: [../docs/permit2.md](../docs/permit2.md)
- Aerodrome selectors, routing and failure boundaries: [../docs/aerodrome.md](../docs/aerodrome.md)
- Morpho market identity and exposure verification: [../docs/morpho.md](../docs/morpho.md)
- Avantis v2 intent and delegation verification: [../docs/avantis.md](../docs/avantis.md)
- Aave V3 reserve, account and health-factor verification: [../docs/aave.md](../docs/aave.md)
- Compound III market, account and collateralization verification: [../docs/compound.md](../docs/compound.md)
- Report policy hash, analyzer version, valid block and verification command: [../docs/receipts.md](../docs/receipts.md)

## Reproduce

```bash
npm ci
npm run check
npm test
npm run evidence
```

Set `BASE_RPC_URL` to an archive-capable Base RPC endpoint if the public endpoint is unavailable.
