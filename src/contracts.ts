import type { Address } from "./domain.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const MSG_SENDER_RECIPIENT = "0x0000000000000000000000000000000000000001" as Address;
export const ROUTER_RECIPIENT = "0x0000000000000000000000000000000000000002" as Address;

export const BASE_CHAIN_ID = 8453;
export const BASE_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

export const BASE_UNISWAP_UNIVERSAL_ROUTER =
  "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40" as Address;

export const BASE_AERODROME_ROUTER =
  "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address;
export const BASE_AERODROME_POOL_FACTORY =
  "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address;
export const BASE_AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631" as Address;

export const BASE_MORPHO =
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as Address;

export interface MoonwellMarket {
  readonly market: Address;
  readonly underlying: Address;
  readonly symbol: string;
  readonly receiptSymbol: string;
}

export const BASE_MOONWELL_COMPTROLLER =
  "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C" as Address;

export const BASE_MOONWELL_MARKETS: readonly MoonwellMarket[] = [
  {
    market: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
    underlying: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    receiptSymbol: "mUSDC",
  },
  {
    market: "0x628ff693426583D9a7FB391E54366292F509D457",
    underlying: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    receiptSymbol: "mWETH",
  },
] as const;

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
export const BASE_USDBC = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca" as Address;
export const BASE_WETH = "0x4200000000000000000000000000000000000006" as Address;

export function findMoonwellMarket(address: Address): MoonwellMarket | undefined {
  const normalized = address.toLowerCase();
  return BASE_MOONWELL_MARKETS.find((market) => market.market.toLowerCase() === normalized);
}
