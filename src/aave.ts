import { createPublicClient, getAddress, parseAbi } from 'viem';
import { aaveBalanceChanges } from './adapters/aave.js';
import {
    BASE_AAVE_ORACLE,
    BASE_AAVE_POOL,
    BASE_AAVE_POOL_ADDRESSES_PROVIDER,
    BASE_AAVE_PROTOCOL_DATA_PROVIDER,
    BASE_CHAIN_ID
} from './contracts.js';
import type {
    AaveAccountData,
    AaveAction,
    AaveExposure,
    AavePreflight,
    AaveReserveState,
    Address,
    IntentAnalysis,
    PolicyReasonCode,
    SimulationResult,
    TransactionEnvelope
} from './domain.js';
import { transactionFingerprint } from './permit2.js';
import { rpcTransport } from './rpc.js';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const MAX_UINT256 = (1n << 256n) - 1n;
const HEALTH_FACTOR_SCALE = 10n ** 18n;
const PERCENTAGE_SCALE = 10_000n;
const RAY = 10n ** 27n;

const addressesProviderAbi = parseAbi(['function getPool() view returns (address)']);
const oracleAbi = parseAbi(['function getAssetPrice(address asset) view returns (uint256)']);
const poolStateAbi = parseAbi([
    'function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)',
    'function getUserEMode(address user) view returns (uint256)',
    'function getReserveNormalizedIncome(address asset) view returns (uint256)',
    'function getReserveNormalizedVariableDebt(address asset) view returns (uint256)'
]);
const scaledTokenAbi = parseAbi(['function scaledBalanceOf(address user) view returns (uint256)']);
const dataProviderAbi = parseAbi([
    'function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)',
    'function getPaused(address asset) view returns (bool)',
    'function getReserveCaps(address asset) view returns (uint256 borrowCap,uint256 supplyCap)',
    'function getDebtCeiling(address asset) view returns (uint256)',
    'function getSiloedBorrowing(address asset) view returns (bool)',
    'function getReserveTokensAddresses(address asset) view returns (address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress)',
    'function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)',
    'function getReserveData(address asset) view returns (uint256 unbacked,uint256 accruedToTreasuryScaled,uint256 totalAToken,uint256 totalStableDebt,uint256 totalVariableDebt,uint256 liquidityRate,uint256 variableBorrowRate,uint256 stableBorrowRate,uint256 averageStableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex,uint40 lastUpdateTimestamp)'
]);

function accountData(values: readonly bigint[]): AaveAccountData {
    return {
        totalCollateralBase: values[0]!.toString(),
        totalDebtBase: values[1]!.toString(),
        availableBorrowsBase: values[2]!.toString(),
        currentLiquidationThreshold: values[3]!.toString(),
        ltv: values[4]!.toString(),
        healthFactor: values[5]!.toString()
    };
}

function invalid(fingerprint: `0x${string}`, code: PolicyReasonCode, error: string): AavePreflight {
    return { transactionFingerprint: fingerprint, status: 'invalid', exposures: [], errorCode: code, error };
}

function rayDivFloor(value: bigint, index: bigint): bigint {
    return (value * RAY) / index;
}

function rayDivCeil(value: bigint, index: bigint): bigint {
    return (value * RAY + index - 1n) / index;
}

function rayMulFloor(value: bigint, index: bigint): bigint {
    return (value * index) / RAY;
}

function rayMulCeil(value: bigint, index: bigint): bigint {
    return (value * index + RAY - 1n) / RAY;
}

