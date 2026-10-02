export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface TransactionSource {
  readonly name: string;
  readonly transactionHash: Hex;
  readonly explorerUrl: string;
  readonly blockNumber: number;
  readonly timestamp: string;
  readonly observedStatus: "success" | "failure";
}

export interface TransactionEnvelope {
  readonly chainId: number;
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: string;
  readonly source?: TransactionSource;
}

export interface Amount {
  readonly value: string;
  readonly mode: "exact" | "minimum" | "maximum" | "all" | "unknown";
}

export interface BalanceChange {
  readonly account: string;
  readonly asset: Address;
  readonly assetSymbol?: string;
  readonly category: "asset" | "receipt" | "debt";
  readonly direction: "credit" | "debit";
  readonly amount: Amount;
  readonly reason: string;
}

export interface SwapRouteStep {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly fee?: number;
  readonly tickSpacing?: number;
  readonly hook?: Address;
  readonly dynamicFee?: boolean;
  readonly stable?: boolean;
  readonly factory?: Address;
}

export interface SwapAction {
  readonly kind: "swap";
  readonly index: number;
  readonly protocolVersion: "v2" | "v3" | "v4" | "aerodrome";
  readonly mode: "exact-input" | "exact-output";
  readonly recipient: string;
  readonly payerIsUser: boolean;
  readonly route: readonly SwapRouteStep[];
  readonly amountIn: Amount;
  readonly amountOut: Amount;
  readonly inputAsset?: Address;
  readonly outputAsset?: Address;
}

export interface MorphoMarketParams {
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly oracle: Address;
  readonly irm: Address;
  readonly lltv: string;
}

export interface MorphoAction {
  readonly kind: "morpho";
  readonly index: number;
  readonly operation:
    | "supply"
    | "withdraw"
    | "borrow"
    | "repay"
    | "supply-collateral"
    | "withdraw-collateral";
  readonly marketId: Hex;
  readonly marketParams: MorphoMarketParams;
  readonly beneficiary: Address;
  readonly receiver?: Address;
  readonly assets: Amount;
  readonly shares?: Amount;
  readonly callbackData: Hex;
}

export interface LendingAction {
  readonly kind: "lending";
  readonly index: number;
  readonly operation:
    | "supply"
    | "withdraw"
    | "borrow"
    | "repay"
    | "enable-collateral"
    | "disable-collateral";
  readonly market: Address;
  readonly asset?: Address;
  readonly assetSymbol?: string;
  readonly amount?: Amount;
  readonly amountAsset?: Address;
  readonly underlyingAmount?: Amount;
  readonly receiptAmount?: Amount;
  readonly beneficiary: string;
}

export interface TransferAction {
  readonly kind: "transfer";
  readonly index: number;
  readonly operation: "wrap-native" | "unwrap-native" | "sweep" | "transfer" | "settle" | "take";
  readonly asset?: Address;
  readonly recipient?: string;
  readonly amount: Amount;
}

export interface AuthorizationAction {
  readonly kind: "authorization";
  readonly index: number;
  readonly operation: "permit2-permit" | "permit2-transfer" | "permit2-batch";
  readonly decoded: boolean;
  readonly permit?: Permit2Permit;
  readonly transfers?: readonly Permit2Transfer[];
}

export type AvantisIntentType =
  | "OpenTradeReq"
  | "OpenTradeCoinExposureReq"
  | "CloseTradeReq"
  | "CloseTradeCoinExposureReq"
  | "IncreasePositionSizeReq"
  | "IncreasePositionSizeWithCoinExposureReq";

export interface AvantisAction {
  readonly kind: "avantis";
  readonly index: number;
  readonly operation: "open" | "close" | "increase" | "update-margin" | "cancel-limit" | "update-limit";
  readonly trader: Address;
  readonly pairIndex: number;
  readonly positionIndex?: string;
  readonly side?: "long" | "short";
  readonly orderType?: "market" | "limit" | "stop-limit" | "market-pnl";
  readonly sizing: "usdc" | "coin";
  readonly marginAction?: "deposit" | "withdraw";
  readonly collateral?: Amount;
  readonly closeAmount?: Amount;
  readonly coinExposure?: Amount;
  readonly leverage?: string;
  readonly minimumLeverage?: string;
  readonly maximumLeverage?: string;
  readonly slippageP?: string;
  readonly openPrice?: string;
  readonly wantedPrice?: string;
  readonly takeProfit?: string;
  readonly stopLoss?: string;
  readonly openTimestamp?: string;
  readonly deadlineMs?: string;
  readonly nonce?: string;
  readonly signedIntent: boolean;
  readonly intentType?: AvantisIntentType;
  readonly intentMessage?: Readonly<Record<string, unknown>>;
  readonly signature?: Hex;
}

export interface Permit2Detail {
  readonly token: Address;
  readonly amount: string;
  readonly expiration: number;
  readonly nonce: number;
}

export interface Permit2Permit {
  readonly type: "PermitSingle" | "PermitBatch";
  readonly owner: Address;
  readonly spender: Address;
  readonly sigDeadline: string;
  readonly signature: Hex;
  readonly details: readonly Permit2Detail[];
}

