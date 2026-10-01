import { decodeAbiParameters, getAddress, parseAbiParameters, sliceHex, toFunctionSelector } from "viem";
import { BASE_MOONWELL_COMPTROLLER, findMoonwellMarket } from "../contracts.js";
import { transactionFingerprint } from "../permit2.js";
import type {
  Address,
  Amount,
  BalanceChange,
  IntentAction,
  IntentAnalysis,
  LendingAction,
  TransactionEnvelope,
  UnknownAction,
} from "../domain.js";

const SELECTOR = {
  mint: toFunctionSelector("mint(uint256)"),
  redeem: toFunctionSelector("redeem(uint256)"),
  redeemUnderlying: toFunctionSelector("redeemUnderlying(uint256)"),
  borrow: toFunctionSelector("borrow(uint256)"),
  repayBorrow: toFunctionSelector("repayBorrow(uint256)"),
  repayBorrowBehalf: toFunctionSelector("repayBorrowBehalf(address,uint256)"),
  enterMarkets: toFunctionSelector("enterMarkets(address[])"),
  exitMarket: toFunctionSelector("exitMarket(address)"),
} as const;

const MAX_UINT256 = (1n << 256n) - 1n;

function normalizeAddress(value: Address): Address {
  return getAddress(value) as Address;
}

function exactAmount(value: bigint, supportsAll = false): Amount {
  if (supportsAll && value === MAX_UINT256) {
    return { value: "all", mode: "all" };
  }
  return { value: value.toString(), mode: "exact" };
}

function unknownAmount(): Amount {
  return { value: "unknown", mode: "unknown" };
}

function unknownAction(selector: string): UnknownAction {
  return {
    kind: "unknown",
    index: 0,
    code: Number.parseInt(selector.slice(2), 16),
    reason: `Unsupported Moonwell selector ${selector}`,
  };
}

function lendingAction(
  operation: LendingAction["operation"],
  market: Address,
  beneficiary: string,
  amount?: Amount,
  amountAsset?: Address,
): LendingAction {
  const metadata = findMoonwellMarket(market);
  const quantityAsset = amountAsset ?? metadata?.underlying;
  return {
    kind: "lending",
    index: 0,
    operation,
    market: normalizeAddress(market),
    ...(metadata === undefined
      ? {}
      : { asset: normalizeAddress(metadata.underlying), assetSymbol: metadata.symbol }),
    ...(amount === undefined ? {} : {
      amount,
      ...(quantityAsset ? { amountAsset: quantityAsset } : {}),
    }),
    beneficiary,
  };
}

export function marketBalanceChanges(action: LendingAction): readonly BalanceChange[] {
  const metadata = findMoonwellMarket(action.market);
  if (metadata === undefined || action.amount === undefined) {
    return [];
  }
  const asset = normalizeAddress(metadata.underlying);
  const market = normalizeAddress(metadata.market);
  const underlyingAmount = action.underlyingAmount ??
    (action.amountAsset?.toLowerCase() === market.toLowerCase() ? unknownAmount() : action.amount);
  const receiptAmount = action.receiptAmount ??
    (action.amountAsset?.toLowerCase() === market.toLowerCase() ? action.amount : unknownAmount());
  if (action.operation === "supply") {
    return [
      {
        account: "sender",
        asset,
        assetSymbol: metadata.symbol,
        category: "asset",
        direction: "debit",
        amount: underlyingAmount,
        reason: "Moonwell supply transfers underlying to the market",
      },
      {
        account: action.beneficiary,
        asset: market,
        assetSymbol: metadata.receiptSymbol,
        category: "receipt",
        direction: "credit",
        amount: receiptAmount,
        reason: "mToken amount uses the accrued exchange rate when verified state is available",
      },
    ];
  }
  if (action.operation === "withdraw") {
    return [
      {
        account: "sender",
        asset: market,
        assetSymbol: metadata.receiptSymbol,
        category: "receipt",
        direction: "debit",
        amount: receiptAmount,
        reason: "Moonwell burns mTokens during withdrawal",
      },
      {
        account: action.beneficiary,
        asset,
        assetSymbol: metadata.symbol,
        category: "asset",
        direction: "credit",
        amount: underlyingAmount,
        reason: "Underlying received depends on the redeem mode and exchange rate",
      },
    ];
  }
  if (action.operation === "borrow") {
    return [
      {
        account: action.beneficiary,
        asset,
        assetSymbol: metadata.symbol,
        category: "asset",
        direction: "credit",
        amount: underlyingAmount,
        reason: "Borrowed underlying is transferred to the borrower",
      },
      {
        account: action.beneficiary,
        asset,
        assetSymbol: metadata.symbol,
        category: "debt",
        direction: "credit",
        amount: underlyingAmount,
        reason: "Moonwell borrow balance increases",
      },
    ];
  }
  if (action.operation === "repay") {
    return [
      {
        account: "sender",
        asset,
        assetSymbol: metadata.symbol,
        category: "asset",
        direction: "debit",
        amount: underlyingAmount,
        reason: "Underlying is transferred to Moonwell for repayment",
      },
      {
        account: action.beneficiary,
        asset,
        assetSymbol: metadata.symbol,
        category: "debt",
        direction: "debit",
        amount: underlyingAmount,
        reason: "Moonwell borrow balance decreases",
      },
    ];
  }
  return [];
}

