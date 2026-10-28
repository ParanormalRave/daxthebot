/*
HAND-COMPUTED WORKED EXAMPLE:
-----------------------------
Inputs:
  solPrice = 200.0
  tradeSizeUsd = 1.8
  ataRentSol = 0.00203928 -> ataRentUsd = 0.00203928 * 200 = 0.407856
  swapNetworkFeeSol = 0.00015 -> networkFeeUsd = 0.00015 * 200 = 0.03
  dexFeeBps = 25 -> dexFeeUsd = 1.8 * 25 / 10000 = 0.0045
  Cash debit on buy = 1.8 + 0.0045 + 0.03 + 0.407856 = 2.242356
  costBasisUsd = 1.8 + 0.0045 + 0.03 = 1.8345 (rent excluded)

Buy Fill:
  observedPrice = 0.000010 (first observation, single price)
  entrySlippageBps = 150 -> slippageMult = 1 + 150/10000 = 1.015
  liquidityUsd = 20000 -> R = 10000
  impactMult = 1 + 1.8 / 10000 = 1.00018
  fillPrice = 0.000010 * 1.015 * 1.00018 = 0.000010151827
  qty = notional / fillPrice = 1.8 / 0.000010151827 = 177308.01257406403

TP1 Sell (gain = +100% at observedPrice = 0.000020303654):
  sellPercentOfHoldings = 80% (0.80)
  qtySold = 177308.01257406403 * 0.8 = 141846.41005925123
  costBasisSold = 1.8345 * 0.8 = 1.4676
  base price = 0.000020303654 (assume both recent observations are 0.000020303654)
  normalExitSlippageBps = 150 -> 1 - 0.015 = 0.985
  grossValue = 141846.41005925123 * 0.000020303654 * 0.985 = 2.8368
  liquidityUsd = 25000 -> R = 12500
  impactFactor = 1 - 2.8368 / (12500 + 2.8368) = 1 - 0.0002268903565 = 0.9997731096435
  dexFee = 2.8368 * 25 / 10000 = 0.007092
  networkFee = 0.03
  proceeds = 2.8368 * 0.9997731096435 - 0.007092 - 0.03 = 2.836156337436681 - 0.037092 = 2.799064337436681
  pnl = 2.799064337436681 - 1.4676 = +1.331464337436681
  qtyRemaining = 35461.6025148128
  costBasisRemainingUsd = 0.3669
  rent locked remains 0.407856 (not released until 100% closed)
*/

import { numOrNull, positiveOrNull } from './util.js';

// Calculate fee and rent costs from SOL price and notional
function calculateCosts(config, solPrice, notional) {
  const ataRentSol = config.paper.ataRentSol;
  const swapNetworkFeeSol = config.paper.swapNetworkFeeSol;
  const dexFeeBps = config.paper.dexFeeBps;

  const ataRentUsd = ataRentSol * solPrice;
  const networkFeeUsd = swapNetworkFeeSol * solPrice;
  const dexFeeUsd = notional * (dexFeeBps / 10000);

  return { ataRentUsd, networkFeeUsd, dexFeeUsd };
}

// Check if paper account has available cash and slot for a new position
export function canAfford(state, config, mint, solPrice) {
  if (!state || typeof state !== 'object') {
    throw new Error('canAfford: state must be an object');
  }
  if (!config || !config.paper) {
    throw new Error('canAfford: config must contain paper settings');
  }
  if (typeof mint !== 'string' || mint.trim().length === 0) {
    throw new Error('canAfford: mint must be a non-empty string');
  }
  const sol = positiveOrNull(solPrice);
  if (sol === null) {
    throw new Error(`canAfford: solPrice must be a positive number, got ${solPrice}`);
  }

  // No open position for this mint
  if (state.positions && state.positions[mint]) {
    return false;
  }

  // Open positions count under maxConcurrentPositions
  const openCount = state.positions ? Object.keys(state.positions).length : 0;
  if (openCount >= config.paper.maxConcurrentPositions) {
    return false;
  }

  const notional = config.paper.tradeSizeUsd;
  const { ataRentUsd, networkFeeUsd, dexFeeUsd } = calculateCosts(config, sol, notional);
  const requiredCash = notional + ataRentUsd + networkFeeUsd + dexFeeUsd;
  const remainingCash = state.cashUsd - requiredCash;

  return remainingCash >= config.paper.minSolGasBufferUsd;
}

