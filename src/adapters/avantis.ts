import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbi, parseAbiParameters } from 'viem';
import { BASE_USDC } from '../contracts.js';
import { transactionFingerprint } from '../permit2.js';
import type {
    Address,
    AvantisAction,
    AvantisIntentType,
    BalanceChange,
    Hex,
    IntentAnalysis,
    TransactionEnvelope,
    UnknownAction
} from '../domain.js';

const tradeParameters =
    '(address trader,uint256 pairIndex,uint256 index,uint256 initialPosToken,uint256 positionSizeUSDC,uint256 openPrice,bool buy,uint256 leverage,uint256 tp,uint256 sl,uint256 timestamp)';
const updatePositionParameters =
    '(address trader,uint256 pairIndex,uint256 index,uint256 openPrice,uint256 initialPosToken,uint256 leverage)';

export const avantisAbi = parseAbi([
    `function openTrade(${tradeParameters} trade,uint8 orderType,uint256 slippageP) payable`,
    `function openTradeWithCoinExposure(${tradeParameters} trade,uint8 orderType,uint256 coinExposure,uint256 minLeverage,uint256 maxLeverage,uint256 slippageP) payable`,
    'function closeTradeMarket(uint256 pairIndex,uint256 index,uint256 amount,uint256 wantedPrice) payable',
    'function closeTradeMarketWithCoinExposure(uint256 pairIndex,uint256 index,uint256 coinExposure,uint256 wantedPrice) payable',
    `function increasePositionSize(${updatePositionParameters} updateInfo,uint256 slippageP) payable`,
    `function increasePositionSizeWithCoinExposure(${updatePositionParameters} updateInfo,uint256 coinExposure,uint256 minLeverage,uint256 maxLeverage,uint256 slippageP) payable`,
    'function cancelOpenLimitOrder(uint256 pairIndex,uint256 index)',
    'function updateOpenLimitOrder(uint256 pairIndex,uint256 index,uint256 price,uint256 slippageP,uint256 tp,uint256 sl)',
    'function updateMargin(uint256 pairIndex,uint256 index,uint8 updateType,uint256 amount,bytes[] priceUpdateData,uint8 priceSourcing) payable',
    'function executeMarketOrderBatched(uint8 orderType,bytes userSignature,bytes userIntent,bytes[] priceUpdateData,uint8 priceSourcing,(int256,uint256,int256,bool,int256,bool,int256) spreadParams) payable',
    'function executePositionUpdateBatched(uint8 orderType,bytes userSignature,bytes userIntent,bytes[] priceUpdateData,uint8 priceSourcing,(int256,uint256,int256,bool,int256,bool,int256) spreadParams) payable'
]);

type Trade = {
    readonly trader: Address;
    readonly pairIndex: bigint;
    readonly index: bigint;
    readonly initialPosToken: bigint;
    readonly positionSizeUSDC: bigint;
    readonly openPrice: bigint;
    readonly buy: boolean;
    readonly leverage: bigint;
    readonly tp: bigint;
    readonly sl: bigint;
    readonly timestamp: bigint;
};

type UpdatePosition = {
    readonly trader: Address;
    readonly pairIndex: bigint;
    readonly index: bigint;
    readonly openPrice: bigint;
    readonly initialPosToken: bigint;
    readonly leverage: bigint;
};

function address(value: Address): Address {
    return getAddress(value) as Address;
}

function orderType(value: number): NonNullable<AvantisAction['orderType']> {
    if (value === 0) return 'market';
    if (value === 1) return 'stop-limit';
    if (value === 2) return 'limit';
    return 'market-pnl';
}

function amount(value: bigint) {
    return { value: value.toString(), mode: 'exact' as const };
}

function serializedTrade(value: Trade): Readonly<Record<string, unknown>> {
    return {
        trader: address(value.trader),
        pairIndex: value.pairIndex.toString(),
        index: value.index.toString(),
        initialPosToken: value.initialPosToken.toString(),
        positionSizeUSDC: value.positionSizeUSDC.toString(),
        openPrice: value.openPrice.toString(),
        buy: value.buy,
        leverage: value.leverage.toString(),
        tp: value.tp.toString(),
        sl: value.sl.toString(),
        timestamp: value.timestamp.toString()
    };
}

function serializedUpdate(value: UpdatePosition): Readonly<Record<string, unknown>> {
    return {
        trader: address(value.trader),
        pairIndex: value.pairIndex.toString(),
        index: value.index.toString(),
        openPrice: value.openPrice.toString(),
        initialPosToken: value.initialPosToken.toString(),
        leverage: value.leverage.toString()
    };
}

