import type { Address } from "./domain.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const MSG_SENDER_RECIPIENT = "0x0000000000000000000000000000000000000001" as Address;
export const ROUTER_RECIPIENT = "0x0000000000000000000000000000000000000002" as Address;

export const BASE_CHAIN_ID = 8453;

export const BASE_UNISWAP_UNIVERSAL_ROUTER =
  "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40" as Address;

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