export interface Permit2Transfer {
  readonly token: Address;
  readonly from: Address;
  readonly to: Address;
  readonly amount: string;
}

export interface Permit2AllowanceEvidence {
  readonly token: Address;
  readonly owner: Address;
  readonly spender: Address;
  readonly amount: string;
  readonly expiration: number;
  readonly nonce: number;
  readonly source: "chain" | "earlier-command";
}

export interface Permit2Check {
  readonly actionIndex: number;
  readonly status: "valid" | "invalid" | "unavailable";
  readonly signatureMethod?: "eoa" | "eip1271";
  readonly digest?: Hex;
  readonly recoveredSigner?: Address;
  readonly allowances: readonly Permit2AllowanceEvidence[];
  readonly expectedAllowanceUpdates: readonly {
    readonly token: Address;
    readonly spender: Address;
    readonly beforeAmount: string;
    readonly authorizedAmount: string;
    readonly maximumExposureChange: string;
    readonly expiration: number;
  }[];
  readonly findings: readonly PolicyFinding[];
}

export interface Permit2Verification {
  readonly transactionFingerprint: Hex;
  readonly contract: Address;
  readonly blockNumber?: string;
  readonly blockHash?: Hex;
  readonly blockTimestamp?: number;
  readonly checks: readonly Permit2Check[];
}

export interface UnknownAction {
  readonly kind: "unknown";
  readonly index: number;
  readonly code: number;
  readonly reason: string;
}

export type IntentAction =
  | SwapAction
  | LendingAction
  | MorphoAction
  | TransferAction
  | AuthorizationAction
  | AvantisAction
  | UnknownAction;

export interface IntentAnalysis {
  readonly schemaVersion: "1.0";
  readonly protocol: "uniswap" | "aerodrome" | "moonwell" | "morpho" | "avantis" | "unknown";
  readonly adapter: string;
  readonly chainId: number;
  readonly sender: Address;
  readonly target: Address;
  readonly nativeValue: string;
  readonly deadline?: string;
  readonly actions: readonly IntentAction[];
  readonly expectedBalanceChanges: readonly BalanceChange[];
  readonly warnings: readonly string[];
  readonly source?: TransactionSource;
  readonly transactionFingerprint?: Hex;
}

export interface PolicyConfig {
  readonly version: "1";
  readonly allowedChainIds: readonly number[];
  readonly allowedTargets: readonly Address[];
  readonly allowedTokens: readonly Address[];
  readonly allowedRecipients: readonly Address[];
  readonly allowedV4Hooks: readonly Address[];
  readonly allowedAerodromeFactories?: readonly Address[];
  readonly allowedMorphoMarkets?: readonly Hex[];
  readonly allowedAvantisPairIndexes?: readonly number[];
  readonly maximumAmountByToken: Readonly<Record<string, string>>;
  readonly maximumNativeValue: string;
  readonly maximumDeadlineSeconds: number;
  readonly allowBorrow: boolean;
  readonly allowDynamicV4Fee: boolean;
  readonly requireSimulation: boolean;
  readonly maximumPermit2ExpirationSeconds?: number;
  readonly maximumPermit2SignatureDeadlineSeconds?: number;
  readonly maximumAvantisLeverage?: string;
  readonly maximumAvantisSlippageP?: string;
  readonly allowAvantisOpen?: boolean;
}

export type PolicyReasonCode =
  | "MOONWELL_STATE_REQUIRED"
  | "MOONWELL_PRECHECK_FAILED"
  | "MORPHO_STATE_REQUIRED"
  | "MORPHO_PRECHECK_FAILED"
  | "MORPHO_MARKET_NOT_ALLOWED"
  | "MORPHO_CALLBACK_NOT_ALLOWED"
  | "AERODROME_FACTORY_NOT_ALLOWED"
  | "AVANTIS_STATE_REQUIRED"
  | "AVANTIS_PRECHECK_FAILED"
  | "AVANTIS_PAIR_NOT_ALLOWED"
  | "AVANTIS_TRADER_MISMATCH"
  | "AVANTIS_SIGNATURE_INVALID"
  | "AVANTIS_NONCE_USED"
  | "AVANTIS_DELEGATION_INVALID"
  | "AVANTIS_OPEN_NOT_ALLOWED"
  | "AVANTIS_LEVERAGE_LIMIT_EXCEEDED"
  | "AVANTIS_SLIPPAGE_LIMIT_EXCEEDED"
  | "UNSUPPORTED_CHAIN"
  | "UNAUTHORIZED_TARGET"
  | "UNKNOWN_ACTION"
  | "UNAPPROVED_TOKEN"
  | "UNAPPROVED_RECIPIENT"
  | "AMOUNT_LIMIT_EXCEEDED"
  | "NATIVE_VALUE_LIMIT_EXCEEDED"
  | "DEADLINE_EXPIRED"
  | "DEADLINE_TOO_FAR"
  | "ZERO_MINIMUM_OUTPUT"
  | "V4_HOOK_NOT_ALLOWED"
  | "DYNAMIC_V4_FEE_NOT_ALLOWED"
  | "BORROW_NOT_ALLOWED"
  | "UNVERIFIED_AUTHORIZATION"
  | "PERMIT2_SPENDER_NOT_ALLOWED"
  | "PERMIT2_OWNER_MISMATCH"
  | "PERMIT2_SIGNATURE_INVALID"
  | "PERMIT2_SIGNATURE_EXPIRED"
  | "PERMIT2_SIGNATURE_DEADLINE_TOO_FAR"
  | "PERMIT2_ALLOWANCE_EXPIRED"
  | "PERMIT2_EXPIRATION_TOO_FAR"
  | "PERMIT2_NONCE_MISMATCH"
  | "PERMIT2_ALLOWANCE_INSUFFICIENT"
  | "PERMIT2_LIMIT_MISSING"
  | "PERMIT2_STATE_UNAVAILABLE"
  | "PERMIT2_EMPTY_BATCH"
  | "SIMULATION_REQUIRED"
  | "SIMULATION_FAILED";