// Compute fill price, quantity and debits for a buy order
export function computeBuyFill(prices, liquidityUsd, notional, config, solPrice) {
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new Error('computeBuyFill: prices must be a non-empty array');
  }
  const cleanPrices = prices.map(numOrNull).filter((p) => p !== null && p > 0);
  if (cleanPrices.length === 0) {
    throw new Error('computeBuyFill: at least one positive price required');
  }
  const liq = positiveOrNull(liquidityUsd);
  if (liq === null) {
    return null; // Missing or non-positive liquidity refuses entry
  }
  const n = positiveOrNull(notional);
  if (n === null) {
    throw new Error(`computeBuyFill: notional must be positive, got ${notional}`);
  }
  const sol = positiveOrNull(solPrice);
  if (sol === null) {
    throw new Error(`computeBuyFill: solPrice must be positive, got ${solPrice}`);
  }

  const recent = cleanPrices.slice(-2);
  const basePrice = Math.max(...recent);
  const R = liq / 2;
  const slippageMult = 1 + config.paper.entrySlippageBps / 10000;
  const impactMult = config.paper.modelConstantProductPriceImpact ? 1 + n / R : 1;
  const fillPrice = basePrice * slippageMult * impactMult;
  const qty = n / fillPrice;

  const { ataRentUsd, networkFeeUsd, dexFeeUsd } = calculateCosts(config, sol, n);
  const cashDebit = n + dexFeeUsd + networkFeeUsd + ataRentUsd;
  const costBasisUsd = n + dexFeeUsd + networkFeeUsd;

  return {
    fillPrice,
    basePrice,
    qty,
    cashDebit,
    costBasisUsd,
    ataRentUsd,
    networkFeeUsd,
    dexFeeUsd,
  };
}

// Compute fill price and proceeds for a sell order
export function computeSellFill(qtyToSell, prices, liquidityUsd, exitKind, config, solPrice) {
  const qty = positiveOrNull(qtyToSell);
  if (qty === null) {
    throw new Error(`computeSellFill: qtyToSell must be positive, got ${qtyToSell}`);
  }
  if (!Array.isArray(prices) || prices.length === 0) {
    throw new Error('computeSellFill: prices must be a non-empty array');
  }
  const cleanPrices = prices.map(numOrNull).filter((p) => p !== null && p > 0);
  if (cleanPrices.length === 0) {
    throw new Error('computeSellFill: at least one positive price required');
  }
  const liq = positiveOrNull(liquidityUsd);
  if (liq === null) {
    throw new Error('computeSellFill: sell requires positive liquidity');
  }
  const sol = positiveOrNull(solPrice);
  if (sol === null) {
    throw new Error(`computeSellFill: solPrice must be positive, got ${solPrice}`);
  }

  const recent = cleanPrices.slice(-2);
  const basePrice = Math.min(...recent);

  const slippageBps = exitKind === 'STOP' ? config.paper.stopExitSlippageBps : config.paper.normalExitSlippageBps;
  const slippageFactor = 1 - slippageBps / 10000;
  const grossValue = qty * basePrice * slippageFactor;

  const R = liq / 2;
  const impactFactor = config.paper.modelConstantProductPriceImpact
    ? 1 - grossValue / (R + grossValue)
    : 1;

  const dexFeeUsd = grossValue * (config.paper.dexFeeBps / 10000);
  const networkFeeUsd = config.paper.swapNetworkFeeSol * solPrice;

  const proceeds = Math.max(0, grossValue * impactFactor - dexFeeUsd - networkFeeUsd);
  const effectiveFillPrice = qty > 0 ? proceeds / qty : 0;

  return {
    fillPrice: effectiveFillPrice,
    basePrice,
    grossValue,
    proceeds,
    dexFeeUsd,
    networkFeeUsd,
  };
}