function openAction(
    trade: Trade,
    type: number,
    slippageP: bigint,
    sizing: 'usdc' | 'coin',
    extra: Partial<AvantisAction> = {}
): AvantisAction {
    return {
        kind: 'avantis',
        index: 0,
        operation: 'open',
        trader: address(trade.trader),
        pairIndex: Number(trade.pairIndex),
        positionIndex: trade.index.toString(),
        side: trade.buy ? 'long' : 'short',
        orderType: orderType(type),
        sizing,
        collateral: amount(trade.positionSizeUSDC),
        leverage: trade.leverage.toString(),
        slippageP: slippageP.toString(),
        openPrice: trade.openPrice.toString(),
        takeProfit: trade.tp.toString(),
        stopLoss: trade.sl.toString(),
        signedIntent: false,
        ...extra
    } as AvantisAction;
}

function increaseAction(
    update: UpdatePosition,
    slippageP: bigint,
    sizing: 'usdc' | 'coin',
    extra: Partial<AvantisAction> = {}
): AvantisAction {
    return {
        kind: 'avantis',
        index: 0,
        operation: 'increase',
        trader: address(update.trader),
        pairIndex: Number(update.pairIndex),
        positionIndex: update.index.toString(),
        sizing,
        collateral: amount(update.initialPosToken),
        leverage: update.leverage.toString(),
        slippageP: slippageP.toString(),
        openPrice: update.openPrice.toString(),
        signedIntent: false,
        ...extra
    } as AvantisAction;
}

function signedFields(
    intentType: AvantisIntentType,
    message: Readonly<Record<string, unknown>>,
    signature: Hex
): Pick<AvantisAction, 'signedIntent' | 'intentType' | 'intentMessage' | 'signature' | 'deadlineMs' | 'nonce'> {
    const deadline = message._deadline ?? message.deadline;
    const nonce = message._nonce ?? message.nonce;
    return {
        signedIntent: true,
        intentType,
        intentMessage: message,
        signature,
        deadlineMs: String(deadline),
        nonce: String(nonce)
    };
}

function decodeSigned(order: number, signature: Hex, intent: Hex): AvantisAction | undefined {
    if ([0, 6].includes(order)) {
        const [trade, type, slippageP, deadline, nonce] = decodeAbiParameters(
            parseAbiParameters(`${tradeParameters},uint8,uint256,uint256,uint256`),
            intent
        ) as readonly [Trade, number, bigint, bigint, bigint];
        const message = {
            _t: serializedTrade(trade),
            _type: type,
            _slippageP: slippageP.toString(),
            _deadline: deadline.toString(),
            _nonce: nonce.toString()
        };
        return openAction(trade, type, slippageP, 'usdc', {
            ...signedFields('OpenTradeReq', message, signature),
            orderType: order === 6 ? 'market-pnl' : orderType(type)
        });
    }
    if ([12, 13].includes(order)) {
        const [trade, type, coinExposure, minLeverage, maxLeverage, slippageP, deadline, nonce] = decodeAbiParameters(
            parseAbiParameters(`${tradeParameters},uint8,uint256,uint256,uint256,uint256,uint256,uint256`),
            intent
        ) as readonly [Trade, number, bigint, bigint, bigint, bigint, bigint, bigint];
        const message = {
            _t: serializedTrade(trade),
            _type: type,
            _coinExposure: coinExposure.toString(),
            _minLeverage: minLeverage.toString(),
            _maxLeverage: maxLeverage.toString(),
            _slippageP: slippageP.toString(),
            _deadline: deadline.toString(),
            _nonce: nonce.toString()
        };
        return openAction(trade, type, slippageP, 'coin', {
            coinExposure: amount(coinExposure),
            minimumLeverage: minLeverage.toString(),
            maximumLeverage: maxLeverage.toString(),
            ...signedFields('OpenTradeCoinExposureReq', message, signature),
            orderType: order === 13 ? 'market-pnl' : orderType(type)
        });
    }
    if ([1, 7, 15, 16].includes(order)) {
        const [trader, pairIndex, index, openTimestamp, quantity, wantedPrice, deadline, nonce] = decodeAbiParameters(
            parseAbiParameters('address,uint256,uint256,uint256,uint256,uint256,uint256,uint256'),
            intent
        );
        const coin = order === 15 || order === 16;
        const intentType = coin ? 'CloseTradeCoinExposureReq' : 'CloseTradeReq';
        const message = coin
            ? {
                  _trader: address(trader),
                  _pairIndex: pairIndex.toString(),
                  _index: index.toString(),
                  _openTimestamp: openTimestamp.toString(),
                  _coinExposure: quantity.toString(),
                  _wantedPrice: wantedPrice.toString(),
                  _deadline: deadline.toString(),
                  _nonce: nonce.toString()
              }
            : {
                  _trader: address(trader),
                  _pairIndex: pairIndex.toString(),
                  _index: index.toString(),
                  _openTimestamp: openTimestamp.toString(),
                  _amount: quantity.toString(),
                  _wantedPrice: wantedPrice.toString(),
                  _deadline: deadline.toString(),
                  _nonce: nonce.toString()
              };
        return {
            kind: 'avantis',
            index: 0,
            operation: 'close',
            trader: address(trader),
            pairIndex: Number(pairIndex),
            positionIndex: index.toString(),
            sizing: coin ? 'coin' : 'usdc',
            ...(coin ? { coinExposure: amount(quantity) } : { closeAmount: amount(quantity) }),
            wantedPrice: wantedPrice.toString(),
            openTimestamp: openTimestamp.toString(),
            orderType: order === 7 || order === 16 ? 'market-pnl' : 'market',
            ...signedFields(intentType, message, signature)
        };
    }
    if ([9, 14].includes(order)) {
        if (order === 9) {
            const [update, slippageP, deadline, nonce] = decodeAbiParameters(
                parseAbiParameters(`${updatePositionParameters},uint256,uint256,uint256`),
                intent
            ) as readonly [UpdatePosition, bigint, bigint, bigint];
            const message = {
                _updateInfo: serializedUpdate(update),
                _slippageP: slippageP.toString(),
                _deadline: deadline.toString(),
                _nonce: nonce.toString()
            };
            return increaseAction(update, slippageP, 'usdc', {
                ...signedFields('IncreasePositionSizeReq', message, signature)
            });
        }
        const [update, coinExposure, minLeverage, maxLeverage, slippageP, deadline, nonce] = decodeAbiParameters(
            parseAbiParameters(`${updatePositionParameters},uint256,uint256,uint256,uint256,uint256,uint256`),
            intent
        ) as readonly [UpdatePosition, bigint, bigint, bigint, bigint, bigint, bigint];
        const message = {
            _updateInfo: serializedUpdate(update),
            _coinExposure: coinExposure.toString(),
            _minLeverage: minLeverage.toString(),
            _maxLeverage: maxLeverage.toString(),
            _slippageP: slippageP.toString(),
            _deadline: deadline.toString(),
            _nonce: nonce.toString()
        };
        return increaseAction(update, slippageP, 'coin', {
            coinExposure: amount(coinExposure),
            minimumLeverage: minLeverage.toString(),
            maximumLeverage: maxLeverage.toString(),
            ...signedFields('IncreasePositionSizeWithCoinExposureReq', message, signature)
        });
    }
    return undefined;
}