function projectedAccount(
    before: AaveAccountData,
    reserve: AaveReserveState,
    collateralDeltaBase: bigint,
    debtDeltaBase: bigint
): AaveAccountData | undefined {
    const collateralBefore = BigInt(before.totalCollateralBase);
    const debtBefore = BigInt(before.totalDebtBase);
    const collateralAfter = collateralBefore + collateralDeltaBase;
    const debtAfter = debtBefore + debtDeltaBase;
    if (collateralAfter < 0n || debtAfter < 0n) return undefined;
    const liquidationNumerator =
        collateralBefore * BigInt(before.currentLiquidationThreshold) +
        collateralDeltaBase * BigInt(reserve.liquidationThreshold);
    const ltvNumerator = collateralBefore * BigInt(before.ltv) + collateralDeltaBase * BigInt(reserve.ltv);
    if (liquidationNumerator < 0n || ltvNumerator < 0n) return undefined;
    const liquidationThreshold = collateralAfter === 0n ? 0n : liquidationNumerator / collateralAfter;
    const ltv = collateralAfter === 0n ? 0n : ltvNumerator / collateralAfter;
    const borrowingPower = ltvNumerator / PERCENTAGE_SCALE;
    const available = borrowingPower > debtAfter ? borrowingPower - debtAfter : 0n;
    const healthFactor =
        debtAfter === 0n ? MAX_UINT256 : (liquidationNumerator * HEALTH_FACTOR_SCALE) / (PERCENTAGE_SCALE * debtAfter);
    return {
        totalCollateralBase: collateralAfter.toString(),
        totalDebtBase: debtAfter.toString(),
        availableBorrowsBase: available.toString(),
        currentLiquidationThreshold: liquidationThreshold.toString(),
        ltv: ltv.toString(),
        healthFactor: healthFactor.toString()
    };
}