// Compute emergency recovery proceeds for a confirmed rug
export function computeRugFill(costBasisRemainingUsd, config, solPrice) {
  const basis = positiveOrNull(costBasisRemainingUsd);
  if (basis === null) {
    return { proceeds: 0, recoveryGrossUsd: 0, dexFeeUsd: 0, networkFeeUsd: 0 };
  }
  const sol = positiveOrNull(solPrice);
  if (sol === null) {
    throw new Error(`computeRugFill: solPrice must be positive, got ${solPrice}`);
  }

  const recoveryGrossUsd = config.rug.recoveryFractionOfRemainingCost * basis;
  const dexFeeUsd = recoveryGrossUsd * (config.paper.dexFeeBps / 10000);
  const networkFeeUsd = config.paper.swapNetworkFeeSol * solPrice;

  const proceeds = Math.max(0, recoveryGrossUsd - dexFeeUsd - networkFeeUsd);

  return {
    proceeds,
    recoveryGrossUsd,
    dexFeeUsd,
    networkFeeUsd,
  };
}

// Create and record a new open paper position into state
export function openPosition(state, mint, pairAddress, fill, liquidityUsd, nowMs) {
  if (!state || typeof state !== 'object' || !state.positions) {
    throw new Error('openPosition: invalid state object');
  }
  if (typeof mint !== 'string' || mint.trim().length === 0) {
    throw new Error('openPosition: mint must be a non-empty string');
  }
  if (typeof pairAddress !== 'string' || pairAddress.trim().length === 0) {
    throw new Error('openPosition: pairAddress must be a non-empty string');
  }
  if (!fill || typeof fill !== 'object') {
    throw new Error('openPosition: fill must be an object');
  }

  state.cashUsd -= fill.cashDebit;
  state.lockedAtaRentUsd += fill.ataRentUsd;

  const position = {
    mint,
    pairAddress,
    entryAtMs: nowMs,
    entryPrice: fill.fillPrice,
    entryLiquidityUsd: liquidityUsd,
    qtyRemaining: fill.qty,
    costBasisRemainingUsd: fill.costBasisUsd,
    peakPrice: fill.basePrice,
    tp1Done: false,
    rentLockedUsd: fill.ataRentUsd,
    lastPrice: fill.basePrice,
    priceHistory: [fill.basePrice],
    liqBadStreak: 0,
  };

  state.positions[mint] = position;
  return position;
}