function decodeMarketAction(transaction: TransactionEnvelope): IntentAction {
  const selector = transaction.data.slice(0, 10).toLowerCase();
  const payload = sliceHex(transaction.data, 4);
  const market = normalizeAddress(transaction.to);

  if (selector === SELECTOR.mint) {
    const [value] = decodeAbiParameters(parseAbiParameters("uint256 amount"), payload);
    return lendingAction("supply", market, "sender", exactAmount(value));
  }
  if (selector === SELECTOR.redeem) {
    const [value] = decodeAbiParameters(parseAbiParameters("uint256 mTokenAmount"), payload);
    return lendingAction("withdraw", market, "sender", exactAmount(value, true), market);
  }
  if (selector === SELECTOR.redeemUnderlying) {
    const [value] = decodeAbiParameters(parseAbiParameters("uint256 underlyingAmount"), payload);
    return lendingAction("withdraw", market, "sender", exactAmount(value, true));
  }
  if (selector === SELECTOR.borrow) {
    const [value] = decodeAbiParameters(parseAbiParameters("uint256 amount"), payload);
    return lendingAction("borrow", market, "sender", exactAmount(value));
  }
  if (selector === SELECTOR.repayBorrow) {
    const [value] = decodeAbiParameters(parseAbiParameters("uint256 amount"), payload);
    return lendingAction("repay", market, "sender", exactAmount(value, true));
  }
  if (selector === SELECTOR.repayBorrowBehalf) {
    const [borrower, value] = decodeAbiParameters(
      parseAbiParameters("address borrower, uint256 amount"),
      payload,
    );
    return lendingAction("repay", market, normalizeAddress(borrower), exactAmount(value, true));
  }
  return unknownAction(selector);
}

function decodeComptrollerActions(transaction: TransactionEnvelope): readonly IntentAction[] {
  const selector = transaction.data.slice(0, 10).toLowerCase();
  const payload = sliceHex(transaction.data, 4);
  if (selector === SELECTOR.enterMarkets) {
    const [markets] = decodeAbiParameters(parseAbiParameters("address[] markets"), payload);
    if (!markets.length) return [{ ...unknownAction(selector), reason: "Empty Moonwell collateral market list" }];
    return markets.map((market, index) => ({
      ...lendingAction("enable-collateral", normalizeAddress(market), "sender"),
      index,
    }));
  }
  if (selector === SELECTOR.exitMarket) {
    const [market] = decodeAbiParameters(parseAbiParameters("address market"), payload);
    return [lendingAction("disable-collateral", normalizeAddress(market), "sender")];
  }
  return [unknownAction(selector)];
}

export function decodeMoonwellTransaction(transaction: TransactionEnvelope): IntentAnalysis {
  const isComptroller = transaction.to.toLowerCase() === BASE_MOONWELL_COMPTROLLER.toLowerCase();
  const actions = isComptroller ? decodeComptrollerActions(transaction) : [decodeMarketAction(transaction)];
  const expectedBalanceChanges = actions.flatMap((action) =>
    action.kind === "lending" ? marketBalanceChanges(action) : [],
  );

  return {
    schemaVersion: "1.0",
    protocol: "moonwell",
    adapter: "moonwell-core-v2",
    chainId: transaction.chainId,
    sender: transaction.from,
    target: transaction.to,
    nativeValue: transaction.value,
    transactionFingerprint: transactionFingerprint(transaction),
    actions,
    expectedBalanceChanges,
    warnings: [
      "Moonwell health, liquidity, caps, interest and exchange rates must be read at simulation time.",
      "A successful EVM call can still return a non-zero Compound-style error code.",
    ],
    ...(transaction.source === undefined ? {} : { source: transaction.source }),
  };
}
