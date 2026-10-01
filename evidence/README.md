# Acceptance evidence

This directory contains reproducible evidence for the Passport DeFi authorization acceptance criteria.

## Evidence map

- Real transaction calldata: [../fixtures/transactions](../fixtures/transactions)
- Parsed intent, expected balance changes, policy decision and RPC result: [reports](./reports)
- Policy configuration: [../config/policy.example.json](../config/policy.example.json)
- Fifteen explicit rejection paths: [rejection-tests.json](./rejection-tests.json)
- Simulation and risk precheck: [simulation-and-risk-precheck.md](./simulation-and-risk-precheck.md)
- Automated assertions: [../tests](../tests)
- Recorded assertion results, including Permit2 rejection paths: [test-results.tap](./test-results.tap)
- Moonwell units, conversion rules and exposure interpretation: [../docs/moonwell.md](../docs/moonwell.md)
- Permit2 scope and reproducible real-transaction audit: [../docs/permit2.md](../docs/permit2.md)

## Reproduce

```bash
npm ci
npm run check
npm test
npm run evidence
```

Set `BASE_RPC_URL` to an archive-capable Base RPC endpoint if the public endpoint is unavailable.