// Evaluate position against exit rules and return updated position copy and exit decision
export function evaluateExits(position, obs, nowMs, config) {
  if (!position || typeof position !== 'object') {
    throw new Error('evaluateExits: position must be an object');
  }
  if (!obs || typeof obs !== 'object') {
    throw new Error('evaluateExits: obs must be an object');
  }
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error(`evaluateExits: nowMs must be finite number, got ${nowMs}`);
  }
  if (!config || !config.exits || !config.rug) {
    throw new Error('evaluateExits: config must contain exits and rug settings');
  }

  const p = {
    ...position,
    priceHistory: Array.isArray(position.priceHistory) ? [...position.priceHistory] : [],
  };

  const pairPresent = obs.pairPresent === true;
  const price = numOrNull(obs.priceUsd);
  const liq = numOrNull(obs.liquidityUsd);
  const pcM5 = numOrNull(obs.priceChangeM5);

  // 1. Check for missing pair or null/zero liquidity (bad reading streak)
  const isBadReading = !pairPresent || liq === null || liq <= 0;
  if (isBadReading) {
    p.liqBadStreak = (p.liqBadStreak || 0) + 1;
    const confirmTarget = config.rug.confirmObservationsForMissingLiquidity;
    if (p.liqBadStreak >= confirmTarget) {
      return {
        position: p,
        decision: {
          type: 'EXIT',
          reason: 'RUG',
          fraction: 1.0,
          exitKind: 'RUG',
        },
      };
    }
    return {
      position: p,
      decision: { type: 'HOLD_UNKNOWN' },
    };
  }

  // Reading is good: reset bad liquidity streak
  p.liqBadStreak = 0;

  // 2. Immediate numeric rug triggers
  if (liq < config.rug.triggerIfLiquidityUsdBelow) {
    return {
      position: p,
      decision: { type: 'EXIT', reason: 'RUG', fraction: 1.0, exitKind: 'RUG' },
    };
  }
  if (p.entryLiquidityUsd !== null && p.entryLiquidityUsd > 0) {
    const liqDropPct = ((p.entryLiquidityUsd - liq) / p.entryLiquidityUsd) * 100;
    if (liqDropPct >= config.rug.triggerIfLiquidityDropFromEntryPercent) {
      return {
        position: p,
        decision: { type: 'EXIT', reason: 'RUG', fraction: 1.0, exitKind: 'RUG' },
      };
    }
  }
  if (pcM5 !== null && pcM5 <= config.rug.triggerIfPriceChange5mAtOrBelowPercent) {
    return {
      position: p,
      decision: { type: 'EXIT', reason: 'RUG', fraction: 1.0, exitKind: 'RUG' },
    };
  }

  // Price must be known for normal exit evaluation
  if (price === null || price <= 0) {
    return {
      position: p,
      decision: { type: 'HOLD_UNKNOWN' },
    };
  }

  // Update price history and lastPrice
  p.lastPrice = price;
  p.priceHistory.push(price);
  if (p.priceHistory.length > 2) {
    p.priceHistory = p.priceHistory.slice(-2);
  }

  // Update peak price BEFORE evaluating exits
  if (p.peakPrice === null || price > p.peakPrice) {
    p.peakPrice = price;
  }

  const gainPercent = ((price / p.entryPrice) - 1) * 100;
  const peakGainPercent = ((p.peakPrice / p.entryPrice) - 1) * 100;
  const holdMinutes = (nowMs - p.entryAtMs) / 60000;

  // Priority walk
  const priorityList = config.exits.exitPriority;
  const visitedGroups = new Set();

  for (const item of priorityList) {
    // Treat stops as one combined group
    if (item === 'HARD_STOP' || item === 'TRAILING_STOP' || item === 'BREAKEVEN_STOP') {
      if (visitedGroups.has('STOPS')) continue;
      visitedGroups.add('STOPS');

      let activeStopPrice = -Infinity;
      let stopReason = null;

      // Hard stop (gain <= hardStopPercent)
      const hardStopPrice = p.entryPrice * (1 + config.exits.hardStopPercent / 100);
      activeStopPrice = hardStopPrice;
      stopReason = 'HARD_STOP';

      // Breakeven stop
      if (peakGainPercent >= config.exits.breakevenStop.armAtGainPercent) {
        const beStopPrice = p.entryPrice * (1 + config.exits.breakevenStop.lockAtGainPercent / 100);
        if (beStopPrice >= activeStopPrice) {
          activeStopPrice = beStopPrice;
          stopReason = 'BREAKEVEN_STOP';
        }
      }

      // Trailing stop
      const trailDist = p.tp1Done
        ? config.exits.moonbag.trailDistanceFromPeakPercent
        : config.exits.trailingStop.trailDistanceFromPeakPercent;
      const trailArmed = p.tp1Done || peakGainPercent >= config.exits.trailingStop.armAtGainPercent;

      if (trailArmed) {
        const trailStopPrice = p.peakPrice * (1 - trailDist / 100);
        // Ties resolve: trailing, then breakeven, then hard
        if (trailStopPrice >= activeStopPrice) {
          activeStopPrice = trailStopPrice;
          stopReason = 'TRAILING_STOP';
        }
      }

      if (price <= activeStopPrice) {
        return {
          position: p,
          decision: {
            type: 'EXIT',
            reason: stopReason,
            fraction: 1.0,
            exitKind: 'STOP',
          },
        };
      }
      continue;
    }

    if (item === 'MAX_HOLD') {
      if (holdMinutes >= config.exits.maxHoldMinutes) {
        return {
          position: p,
          decision: {
            type: 'EXIT',
            reason: 'MAX_HOLD',
            fraction: 1.0,
            exitKind: 'NORMAL',
          },
        };
      }
      continue;
    }

    if (item === 'STAGNANT_STOP') {
      const stag = config.exits.stagnantStop;
      const checkDue = holdMinutes >= stag.checkAfterMinutes;
      const gainLow = gainPercent < stag.minGainPercent;
      const peakNotReached = peakGainPercent < stag.skipIfPeakGainAtOrAbovePercent;
      if (checkDue && gainLow && peakNotReached && !p.tp1Done) {
        return {
          position: p,
          decision: {
            type: 'EXIT',
            reason: 'STAGNANT_STOP',
            fraction: 1.0,
            exitKind: 'NORMAL',
          },
        };
      }
      continue;
    }

    if (item === 'TAKE_PROFIT_2') {
      if (gainPercent >= config.exits.takeProfit2.gainPercent) {
        return {
          position: p,
          decision: {
            type: 'EXIT',
            reason: 'TAKE_PROFIT_2',
            fraction: 1.0,
            exitKind: 'NORMAL',
          },
        };
      }
      continue;
    }

    if (item === 'TAKE_PROFIT_1') {
      if (!p.tp1Done && gainPercent >= config.exits.takeProfit1.gainPercent) {
        return {
          position: p,
          decision: {
            type: 'EXIT',
            reason: 'TAKE_PROFIT_1',
            fraction: config.exits.takeProfit1.sellPercentOfHoldings / 100,
            exitKind: 'NORMAL',
          },
        };
      }
      continue;
    }
  }

  return {
    position: p,
    decision: { type: 'HOLD' },
  };
}

