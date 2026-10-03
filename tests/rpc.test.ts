import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createPublicClient } from 'viem';
import { rpcTransport } from '../src/rpc.js';

for (const scenario of ['recover', 'exhaust', 'business-error'] as const) {
    test(`RPC ${scenario}: retries only rate limits with a bounded budget`, async (t) => {
        let calls = 0;
        const server = createServer(async (request, response) => {
            let raw = '';
            for await (const chunk of request) raw += chunk.toString();
            const body = JSON.parse(raw) as { id: number };
            calls++;
            response.setHeader('content-type', 'application/json');
            const success = scenario === 'recover' && calls === 2;
            response.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: body.id,
                    ...(success
                        ? { result: '0x2105' }
                        : {
                              error: {
                                  code: -32016,
                                  message: scenario === 'business-error' ? 'execution denied' : 'over rate limit'
                              }
                          })
                })
            );
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        t.after(
            () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        );
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const client = createPublicClient({
            transport: rpcTransport(`http://127.0.0.1:${address.port}`)
        });
        if (scenario === 'recover') assert.equal(await client.getChainId(), 8453);
        else await assert.rejects(client.getChainId());
        assert.equal(calls, scenario === 'recover' ? 2 : scenario === 'exhaust' ? 4 : 1);
    });
}
