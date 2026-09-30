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
}

export interface SwapAction {
  readonly kind: "swap";
  readonly index: number;
  readonly protocolVersion: "v2" | "v3" | "v4";
  readonly mode: "exact-input" | "exact-output";
  readonly recipient: string;
  readonly payerIsUser: boolean;
  readonly route: readonly SwapRouteStep[];
  readonly amountIn: Amount;
  readonly amountOut: Amount;
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
  | TransferAction
  | AuthorizationAction
  | UnknownAction;

export interface IntentAnalysis {
  readonly schemaVersion: "1.0";
  readonly protocol: "uniswap" | "moonwell" | "unknown";
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
}

export interface PolicyConfig {
  readonly version: "1";
  readonly allowedChainIds: readonly number[];
  readonly allowedTargets: readonly Address[];
  readonly allowedTokens: readonly Address[];
  readonly allowedRecipients: readonly Address[];
  readonly allowedV4Hooks: readonly Address[];
  readonly maximumAmountByToken: Readonly<Record<string, string>>;
  readonly maximumNativeValue: string;
  readonly maximumDeadlineSeconds: number;
  readonly allowBorrow: boolean;
  readonly allowDynamicV4Fee: boolean;
  readonly requireSimulation: boolean;
}

export type PolicyReasonCode =
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
}

export interface AuthorizationReport {
  readonly schemaVersion: "1.0";
  readonly generatedAt: string;
  readonly transaction: TransactionEnvelope;
  readonly intent: IntentAnalysis;
  readonly policy: PolicyDecision;
  readonly simulation: SimulationResult;
  readonly finalDecision: "pass" | "reject" | "review";
}