export function avantisBalanceChanges(action: AvantisAction): readonly BalanceChange[] {
    if (action.operation === 'open' || action.operation === 'increase') {
        if (!action.collateral) return [];
        return [
            {
                account: action.trader,
                asset: BASE_USDC,
                assetSymbol: 'USDC',
                category: 'asset',
                direction: 'debit',
                amount: action.collateral,
                reason: `Avantis ${action.operation} collateral`
            }
        ];
    }
    if (action.operation === 'close') {
        return [
            {
                account: action.trader,
                asset: BASE_USDC,
                assetSymbol: 'USDC',
                category: 'asset',
                direction: 'credit',
                amount: { value: 'unknown', mode: 'unknown' },
                reason: 'Avantis close proceeds after PnL and fees'
            }
        ];
    }
    if (action.operation === 'update-margin' && action.collateral) {
        return [
            {
                account: action.trader,
                asset: BASE_USDC,
                assetSymbol: 'USDC',
                category: 'asset',
                direction: action.marginAction === 'withdraw' ? 'credit' : 'debit',
                amount: action.collateral,
                reason: `Avantis margin ${action.marginAction ?? 'update'}`
            }
        ];
    }
    return [];
}

function unknown(transaction: TransactionEnvelope, reason: string): IntentAnalysis {
    const action: UnknownAction = {
        kind: 'unknown',
        index: 0,
        code: Number.parseInt(transaction.data.slice(2, 10), 16),
        reason
    };
    return {
        schemaVersion: '1.0',
        protocol: 'avantis',
        adapter: 'avantis-veranta-v2',
        chainId: transaction.chainId,
        sender: transaction.from,
        target: transaction.to,
        nativeValue: transaction.value,
        transactionFingerprint: transactionFingerprint(transaction),
        actions: [action],
        expectedBalanceChanges: [],
        warnings: ['Unsupported, keeper-only or malformed Avantis calls are rejected.'],
        ...(transaction.source ? { source: transaction.source } : {})
    };
}