export interface PolicyFinding {
  readonly code: PolicyReasonCode;
  readonly message: string;
  readonly actionIndex?: number;
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
}

export interface PolicyDecision {
  readonly outcome: "pass" | "reject" | "review";
  readonly findings: readonly PolicyFinding[];
}

export interface SimulationResult {
  readonly attempted: boolean;
  readonly success: boolean;
  readonly rpcUrl?: string;
  readonly blockNumber?: string;
  readonly returnData?: Hex;
  readonly error?: string;
  readonly blockHash?: Hex;
  readonly transactionFingerprint?: Hex;
}

export interface AuthorizationReport {
  readonly schemaVersion: "1.0";
  readonly generatedAt: string;
  readonly transaction: TransactionEnvelope;
  readonly intent: IntentAnalysis;
  readonly policy: PolicyDecision;
  readonly simulation: SimulationResult;
  readonly finalDecision: "pass" | "reject" | "review";
  readonly permit2?: Permit2Verification;
  readonly moonwell?: MoonwellPreflight;
  readonly morpho?: MorphoPreflight;
  readonly avantis?: AvantisPreflight;
}

export interface AvantisIntentCheck {
  readonly actionIndex: number;
  readonly status: "valid" | "invalid" | "unavailable";
  readonly trader: Address;
  readonly signer?: Address;
  readonly digest?: Hex;
  readonly nonce: string;
  readonly nonceUsed?: boolean;
  readonly delegated?: boolean;
  readonly delegationExpiry?: string;
  readonly error?: string;
}

export interface AvantisPreflight {
  readonly transactionFingerprint: Hex;
  readonly status: "ready" | "unavailable" | "invalid";
  readonly blockNumber?: string;
  readonly blockHash?: Hex;
  readonly blockTimestamp?: number;
  readonly checks: readonly AvantisIntentCheck[];
  readonly error?: string;
}

export interface MoonwellExposure {
  readonly actionIndex: number;
  readonly market: Address;
  readonly account: Address;
  readonly underlying: Address;
  readonly exchangeRateMantissa: string;
  readonly underlyingAmount: string;
  readonly receiptAmount: string;
  readonly receiptBalanceBefore: string;
  readonly receiptBalanceAfter: string;
  readonly suppliedUnderlyingBefore: string;
  readonly suppliedUnderlyingAfter: string;
  readonly debtBefore: string;
  readonly debtAfter: string;
  readonly collateralEnabledBefore: boolean;
  readonly collateralEnabledAfter: boolean;
  readonly collateralUnderlyingBefore: string;
  readonly collateralUnderlyingAfter: string;
}

export interface MoonwellPreflight {
  readonly transactionFingerprint: Hex;
  readonly status: "ready" | "unavailable" | "invalid";
  readonly blockNumber?: string;
  readonly blockHash?: Hex;
  readonly blockTimestamp?: number;
  readonly exposures: readonly MoonwellExposure[];
  readonly error?: string;
}

export interface MorphoExposure {
  readonly actionIndex: number;
  readonly marketId: Hex;
  readonly account: Address;
  readonly loanToken: Address;
  readonly collateralToken: Address;
  readonly operation: MorphoAction["operation"];
  readonly assets: string;
  readonly shares: string;
  readonly supplySharesBefore: string;
  readonly supplySharesAfter: string;
  readonly borrowSharesBefore: string;
  readonly borrowSharesAfter: string;
  readonly collateralBefore: string;
  readonly collateralAfter: string;
  readonly totalSupplyAssets: string;
  readonly totalSupplyShares: string;
  readonly totalBorrowAssets: string;
  readonly totalBorrowShares: string;
}

export interface MorphoPreflight {
  readonly transactionFingerprint: Hex;
  readonly status: "ready" | "unavailable" | "invalid";
  readonly blockNumber?: string;
  readonly blockHash?: Hex;
  readonly blockTimestamp?: number;
  readonly exposures: readonly MorphoExposure[];
  readonly error?: string;
}
