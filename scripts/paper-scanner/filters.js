import { numOrNull } from "./util.js";

// Extract raw metrics from a DexScreener pair object
export function readMetrics(pair, nowMs) {
  if (!pair || typeof pair !== "object") {
    return {
      ageMinutes: null,
      liquidityUsd: null,
      fdv: null,
      volumeM5: null,
      volumeH1: null,
      buys5m: null,
      sells5m: null,
      priceChangeM5: null,
      priceChangeH1: null,
      dexId: null,
    };
  }

  const pairCreatedAt = numOrNull(pair.pairCreatedAt);
  let ageMinutes = null;
  if (
    pairCreatedAt !== null &&
    typeof nowMs === "number"
  ) {
    ageMinutes = (nowMs - pairCreatedAt) / 60000;
  }

  return {
    ageMinutes,
    liquidityUsd: numOrNull(pair.liquidity?.usd),
    fdv: numOrNull(pair.fdv),
    volumeM5: numOrNull(pair.volume?.m5),
    volumeH1: numOrNull(pair.volume?.h1),
    buys5m: numOrNull(pair.txns?.m5?.buys),
    sells5m: numOrNull(pair.txns?.m5?.sells),
    priceChangeM5: numOrNull(pair.priceChange?.m5),
    priceChangeH1: numOrNull(pair.priceChange?.h1),
    dexId:
      typeof pair.dexId === "string" && pair.dexId.trim().length > 0
        ? pair.dexId.trim()
        : null,
  };
}