export function decodeAvantisTransaction(transaction: TransactionEnvelope): IntentAnalysis {
    try {
        const decoded = decodeFunctionData({ abi: avantisAbi, data: transaction.data });
        let action: AvantisAction | undefined;
        if (
            decoded.functionName === 'executeMarketOrderBatched' ||
            decoded.functionName === 'executePositionUpdateBatched'
        ) {
            action = decodeSigned(Number(decoded.args[0]), decoded.args[1], decoded.args[2]);
        } else if (decoded.functionName === 'openTrade' || decoded.functionName === 'openTradeWithCoinExposure') {
            const trade = decoded.args[0] as Trade;
            action = openAction(
                trade,
                Number(decoded.args[1]),
                decoded.functionName === 'openTrade' ? decoded.args[2] : decoded.args[5],
                decoded.functionName === 'openTrade' ? 'usdc' : 'coin',
                decoded.functionName === 'openTrade'
                    ? {}
                    : {
                          coinExposure: amount(decoded.args[2]),
                          minimumLeverage: decoded.args[3].toString(),
                          maximumLeverage: decoded.args[4].toString()
                      }
            );
        } else if (
            decoded.functionName === 'closeTradeMarket' ||
            decoded.functionName === 'closeTradeMarketWithCoinExposure'
        ) {
            const coin = decoded.functionName.endsWith('CoinExposure');
            action = {
                kind: 'avantis',
                index: 0,
                operation: 'close',
                trader: transaction.from,
                pairIndex: Number(decoded.args[0]),
                positionIndex: decoded.args[1].toString(),
                sizing: coin ? 'coin' : 'usdc',
                ...(coin ? { coinExposure: amount(decoded.args[2]) } : { closeAmount: amount(decoded.args[2]) }),
                wantedPrice: decoded.args[3].toString(),
                signedIntent: false
            };
        } else if (
            decoded.functionName === 'increasePositionSize' ||
            decoded.functionName === 'increasePositionSizeWithCoinExposure'
        ) {
            const update = decoded.args[0] as UpdatePosition;
            const coin = decoded.functionName.endsWith('CoinExposure');
            if (coin) {
                const [, coinExposure, minLeverage, maxLeverage, slippageP] = decoded.args as unknown as readonly [
                    UpdatePosition,
                    bigint,
                    bigint,
                    bigint,
                    bigint
                ];
                action = increaseAction(update, slippageP, 'coin', {
                    coinExposure: amount(coinExposure),
                    minimumLeverage: minLeverage.toString(),
                    maximumLeverage: maxLeverage.toString()
                });
            } else {
                action = increaseAction(update, decoded.args[1], 'usdc');
            }
        } else if (decoded.functionName === 'cancelOpenLimitOrder') {
            action = {
                kind: 'avantis',
                index: 0,
                operation: 'cancel-limit',
                trader: transaction.from,
                pairIndex: Number(decoded.args[0]),
                positionIndex: decoded.args[1].toString(),
                sizing: 'usdc',
                signedIntent: false
            };
        } else if (decoded.functionName === 'updateOpenLimitOrder') {
            action = {
                kind: 'avantis',
                index: 0,
                operation: 'update-limit',
                trader: transaction.from,
                pairIndex: Number(decoded.args[0]),
                positionIndex: decoded.args[1].toString(),
                sizing: 'usdc',
                openPrice: decoded.args[2].toString(),
                slippageP: decoded.args[3].toString(),
                takeProfit: decoded.args[4].toString(),
                stopLoss: decoded.args[5].toString(),
                signedIntent: false
            };
        } else if (decoded.functionName === 'updateMargin') {
            if (decoded.args[2] > 1)
                return unknown(transaction, `Unsupported Avantis margin action ${decoded.args[2]}`);
            action = {
                kind: 'avantis',
                index: 0,
                operation: 'update-margin',
                trader: transaction.from,
                pairIndex: Number(decoded.args[0]),
                positionIndex: decoded.args[1].toString(),
                sizing: 'usdc',
                marginAction: decoded.args[2] === 0 ? 'deposit' : 'withdraw',
                collateral: amount(decoded.args[3]),
                signedIntent: false
            };
        }
        if (!action) return unknown(transaction, `Unsupported Avantis operation ${decoded.functionName}`);
        return {
            schemaVersion: '1.0',
            protocol: 'avantis',
            adapter: 'avantis-veranta-v2',
            chainId: transaction.chainId,
            sender: transaction.from,
            target: transaction.to,
            nativeValue: transaction.value,
            ...(action.deadlineMs ? { deadline: (BigInt(action.deadlineMs) / 1000n).toString() } : {}),
            transactionFingerprint: transactionFingerprint(transaction),
            actions: [action],
            expectedBalanceChanges: avantisBalanceChanges(action),
            warnings: ['Avantis prices, leverage, slippage and coin exposure use 1e10 fixed-point units.'],
            ...(transaction.source ? { source: transaction.source } : {})
        };
    } catch {
        return unknown(transaction, `Unsupported or malformed Avantis selector ${transaction.data.slice(0, 10)}`);
    }
}