// Apply trade proceeds and position shrinkage or full closure to state
export function closeFraction(state, position, fraction, fill, reason, nowIso) {
  if (!state || typeof state !== 'object' || !state.positions) {
    throw new Error('closeFraction: invalid state object');
  }
  if (!position || typeof position !== 'object') {
    throw new Error('closeFraction: invalid position object');
  }
  const f = numOrNull(fraction);
  if (f === null || f <= 0 || f > 1.0) {
    throw new Error(`closeFraction: fraction must be in (0, 1], got ${fraction}`);
  }
  if (!fill || typeof fill !== 'object') {
    throw new Error('closeFraction: fill must be an object');
  }

  const proceeds = fill.proceeds || 0;
  const costBasisSold = position.costBasisRemainingUsd * f;
  const pnlUsd = proceeds - costBasisSold;

  state.cashUsd += proceeds;
  state.realizedPnlUsd += pnlUsd;

  const isFullClose = f >= 0.999999 || position.qtyRemaining <= 0;

  if (isFullClose || reason === 'RUG') {
    state.cashUsd += position.rentLockedUsd;
    state.lockedAtaRentUsd -= position.rentLockedUsd;
    state.ataRentReleaseEvents += 1;
    state.closedTrades += 1;
    delete state.positions[position.mint];
  } else {
    // Partial close (e.g. TP1)
    position.qtyRemaining -= position.qtyRemaining * f;
    position.costBasisRemainingUsd -= costBasisSold;

    if (reason === 'TAKE_PROFIT_1') {
      position.tp1Done = true;
      if (fill.fillPrice && fill.fillPrice > 0) {
        position.peakPrice = fill.fillPrice;
      }
    }
  }

  return {
    pnlUsd,
    proceeds,
    costBasisSold,
    isFullClose,
  };
}

// Calculate current cost-basis and marked equity points
export function equityPoint(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('equityPoint: invalid state object');
  }
  let sumCostBasis = 0;
  let sumMarkValue = 0;

  if (state.positions) {
    for (const pos of Object.values(state.positions)) {
      sumCostBasis += pos.costBasisRemainingUsd || 0;
      const lastPrice = pos.lastPrice || pos.entryPrice || 0;
      sumMarkValue += (pos.qtyRemaining || 0) * lastPrice;
    }
  }

  const equityCostBasisUsd = state.cashUsd + state.lockedAtaRentUsd + sumCostBasis;
  const equityMarkUsd = state.cashUsd + state.lockedAtaRentUsd + sumMarkValue;

  return {
    equityCostBasisUsd,
    equityMarkUsd,
  };
}

// Verify that ATA rent and cash accounting invariants strictly hold
export function checkRentInvariant(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('checkRentInvariant: invalid state object');
  }

  let expectedRent = 0;
  if (state.positions) {
    for (const pos of Object.values(state.positions)) {
      expectedRent += pos.rentLockedUsd || 0;
    }
  }

  // Tolerance check for floating point sum comparison
  if (Math.abs(state.lockedAtaRentUsd - expectedRent) > 0.000001) {
    throw new Error(
      `Rent invariant broken: lockedAtaRentUsd (${state.lockedAtaRentUsd}) != positions rent sum (${expectedRent})`,
    );
  }

  if (state.ataRentReleaseEvents !== state.closedTrades) {
    throw new Error(
      `Rent release events (${state.ataRentReleaseEvents}) != closed trades (${state.closedTrades})`,
    );
  }

  if (state.cashUsd < 0) {
    throw new Error(`Cash balance invariant broken: cashUsd (${state.cashUsd}) < 0`);
  }

  return true;
}
