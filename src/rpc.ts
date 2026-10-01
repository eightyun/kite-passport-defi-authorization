import { custom, http, LimitExceededRpcError, RpcRequestError } from "viem";

export function rpcTransport(url: string) {
  const upstream = http(url, { retryCount: 0, timeout: 15_000 })({});
  return custom(
    {
      async request(args) {
        try {
          return await upstream.request(args);
        } catch (error) {
          // 部分 Base RPC 使用非标准限流码；只将明确的限流错误映射为可退避重试的错误。
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