export async function preflightAave(
    transaction: TransactionEnvelope,
    intent: IntentAnalysis,
    rpcUrl: string,
    requestedBlock?: bigint
): Promise<AavePreflight> {
    const fingerprint = transactionFingerprint(transaction);
    if (intent.actions.length !== 1 || intent.actions[0]?.kind !== 'aave') {
        return invalid(
            fingerprint,
            'AAVE_PRECHECK_FAILED',
            'Aave transactions must contain one supported Pool operation.'
        );
    }
    const action = intent.actions[0];
    const client = createPublicClient({ transport: rpcTransport(rpcUrl) });
    try {
        if (transaction.chainId !== BASE_CHAIN_ID || (await client.getChainId()) !== BASE_CHAIN_ID) {
            throw new Error('Unsupported RPC chain');
        }
        const block = await client.getBlock(requestedBlock === undefined ? {} : { blockNumber: requestedBlock });
        if (!block.hash || block.number === null) throw new Error('Unconfirmed block');
        const account = getAddress(action.beneficiary) as Address;
        const contracts = [
            {
                address: BASE_AAVE_POOL_ADDRESSES_PROVIDER,
                abi: addressesProviderAbi,
                functionName: 'getPool' as const
            },
            {
                address: BASE_AAVE_PROTOCOL_DATA_PROVIDER,
                abi: dataProviderAbi,
                functionName: 'getReserveConfigurationData' as const,
                args: [action.asset]
            },
            {
                address: BASE_AAVE_PROTOCOL_DATA_PROVIDER,
                abi: dataProviderAbi,
                functionName: 'getPaused' as const,
                args: [action.asset]
            },
            {
                address: BASE_AAVE_PROTOCOL_DATA_PROVIDER,
                abi: dataProviderAbi,
                functionName: 'getReserveCaps' as const,
                args: [action.asset]
            },
            {
                address: BASE_AAVE_PROTOCOL_DATA_PROVIDER,
                abi: dataProviderAbi,
                functionName: 'getDebtCeiling' as const,
                args: [action.asset]
            },
            {
                address: BASE_AAVE_PROTOCOL_DATA_PROVIDER,
                abi: dataProviderAbi,
                functionName: 'getSiloedBorrowing' as const,
                args: [action.asset]
            },
            {
                address: BASE_AAVE_PROTOCOL_DATA_PROVIDER,
                abi: dataProviderAbi,
                functionName: 'getReserveTokensAddresses' as const,
                args: [action.asset]
            },
            {
                address: BASE_AAVE_PROTOCOL_DATA_PROVIDER,
                abi: dataProviderAbi,
                functionName: 'getUserReserveData' as const,
                args: [action.asset, account]
            },
            {
                address: BASE_AAVE_PROTOCOL_DATA_PROVIDER,
                abi: dataProviderAbi,
                functionName: 'getReserveData' as const,
                args: [action.asset]
            },
            {
                address: BASE_AAVE_POOL,
                abi: poolStateAbi,
                functionName: 'getUserAccountData' as const,
                args: [account]
            },
            {
                address: BASE_AAVE_POOL,
                abi: poolStateAbi,
                functionName: 'getUserEMode' as const,
                args: [account]
            },
            {
                address: BASE_AAVE_POOL,
                abi: poolStateAbi,
                functionName: 'getReserveNormalizedIncome' as const,
                args: [action.asset]
            },
            {
                address: BASE_AAVE_POOL,
                abi: poolStateAbi,
                functionName: 'getReserveNormalizedVariableDebt' as const,
                args: [action.asset]
            },
            {
                address: BASE_AAVE_ORACLE,
                abi: oracleAbi,
                functionName: 'getAssetPrice' as const,
                args: [action.asset]
            }
        ] as const;
        const result = await client.multicall({
            allowFailure: false,
            blockNumber: block.number,
            contracts,
            multicallAddress: MULTICALL3
        });
        const [
            canonicalPool,
            configuration,
            paused,
            caps,
            debtCeiling,
            siloedBorrowing,
            reserveTokens,
            userReserve,
            reserveData,
            rawAccount,
            eMode,
            liquidityIndex,
            variableBorrowIndex,
            assetPrice
        ] = result;
        if (canonicalPool.toLowerCase() !== BASE_AAVE_POOL.toLowerCase()) {
            return invalid(fingerprint, 'AAVE_PRECHECK_FAILED', 'Aave Pool does not match the canonical provider.');
        }
        const reserve: AaveReserveState = {
            decimals: Number(configuration[0]),
            ltv: configuration[1].toString(),
            liquidationThreshold: configuration[2].toString(),
            usageAsCollateralEnabled: configuration[5],
            borrowingEnabled: configuration[6],
            active: configuration[8],
            frozen: configuration[9],
            paused,
            borrowCap: caps[0].toString(),
            supplyCap: caps[1].toString(),
            debtCeiling: debtCeiling.toString(),
            siloedBorrowing
        };
        if (!reserve.active) return invalid(fingerprint, 'AAVE_RESERVE_INACTIVE', 'Aave reserve is inactive.');
        if (reserve.paused) return invalid(fingerprint, 'AAVE_RESERVE_PAUSED', 'Aave reserve is paused.');
        if (reserve.frozen && (action.operation === 'supply' || action.operation === 'borrow')) {
            return invalid(fingerprint, 'AAVE_RESERVE_FROZEN', 'Aave reserve is frozen for new supply or borrowing.');
        }
        if (action.operation === 'borrow' && !reserve.borrowingEnabled) {
            return invalid(fingerprint, 'AAVE_BORROWING_DISABLED', 'Aave borrowing is disabled for this reserve.');
        }
        if (
            (action.operation === 'enable-collateral' || action.operation === 'disable-collateral') &&
            !reserve.usageAsCollateralEnabled
        ) {
            return invalid(
                fingerprint,
                'AAVE_COLLATERAL_DISABLED',
                'Aave collateral usage is disabled for this reserve.'
            );
        }
        if ((action.operation === 'borrow' || action.operation === 'repay') && action.interestRateMode !== 2) {
            return invalid(
                fingerprint,
                'AAVE_INTEREST_RATE_MODE_NOT_ALLOWED',
                'Only Aave variable-rate debt mode 2 is supported.'
            );
        }
        if (
            eMode !== 0n &&
            ['supply', 'withdraw', 'enable-collateral', 'disable-collateral'].includes(action.operation)
        ) {
            return invalid(
                fingerprint,
                'AAVE_EMODE_NOT_SUPPORTED',
                'Collateral-changing operations for an Aave eMode account are not supported.'
            );
        }
        const [scaledATokenBalance, scaledVariableDebt] = await client.multicall({
            allowFailure: false,
            blockNumber: block.number,
            multicallAddress: MULTICALL3,
            contracts: [
                {
                    address: getAddress(reserveTokens[0]),
                    abi: scaledTokenAbi,
                    functionName: 'scaledBalanceOf' as const,
                    args: [account]
                },
                {
                    address: getAddress(reserveTokens[2]),
                    abi: scaledTokenAbi,
                    functionName: 'scaledBalanceOf' as const,
                    args: [account]
                }
            ]
        });
        const aTokenBalance = userReserve[0];
        const stableDebt = userReserve[1];
        const variableDebt = userReserve[2];
        const collateralBefore = userReserve[8];
        let amount = action.amount?.mode === 'all' ? undefined : BigInt(action.amount?.value ?? '0');
        if (action.operation === 'withdraw') amount = amount ?? aTokenBalance;
        if (action.operation === 'repay')
            amount = amount === undefined || amount > variableDebt ? variableDebt : amount;
        amount ??= 0n;
        if (amount === 0n && action.amount) {
            return invalid(fingerprint, 'AAVE_PRECHECK_FAILED', 'Aave operation resolves to a zero amount.');
        }
        if (action.operation === 'withdraw' && amount > aTokenBalance) {
            return invalid(fingerprint, 'AAVE_PRECHECK_FAILED', 'Aave withdrawal exceeds the verified aToken balance.');
        }
        const unit = 10n ** BigInt(reserve.decimals);
        if (
            action.operation === 'supply' &&
            BigInt(reserve.supplyCap) !== 0n &&
            reserveData[2] + amount > BigInt(reserve.supplyCap) * unit
        ) {
            return invalid(fingerprint, 'AAVE_SUPPLY_CAP_EXCEEDED', 'Aave supply would exceed the reserve cap.');
        }
        if (
            action.operation === 'borrow' &&
            BigInt(reserve.borrowCap) !== 0n &&
            reserveData[3] + reserveData[4] + amount > BigInt(reserve.borrowCap) * unit
        ) {
            return invalid(fingerprint, 'AAVE_BORROW_CAP_EXCEEDED', 'Aave borrowing would exceed the reserve cap.');
        }
        if (assetPrice === 0n) throw new Error('Missing Aave oracle price');
        let scaledATokenAfter = scaledATokenBalance;
        let scaledVariableDebtAfter = scaledVariableDebt;
        let aTokenAfter = aTokenBalance;
        let variableDebtAfter = variableDebt;
        let collateralAfter = collateralBefore;
        if (action.operation === 'supply') {
            const minted = rayDivFloor(amount, liquidityIndex);
            if (minted === 0n) {
                return invalid(fingerprint, 'AAVE_PRECHECK_FAILED', 'Aave supply rounds to zero aToken shares.');
            }
            scaledATokenAfter += minted;
            aTokenAfter = rayMulFloor(scaledATokenAfter, liquidityIndex);
            if (!collateralBefore && aTokenBalance === 0n && BigInt(reserve.ltv) !== 0n) collateralAfter = true;
        } else if (action.operation === 'withdraw') {
            if (amount === aTokenBalance) {
                scaledATokenAfter = 0n;
                aTokenAfter = 0n;
                collateralAfter = false;
            } else {
                const burned = rayDivCeil(amount, liquidityIndex);
                if (burned > scaledATokenBalance) {
                    return invalid(
                        fingerprint,
                        'AAVE_PRECHECK_FAILED',
                        'Aave withdrawal exceeds the verified scaled aToken balance.'
                    );
                }
                scaledATokenAfter -= burned;
                aTokenAfter = rayMulFloor(scaledATokenAfter, liquidityIndex);
            }
        } else if (action.operation === 'borrow') {
            scaledVariableDebtAfter += rayDivCeil(amount, variableBorrowIndex);
            variableDebtAfter = rayMulCeil(scaledVariableDebtAfter, variableBorrowIndex);
        } else if (action.operation === 'repay') {
            if (amount === variableDebt) {
                scaledVariableDebtAfter = 0n;
                variableDebtAfter = 0n;
            } else {
                const burned = rayDivFloor(amount, variableBorrowIndex);
                if (burned > scaledVariableDebt) {
                    return invalid(
                        fingerprint,
                        'AAVE_PRECHECK_FAILED',
                        'Aave repayment exceeds the verified scaled variable debt.'
                    );
                }
                scaledVariableDebtAfter -= burned;
                variableDebtAfter = rayMulCeil(scaledVariableDebtAfter, variableBorrowIndex);
            }
        } else if (action.operation === 'enable-collateral' && !collateralBefore) {
            collateralAfter = true;
        } else if (action.operation === 'disable-collateral' && collateralBefore) {
            collateralAfter = false;
        }
        const collateralBeforeBase = collateralBefore ? (aTokenBalance * assetPrice) / unit : 0n;
        const collateralAfterBase = collateralAfter ? (aTokenAfter * assetPrice) / unit : 0n;
        const collateralDeltaBase = collateralAfterBase - collateralBeforeBase;
        const debtBeforeBase = (variableDebt * assetPrice) / unit;
        const debtAfterBase = (variableDebtAfter * assetPrice) / unit;
        const debtDeltaBase = debtAfterBase - debtBeforeBase;
        const before = accountData(rawAccount);
        const after = projectedAccount(before, reserve, collateralDeltaBase, debtDeltaBase);
        if (!after) return invalid(fingerprint, 'AAVE_PRECHECK_FAILED', 'Aave projected account state is invalid.');
        const exposure: AaveExposure = {
            actionIndex: action.index,
            operation: action.operation,
            asset: action.asset,
            account,
            recipient: action.recipient ?? account,
            amount: amount.toString(),
            aToken: getAddress(reserveTokens[0]) as Address,
            variableDebtToken: getAddress(reserveTokens[2]) as Address,
            liquidityIndex: liquidityIndex.toString(),
            variableBorrowIndex: variableBorrowIndex.toString(),
            scaledATokenBalanceBefore: scaledATokenBalance.toString(),
            scaledATokenBalanceAfter: scaledATokenAfter.toString(),
            scaledVariableDebtBefore: scaledVariableDebt.toString(),
            scaledVariableDebtAfter: scaledVariableDebtAfter.toString(),
            aTokenBalanceBefore: aTokenBalance.toString(),
            aTokenBalanceAfter: aTokenAfter.toString(),
            variableDebtBefore: variableDebt.toString(),
            variableDebtAfter: variableDebtAfter.toString(),
            totalATokenBefore: reserveData[2].toString(),
            totalStableDebtBefore: reserveData[3].toString(),
            totalVariableDebtBefore: reserveData[4].toString(),
            collateralEnabledBefore: collateralBefore,
            collateralEnabledAfter: collateralAfter,
            reserve,
            accountBefore: before,
            accountAfter: after
        };
        if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash)
            throw new Error('Block changed');
        return {
            transactionFingerprint: fingerprint,
            status: 'ready',
            blockNumber: block.number.toString(),
            blockHash: block.hash,
            blockTimestamp: Number(block.timestamp),
            exposures: [exposure]
        };
    } catch {
        return {
            transactionFingerprint: fingerprint,
            status: 'unavailable',
            exposures: [],
            error: 'Unable to verify Aave reserve, account and oracle state at a fixed block.'
        };
    }
}

