import type { Address } from './domain.js';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
export const MSG_SENDER_RECIPIENT = '0x0000000000000000000000000000000000000001' as Address;
export const ROUTER_RECIPIENT = '0x0000000000000000000000000000000000000002' as Address;

export const BASE_CHAIN_ID = 8453;
export const BASE_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;

export const BASE_UNISWAP_UNIVERSAL_ROUTER = '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40' as Address;

export const BASE_AERODROME_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as Address;
export const BASE_AERODROME_POOL_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as Address;
export const BASE_AERO = '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as Address;

export const BASE_MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;

export const BASE_AAVE_POOL_ADDRESSES_PROVIDER = '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D' as Address;
export const BASE_AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address;
export const BASE_AAVE_PROTOCOL_DATA_PROVIDER = '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A' as Address;
export const BASE_AAVE_ORACLE = '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156' as Address;

export const BASE_COMPOUND_USDC_COMET = '0xb125E6687d4313864e53df431d5425969c15Eb2F' as Address;
export const BASE_COMPOUND_BULKER = '0x78D0677032A35c63D142a48A2037048871212a8C' as Address;
export const BASE_CBBTC = '0xcbb7C0000aB88B473b1f5AFd9ef808440EED33BF' as Address;

export const BASE_AVANTIS_TRADING_ROUTER = '0x44914408af82bC9983bbb330e3578E1105e11d4e' as Address;

export interface MoonwellMarket {
    readonly market: Address;
    readonly underlying: Address;
    readonly symbol: string;
    readonly receiptSymbol: string;
}

export const BASE_MOONWELL_COMPTROLLER = '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C' as Address;

export const BASE_MOONWELL_MARKETS: readonly MoonwellMarket[] = [
    {
        market: '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22',
        underlying: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        symbol: 'USDC',
        receiptSymbol: 'mUSDC'
    },
    {
        market: '0x628ff693426583D9a7FB391E54366292F509D457',
        underlying: '0x4200000000000000000000000000000000000006',
        symbol: 'WETH',
        receiptSymbol: 'mWETH'
    }
] as const;

export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
export const BASE_USDBC = '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca' as Address;
export const BASE_WETH = '0x4200000000000000000000000000000000000006' as Address;

export function findMoonwellMarket(address: Address): MoonwellMarket | undefined {
    const normalized = address.toLowerCase();
    return BASE_MOONWELL_MARKETS.find((market) => market.market.toLowerCase() === normalized);
}