// Evaluate entry filter rules against a DexScreener pair
export function evaluateEntryFilter(pair, config, nowMs) {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new Error(`evaluateEntryFilter requires finite nowMs, got ${nowMs}`);
  }
  if (!config || !config.entryFilter) {
    throw new Error("evaluateEntryFilter requires config with entryFilter");
  }

  const filter = config.entryFilter;
  const metrics = readMetrics(pair, nowMs);
  const failedRules = [];
  let missingData = false;

  // Helper to record a missing field when rejectOnNull is enabled
  const checkMissing = (value, fieldName) => {
    if (value === null) {
      missingData = true;
      if (
        filter.rejectOnNull &&
        !failedRules.includes(`missing:${fieldName}`)
      ) {
        failedRules.push(`missing:${fieldName}`);
      }
      return true;
    }
    return false;
  };

  // Rule: dex_not_tradable
  if (checkMissing(metrics.dexId, "dexId")) {
    // Missing already handled
  } else {
    const tradable = Array.isArray(filter.tradableDexIds)
      ? filter.tradableDexIds
      : [];
    if (!tradable.includes(metrics.dexId)) {
      failedRules.push("dex_not_tradable");
    }
  }

  // Rules: age_min, age_max
  if (!checkMissing(metrics.ageMinutes, "ageMinutes")) {
    if (
      typeof filter.pairAgeMinutes?.min === "number" &&
      metrics.ageMinutes < filter.pairAgeMinutes.min
    ) {
      failedRules.push("age_min");
    }
    if (
      typeof filter.pairAgeMinutes?.max === "number" &&
      metrics.ageMinutes > filter.pairAgeMinutes.max
    ) {
      failedRules.push("age_max");
    }
  }

  // Rules: liquidity_min, liquidity_max
  if (!checkMissing(metrics.liquidityUsd, "liquidityUsd")) {
    if (
      typeof filter.liquidityUsd?.min === "number" &&
      metrics.liquidityUsd < filter.liquidityUsd.min
    ) {
      failedRules.push("liquidity_min");
    }
    if (
      typeof filter.liquidityUsd?.max === "number" &&
      metrics.liquidityUsd > filter.liquidityUsd.max
    ) {
      failedRules.push("liquidity_max");
    }
  }

  // Rules: fdv_min, fdv_max
  if (!checkMissing(metrics.fdv, "fdv")) {
    if (
      typeof filter.fdvUsd?.min === "number" &&
      metrics.fdv < filter.fdvUsd.min
    ) {
      failedRules.push("fdv_min");
    }
    if (
      typeof filter.fdvUsd?.max === "number" &&
      metrics.fdv > filter.fdvUsd.max
    ) {
      failedRules.push("fdv_max");
    }
  }

  // Rule: fdv_to_liquidity_ratio
  if (metrics.fdv === null || metrics.liquidityUsd === null) {
    // Missing handled by individual field checks
  } else if (metrics.liquidityUsd <= 0) {
    failedRules.push("fdv_to_liquidity_ratio");
  } else {
    const ratio = metrics.fdv / metrics.liquidityUsd;
    if (
      typeof filter.maxFdvToLiquidityRatio === "number" &&
      ratio > filter.maxFdvToLiquidityRatio
    ) {
      failedRules.push("fdv_to_liquidity_ratio");
    }
  }

  // Rule: vol1h_to_liquidity_ratio
  if (metrics.volumeH1 === null || metrics.liquidityUsd === null) {
    // Missing handled by individual field checks
  } else if (metrics.liquidityUsd <= 0) {
    failedRules.push("vol1h_to_liquidity_ratio");
  } else {
    const ratio = metrics.volumeH1 / metrics.liquidityUsd;
    if (
      typeof filter.minVolume1hToLiquidityRatio === "number" &&
      ratio < filter.minVolume1hToLiquidityRatio
    ) {
      failedRules.push("vol1h_to_liquidity_ratio");
    }
  }

  // Rules: volume5m_min, volume1h_min
  if (!checkMissing(metrics.volumeM5, "volumeM5")) {
    if (
      typeof filter.volumeUsd?.min5m === "number" &&
      metrics.volumeM5 < filter.volumeUsd.min5m
    ) {
      failedRules.push("volume5m_min");
    }
  }
  if (!checkMissing(metrics.volumeH1, "volumeH1")) {
    if (
      typeof filter.volumeUsd?.min1h === "number" &&
      metrics.volumeH1 < filter.volumeUsd.min1h
    ) {
      failedRules.push("volume1h_min");
    }
  }

  // Rule: buys5m_min
  if (!checkMissing(metrics.buys5m, "buys5m")) {
    if (
      typeof filter.minBuys5m === "number" &&
      metrics.buys5m < filter.minBuys5m
    ) {
      failedRules.push("buys5m_min");
    }
  }

  // Rule: buy_sell_ratio
  const hasBuys = !checkMissing(metrics.buys5m, "buys5m");
  const hasSells = !checkMissing(metrics.sells5m, "sells5m");
  if (hasBuys && hasSells) {
    if (metrics.sells5m === 0 && metrics.buys5m > 0) {
      // Passes per spec: "If sells5m==0 and buys5m>0 the buy/sell ratio passes."
    } else if (metrics.sells5m <= 0) {
      failedRules.push("buy_sell_ratio");
    } else {
      const ratio = metrics.buys5m / metrics.sells5m;
      if (
        typeof filter.minBuyToSellRatio5m === "number" &&
        ratio < filter.minBuyToSellRatio5m
      ) {
        failedRules.push("buy_sell_ratio");
      }
    }
  }

  // Rules: price5m_min, price5m_max
  if (!checkMissing(metrics.priceChangeM5, "priceChangeM5")) {
    if (
      typeof filter.priceChangePercent?.min5m === "number" &&
      metrics.priceChangeM5 < filter.priceChangePercent.min5m
    ) {
      failedRules.push("price5m_min");
    }
    if (
      typeof filter.priceChangePercent?.max5m === "number" &&
      metrics.priceChangeM5 > filter.priceChangePercent.max5m
    ) {
      failedRules.push("price5m_max");
    }
  }

  // Rules: price1h_min, price1h_max
  if (!checkMissing(metrics.priceChangeH1, "priceChangeH1")) {
    if (
      typeof filter.priceChangePercent?.min1h === "number" &&
      metrics.priceChangeH1 < filter.priceChangePercent.min1h
    ) {
      failedRules.push("price1h_min");
    }
    if (
      typeof filter.priceChangePercent?.max1h === "number" &&
      metrics.priceChangeH1 > filter.priceChangePercent.max1h
    ) {
      failedRules.push("price1h_max");
    }
  }

  return {
    passed: failedRules.length === 0,
    failedRules,
    missingData,
    metrics,
  };
}