export function aaveStateMatches(
    intent: IntentAnalysis,
    state: AavePreflight | undefined,
    simulation: SimulationResult
): boolean {
    return (
        state?.status === 'ready' &&
        state.transactionFingerprint === intent.transactionFingerprint &&
        simulation.attempted &&
        simulation.success &&
        simulation.transactionFingerprint === state.transactionFingerprint &&
        simulation.blockNumber === state.blockNumber &&
        simulation.blockHash === state.blockHash &&
        intent.actions.every(
            (action) =>
                action.kind !== 'aave' ||
                state.exposures.some(
                    (entry) =>
                        entry.actionIndex === action.index && entry.asset.toLowerCase() === action.asset.toLowerCase()
                )
        )
    );
}

export function resolveAaveIntent(
    intent: IntentAnalysis,
    state: AavePreflight,
    simulation: SimulationResult
): IntentAnalysis {
    if (!aaveStateMatches(intent, state, simulation)) return intent;
    const actions = intent.actions.map((candidate) => {
        if (candidate.kind !== 'aave') return candidate;
        const exposure = state.exposures.find((entry) => entry.actionIndex === candidate.index)!;
        return {
            ...candidate,
            ...(candidate.amount ? { amount: { value: exposure.amount, mode: 'exact' as const } } : {}),
            receiptToken: exposure.aToken,
            variableDebtToken: exposure.variableDebtToken
        };
    });
    return {
        ...intent,
        actions,
        expectedBalanceChanges: actions.flatMap((action) => {
            if (action.kind !== 'aave') return [];
            const exposure = state.exposures.find((entry) => entry.actionIndex === action.index);
            return aaveBalanceChanges(action, exposure);
        }),
        warnings: [
            'Aave balance and health-factor changes are conditional projections at the verified fixed block.',
            'aToken and variable-debt changes apply the Pool revision 11 floor and ceiling rules at the verified indexes.'
        ]
    };
}
