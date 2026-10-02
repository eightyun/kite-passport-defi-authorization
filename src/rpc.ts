import { custom, http, LimitExceededRpcError, RpcRequestError } from "viem";

export function rpcTransport(url: string) {
  const upstream = http(url, { retryCount: 0, timeout: 15_000 })({});
  return custom(
    {
      async request(args) {
        try {
          return await upstream.request(args);
        } catch (error) {
          // Some Base RPC providers use non-standard rate-limit codes; retry only explicit throttling errors.
          if (
            error instanceof RpcRequestError &&
            error.code === -32016 &&
            /rate[ -]?limit/i.test(error.details ?? "")
          ) {
            throw new LimitExceededRpcError(
              new Error("RPC provider rate limit exceeded (-32016)."),
            );
          }
          throw error;
        }
      },
    },
    { retryCount: 3, retryDelay: 1000 },
  );
}
