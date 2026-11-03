import {
  canAfford,
  computeBuyFill,
  computeSellFill,
  computeRugFill,
  openPosition,
  evaluateExits,
  closeFraction,
  equityPoint,
  checkRentInvariant,
} from "./paperEngine.js";
import { evaluateEntryFilter } from "./filters.js";
import { createInitialState } from "./state.js";
import { pathToFileURL } from "node:url";

// Inline frozen fixture config matching data/paper-scanner/config.json
const FIXTURE_CONFIG = Object.freeze({
  strategyName: "dax-paper-scanner",
  version: "1.4.0-paper",
  mode: "PAPER_ONLY",
  paths: {
    stateFile: "data/paper-scanner/state.json",
    tradesLog: "data/paper-scanner/paper_trades.jsonl",
    observationsLog: "data/paper-scanner/observations.jsonl",
    snapshotsLog: "data/paper-scanner/price_snapshots.jsonl",
    rugCheckSamplesLog: "data/paper-scanner/rugcheck_samples.jsonl",
    summaryFile: "data/paper-scanner/summary.json",
  },
  polling: {
    discoveryIntervalSec: 60,
    positionCheckIntervalSec: 15,
    watchlistTickSec: 15,
    httpTimeoutMs: 8000,
    backoffOn429Sec: 20,
  },
  rateLimits: {
    geckoTerminalMaxReqPerMin: 10,
    geckoTerminalDelayBetweenPagesMs: 2500,
    dexScreenerProfilesMaxReqPerMin: 50,
    dexScreenerPairsMaxReqPerMin: 250,
    rugCheckMaxReqPerMin: 20,
    rugCheckDelayBetweenCallsMs: 2500,
  },
  discovery: {
    geckoTerminalNewPools: {
      enabled: true,
      url: "https://api.geckoterminal.com/api/v2/networks/solana/new_pools",
      pages: 3,
    },
    dexScreenerProfiles: {
      enabled: true,
      url: "https://api.dexscreener.com/token-profiles/latest/v1",
    },
    dexScreenerPairsBatchUrl: "https://api.dexscreener.com/tokens/v1/solana/",
    dexScreenerBatchSize: 30,
  },
  watchlist: {
    launchpadTtlMinutes: 180,
    ammCandidateTtlMinutes: 60,
    pollIntervalSecByState: {
      launchpadFirst60Min: 60,
      launchpadAfter60Min: 300,
      ammCandidate: 30,
    },
    snapshotOffsetsMinutes: [
      1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 150, 180,
    ],
    maxTrackedConcurrently: 3000,
    minReserveUsdToTrack: 1500,
    countDroppedPools: true,
    launchpadDexIdsRecordOnly: [
      "pump-fun",
      "raydium-launchlab",
      "stonkfun",
      "bags-fm",
      "letsbonk-fun",
      "meteora-dbc",
    ],
  },
  entryFilter: Object.freeze({
    chainId: "solana",
    tradableDexIds: ["raydium", "pumpswap", "meteora"],
    logUnknownDexIds: true,
    pairAgeMinutes: Object.freeze({ min: 3, max: 45 }),
    liquidityUsd: Object.freeze({ min: 12000, max: 85000 }),
    fdvUsd: Object.freeze({ min: 25000, max: 180000 }),
    maxFdvToLiquidityRatio: 4.5,
    minVolume1hToLiquidityRatio: 1.2,
    volumeUsd: Object.freeze({ min5m: 4000, min1h: 15000 }),
    minBuys5m: 35,
    minBuyToSellRatio5m: 1.4,
    priceChangePercent: Object.freeze({
      min5m: 4.0,
      max5m: 35.0,
      min1h: -15.0,
      max1h: 150.0,
    }),
    rejectOnNull: true,
  }),
  security: Object.freeze({
    rugCheckReportUrlTemplate:
      "https://api.rugcheck.xyz/v1/tokens/{mint}/report",
    onApiFailure: "reject_and_log",
    unknownAuthorityAction: "reject_and_log",
    requireMintAuthorityRevoked: true,
    requireFreezeAuthorityRevoked: true,
    excludePoolAndAmmAccountsFromHolders: true,
    maxTop10HoldersPercent: 28.0,
    maxSingleHolderPercent: 6.0,
    minLpLockedOrBurnedPercent: 0.0,
    saveFirstNRawReports: 25,
  }),
  paper: Object.freeze({
    startingCashUsd: 5.0,
    tradeSizeUsd: 1.7,
    maxConcurrentPositions: 2,
    minSolGasBufferUsd: 0.6,
    solPriceUsdFallback: 180.0,
    ataRentSol: 0.00203928,
    swapNetworkFeeSol: 0.00015,
    dexFeeBps: 25,
    entrySlippageBps: 150,
    normalExitSlippageBps: 150,
    stopExitSlippageBps: 350,
    modelConstantProductPriceImpact: true,
    fillModel: "worse_of_last_two_observed_prices",
  }),
  rug: Object.freeze({
    triggerIfPairMissing: true,
    triggerIfLiquidityNullOrZero: true,
    triggerIfLiquidityUsdBelow: 2000,
    triggerIfLiquidityDropFromEntryPercent: 70.0,
    triggerIfPriceChange5mAtOrBelowPercent: -80.0,
    recoveryFractionOfRemainingCost: 0.05,
    confirmObservationsForMissingLiquidity: 2,
  }),
  exits: Object.freeze({
    exitPriority: Object.freeze([
      "RUG",
      "HARD_STOP",
      "TRAILING_STOP",
      "BREAKEVEN_STOP",
      "MAX_HOLD",
      "STAGNANT_STOP",
      "TAKE_PROFIT_2",
      "TAKE_PROFIT_1",
    ]),
    hardStopPercent: -28.0,
    breakevenStop: Object.freeze({
      armAtGainPercent: 40.0,
      lockAtGainPercent: 5.0,
    }),
    stagnantStop: Object.freeze({
      checkAfterMinutes: 12,
      minGainPercent: 15.0,
      skipIfPeakGainAtOrAbovePercent: 40.0,
    }),
    trailingStop: Object.freeze({
      armAtGainPercent: 65.0,
      trailDistanceFromPeakPercent: 20.0,
      mode: "relative_to_peak_price",
    }),
    moonbag: Object.freeze({
      resetPeakAtTp1: true,
      trailDistanceFromPeakPercent: 30.0,
    }),
    maxHoldMinutes: 45,
    takeProfit1: Object.freeze({
      gainPercent: 100.0,
      sellPercentOfHoldings: 80.0,
    }),
    takeProfit2: Object.freeze({
      gainPercent: 250.0,
      sellPercentOfHoldings: 100.0,
    }),
  }),
  protocol: Object.freeze({
    locked: true,
    maxTrades: 50,
    maxDays: 7,
    minTradesForVerdict: 30,
    minExpectancyUsdPerTrade: 0.12,
    minProfitFactor: 1.35,
    maxRugRatePercent: 20,
    minBalanceFloorUsd: 3.0,
    maxMissingDataRejectRatePercent: 50,
  }),
});

// Helper for relative equality of numbers within 1e-9 tolerance
function assertNear(actual, expected, label, detailList) {
  if (
    typeof actual !== "number" ||
    typeof expected !== "number" ||
    !Number.isFinite(actual) ||
    !Number.isFinite(expected)
  ) {
    const ok = actual === expected;
    detailList.push(
      `${label}: expected ${expected}, got ${actual} [${ok ? "OK" : "FAIL"}]`,
    );
    return ok;
  }
  const diff = Math.abs(actual - expected);
  const rel = expected === 0 ? diff : diff / Math.abs(expected);
  const ok = rel < 1e-9;
  detailList.push(
    `${label}: expected ${expected}, got ${actual} (relDiff: ${rel.toExponential(2)}) [${ok ? "OK" : "FAIL"}]`,
  );
  return ok;
}

// Helper for exact equality (booleans, strings, exact values)
function assertEqual(actual, expected, label, detailList) {
  const ok = actual === expected;
  detailList.push(
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} [${ok ? "OK" : "FAIL"}]`,
  );
  return ok;
}

// Execute self-test suite and return results object
export function runSelftest() {
  const results = [];

  const addScenario = (name, testFn) => {
    const detailList = [];
    let ok = false;
    try {
      ok = testFn(detailList) === true;
    } catch (err) {
      ok = false;
      detailList.push(`EXCEPTION: ${err.message}`);
    }
    results.push({ name, ok, detail: detailList.join(" | ") });
  };

  // Scenario 1: buy fill, cash debit and cost basis (worked example)
  addScenario(
    "1: buy fill, cash debit and cost basis (worked example)",
    (d) => {
      // Hand math:
      // sol = 200, tradeSizeUsd = 1.8, ataRentSol = 0.00203928 -> ataRentUsd = 0.407856
      // swapNetworkFeeSol = 0.00015 -> networkFeeUsd = 0.03, dexFeeBps = 25 -> dexFeeUsd = 0.0045
      // cashDebit = 1.8 + 0.0045 + 0.03 + 0.407856 = 2.242356
      // costBasisUsd = 1.8 + 0.0045 + 0.03 = 1.8345
      // fillPrice = 0.00001 * (1 + 150/10000) * (1 + 1.8/10000) = 0.000010151827
      // qty = 1.8 / 0.000010151827 = 177307.98604034525
      const fill = computeBuyFill([0.00001], 20000, 1.8, FIXTURE_CONFIG, 200);
      const expCashDebit =
        1.8 + (1.8 * 25) / 10000 + 0.00015 * 200 + 0.00203928 * 200; // 2.242356
      const expCostBasisUsd = 1.8 + (1.8 * 25) / 10000 + 0.00015 * 200; // 1.8345
      const expFillPrice = 0.00001 * (1 + 150 / 10000) * (1 + 1.8 / 10000); // 0.000010151827
      const expQty = 1.8 / expFillPrice; // 177307.98604034525

      const ok1 = assertNear(fill.cashDebit, expCashDebit, "cashDebit", d);
      const ok2 = assertNear(
        fill.costBasisUsd,
        expCostBasisUsd,
        "costBasisUsd",
        d,
      );
      const ok3 = assertNear(fill.fillPrice, expFillPrice, "fillPrice", d);
      const ok4 = assertNear(fill.qty, expQty, "qty", d);
      return ok1 && ok2 && ok3 && ok4;
    },
  );

  // Scenario 2: TP1 partial sell proceeds and closeFraction accounting
  addScenario(
    "2: TP1 partial sell proceeds and closeFraction accounting",
    (d) => {
      // Hand math:
      // qtySold = 177307.98604034525 * 0.8 = 141846.3888322762
      // costBasisSold = 1.8345 * 0.8 = 1.4676
      // grossValue = 141846.3888322762 * 0.000020303654 * (1 - 150/10000) = 2.8368
      // impactFactor = 1 - 2.8368 / (12500 + 2.8368) = 0.9997731096435
      // dexFee = 2.8368 * 25 / 10000 = 0.007092, networkFee = 0.03
      // proceeds = 2.8368 * 0.9997731096435 - 0.007092 - 0.03 = 2.799064351333003
      // pnl = 2.799064351333003 - 1.4676 = 1.331464351333003
      const qtyTotal = 1.8 / (0.00001 * 1.015 * 1.00018);
      const sellFill = computeSellFill(
        qtyTotal * 0.8,
        [0.000020303654],
        25000,
        "NORMAL",
        FIXTURE_CONFIG,
        200,
      );
      const grossExp = 1.8 * 0.8 * 2 * 0.985; // tokens x price = 1.8 x 0.8 x 2 = 2.88 (the fill price cancels out), x 0.985 slippage = 2.8368
      const expProceeds =
        grossExp * (1 - grossExp / (12500 + grossExp)) -
        grossExp * 0.0025 -
        0.00015 * 200; // pool 25000 -> R = 12500, 0.25% dex fee, network fee 0.03

      const state = createInitialState(
        FIXTURE_CONFIG,
        "testHash",
        "2026-10-28T00:00:00.000Z",
      );
      const buyFill = computeBuyFill(
        [0.00001],
        20000,
        1.8,
        FIXTURE_CONFIG,
        200,
      );
      const pos = openPosition(state, "mint1", "pair1", buyFill, 20000, 1000);

      const closeRes = closeFraction(
        state,
        pos,
        0.8,
        sellFill,
        "TAKE_PROFIT_1",
        "2026-10-28T00:01:00.000Z",
      );

      const expCash = 5.0 - 2.242356 + expProceeds; // start cash, minus the buy debit worked out in scenario 1, plus the sale proceeds
      const expPnl = expProceeds - 1.8345 * 0.8; // proceeds minus the cost basis sold (80% of 1.8345)

      const ok1 = assertNear(
        sellFill.proceeds,
        expProceeds,
        "sellFill.proceeds",
        d,
      );
      const ok2 = assertNear(closeRes.pnlUsd, expPnl, "closeRes.pnlUsd", d);
      const ok3 = assertNear(state.cashUsd, expCash, "state.cashUsd", d);
      const ok4 = assertNear(
        state.lockedAtaRentUsd,
        0.407856,
        "state.lockedAtaRentUsd",
        d,
      );
      const ok5 = assertNear(
        pos.qtyRemaining,
        qtyTotal * 0.2,
        "pos.qtyRemaining",
        d,
      );
      const ok6 = assertNear(
        pos.costBasisRemainingUsd,
        1.8345 * 0.2,
        "pos.costBasisRemainingUsd",
        d,
      );
      return ok1 && ok2 && ok3 && ok4 && ok5 && ok6;
    },
  );

  // Scenario 3: full close releases rent
  addScenario("3: full close releases rent", (d) => {
    // Hand math: full close on remaining 20% releases rent 0.407856 to cash, lockedRent becomes 0, ataRentReleaseEvents=1, closedTrades=1
    const state = createInitialState(
      FIXTURE_CONFIG,
      "testHash",
      "2026-10-28T00:00:00.000Z",
    );
    const buyFill = computeBuyFill([0.00001], 20000, 1.8, FIXTURE_CONFIG, 200);
    const pos = openPosition(state, "mint1", "pair1", buyFill, 20000, 1000);

    const cashBeforeClose = state.cashUsd;
    const sellFill = computeSellFill(
      pos.qtyRemaining,
      [0.00002],
      25000,
      "NORMAL",
      FIXTURE_CONFIG,
      200,
    );
    closeFraction(
      state,
      pos,
      1.0,
      sellFill,
      "TAKE_PROFIT_2",
      "2026-10-28T00:02:00.000Z",
    );

    const expCashAfter = cashBeforeClose + sellFill.proceeds + 0.407856;

    const ok1 = assertNear(
      state.lockedAtaRentUsd,
      0.0,
      "state.lockedAtaRentUsd",
      d,
    );
    const ok2 = assertEqual(
      state.ataRentReleaseEvents,
      1,
      "state.ataRentReleaseEvents",
      d,
    );
    const ok3 = assertEqual(state.closedTrades, 1, "state.closedTrades", d);
    const ok4 = assertEqual(
      state.positions["mint1"],
      undefined,
      "position deleted",
      d,
    );
    const ok5 = assertNear(
      state.cashUsd,
      expCashAfter,
      "state.cashUsd after rent release",
      d,
    );
    return ok1 && ok2 && ok3 && ok4 && ok5;
  });

  // Scenario 4: rug via a missing pair
  addScenario("4: rug via a missing pair", (d) => {
    // Hand math: 1st missing pair -> streak=1 -> HOLD_UNKNOWN. 2nd missing pair -> streak=2 >= confirm(2) -> EXIT RUG
    const pos = {
      mint: "m1",
      pairAddress: "p1",
      entryAtMs: 1000,
      entryPrice: 0.00001,
      entryLiquidityUsd: 20000,
      qtyRemaining: 100,
      costBasisRemainingUsd: 1.8,
      peakPrice: 0.00001,
      tp1Done: false,
      rentLockedUsd: 0.4,
      lastPrice: 0.00001,
      priceHistory: [0.00001],
      liqBadStreak: 0,
    };
    const obsMissing = {
      pairPresent: false,
      priceUsd: null,
      liquidityUsd: null,
      priceChangeM5: null,
    };

    const res1 = evaluateExits(pos, obsMissing, 2000, FIXTURE_CONFIG);
    const ok1 = assertEqual(
      res1.decision.type,
      "HOLD_UNKNOWN",
      "1st missing -> HOLD_UNKNOWN",
      d,
    );
    const ok2 = assertEqual(
      res1.position.liqBadStreak,
      1,
      "streak incremented to 1",
      d,
    );

    const res2 = evaluateExits(res1.position, obsMissing, 3000, FIXTURE_CONFIG);
    const ok3 = assertEqual(
      res2.decision.type,
      "EXIT",
      "2nd missing -> EXIT",
      d,
    );
    const ok4 = assertEqual(res2.decision.reason, "RUG", "reason RUG", d);
    const ok5 = assertEqual(
      res2.position.liqBadStreak,
      2,
      "streak incremented to 2",
      d,
    );
    return ok1 && ok2 && ok3 && ok4 && ok5;
  });

  // Scenario 5: rug via liquidity 0, and a good reading between two bad ones resets the streak
  addScenario("5: rug via liquidity 0, and good reading resets streak", (d) => {
    const pos = {
      mint: "m1",
      pairAddress: "p1",
      entryAtMs: 1000,
      entryPrice: 0.00001,
      entryLiquidityUsd: 20000,
      qtyRemaining: 100,
      costBasisRemainingUsd: 1.8,
      peakPrice: 0.00001,
      tp1Done: false,
      rentLockedUsd: 0.4,
      lastPrice: 0.00001,
      priceHistory: [0.00001],
      liqBadStreak: 0,
    };
    const obsBad = {
      pairPresent: true,
      priceUsd: 0.00001,
      liquidityUsd: 0,
      priceChangeM5: 0,
    };
    const obsGood = {
      pairPresent: true,
      priceUsd: 0.00001,
      liquidityUsd: 20000,
      priceChangeM5: 0,
    };

    // 1st bad
    const r1 = evaluateExits(pos, obsBad, 2000, FIXTURE_CONFIG);
    const ok1 = assertEqual(
      r1.decision.type,
      "HOLD_UNKNOWN",
      "1st bad -> HOLD_UNKNOWN",
      d,
    );
    const ok2 = assertEqual(r1.position.liqBadStreak, 1, "streak 1", d);

    // Good reading resets streak
    const r2 = evaluateExits(r1.position, obsGood, 3000, FIXTURE_CONFIG);
    const ok3 = assertEqual(r2.decision.type, "HOLD", "good -> HOLD", d);
    const ok4 = assertEqual(
      r2.position.liqBadStreak,
      0,
      "streak reset to 0",
      d,
    );

    // 1st bad again
    const r3 = evaluateExits(r2.position, obsBad, 4000, FIXTURE_CONFIG);
    const ok5 = assertEqual(
      r3.decision.type,
      "HOLD_UNKNOWN",
      "1st bad after good -> HOLD_UNKNOWN",
      d,
    );
    const ok6 = assertEqual(r3.position.liqBadStreak, 1, "streak 1", d);

    // 2nd bad -> RUG
    const r4 = evaluateExits(r3.position, obsBad, 5000, FIXTURE_CONFIG);
    const ok7 = assertEqual(r4.decision.type, "EXIT", "2nd bad -> EXIT", d);
    const ok8 = assertEqual(r4.decision.reason, "RUG", "reason RUG", d);
    return ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8;
  });

  // Scenario 6: immediate rug with numeric liquidity 1500 (under 2000 floor), 70% liq drop, and priceChange5m -85
  addScenario("6: immediate rug with numeric triggers", (d) => {
    const pos = {
      mint: "m1",
      pairAddress: "p1",
      entryAtMs: 1000,
      entryPrice: 0.00001,
      entryLiquidityUsd: 20000,
      qtyRemaining: 100,
      costBasisRemainingUsd: 1.8,
      peakPrice: 0.00001,
      tp1Done: false,
      rentLockedUsd: 0.4,
      lastPrice: 0.00001,
      priceHistory: [0.00001],
      liqBadStreak: 0,
    };

    // 6a: liq = 1500 (< floor 2000)
    const obsFloor = {
      pairPresent: true,
      priceUsd: 0.00001,
      liquidityUsd: 1500,
      priceChangeM5: 0,
    };
    const r1 = evaluateExits(pos, obsFloor, 2000, FIXTURE_CONFIG);
    const ok1 = assertEqual(r1.decision.type, "EXIT", "liq 1500 -> EXIT", d);
    const ok2 = assertEqual(r1.decision.reason, "RUG", "reason RUG", d);

    // 6b: 75% liq drop (20000 -> 5000) >= 70%
    const obsDrop = {
      pairPresent: true,
      priceUsd: 0.00001,
      liquidityUsd: 5000,
      priceChangeM5: 0,
    };
    const r2 = evaluateExits(pos, obsDrop, 2000, FIXTURE_CONFIG);
    const ok3 = assertEqual(r2.decision.type, "EXIT", "75% drop -> EXIT", d);
    const ok4 = assertEqual(r2.decision.reason, "RUG", "reason RUG", d);

    // 6c: priceChangeM5 = -85 (<= -80%)
    const obsCrash = {
      pairPresent: true,
      priceUsd: 0.0000015,
      liquidityUsd: 20000,
      priceChangeM5: -85,
    };
    const r3 = evaluateExits(pos, obsCrash, 2000, FIXTURE_CONFIG);
    const ok5 = assertEqual(r3.decision.type, "EXIT", "m5 -85% -> EXIT", d);
    const ok6 = assertEqual(r3.decision.reason, "RUG", "reason RUG", d);

    return ok1 && ok2 && ok3 && ok4 && ok5 && ok6;
  });

  // Scenario 7: rug proceeds never negative with a tiny cost basis
  addScenario("7: rug proceeds never negative with a tiny cost basis", (d) => {
    // Hand math: basis = 0.01, recoveryFraction = 0.05 -> recoveryGross = 0.0005 USD
    // networkFee = 0.00015 * 200 = 0.03 USD -> 0.0005 - 0.03 = -0.0295 -> clamped to 0
    const rugFill = computeRugFill(0.01, FIXTURE_CONFIG, 200);
    const ok1 = assertNear(rugFill.proceeds, 0.0, "proceeds clamped to 0", d);
    return ok1;
  });

  // Scenario 8: hard stop at entry price x0.72 exits (exitKind STOP, fraction 1) and holds at x0.73
  addScenario(
    "8: hard stop at entry price x0.72 exits and holds at x0.73",
    (d) => {
      const pos = {
        mint: "m1",
        pairAddress: "p1",
        entryAtMs: 1000,
        entryPrice: 0.00001,
        entryLiquidityUsd: 20000,
        qtyRemaining: 100,
        costBasisRemainingUsd: 1.8,
        peakPrice: 0.00001,
        tp1Done: false,
        rentLockedUsd: 0.4,
        lastPrice: 0.00001,
        priceHistory: [0.00001],
        liqBadStreak: 0,
      };

      // At 0.0000073 (gain -27% > hardStop -28%) -> HOLD
      const obsHold = {
        pairPresent: true,
        priceUsd: 0.0000073,
        liquidityUsd: 20000,
        priceChangeM5: 0,
      };
      const rHold = evaluateExits(pos, obsHold, 2000, FIXTURE_CONFIG);
      const ok1 = assertEqual(rHold.decision.type, "HOLD", "x0.73 -> HOLD", d);

      // At 0.0000072 (gain -28% <= -28%) -> EXIT HARD_STOP
      const obsExit = {
        pairPresent: true,
        priceUsd: 0.0000072,
        liquidityUsd: 20000,
        priceChangeM5: 0,
      };
      const rExit = evaluateExits(pos, obsExit, 2000, FIXTURE_CONFIG);
      const ok2 = assertEqual(rExit.decision.type, "EXIT", "x0.72 -> EXIT", d);
      const ok3 = assertEqual(
        rExit.decision.reason,
        "HARD_STOP",
        "reason HARD_STOP",
        d,
      );
      const ok4 = assertEqual(
        rExit.decision.exitKind,
        "STOP",
        "exitKind STOP",
        d,
      );
      const ok5 = assertNear(rExit.decision.fraction, 1.0, "fraction 1.0", d);

      return ok1 && ok2 && ok3 && ok4 && ok5;
    },
  );

  // Scenario 9: breakeven after a peak of x1.45: exits at x1.05, holds just above
  addScenario(
    "9: breakeven after peak x1.45 exits at x1.05 and holds just above",
    (d) => {
      const pos = {
        mint: "m1",
        pairAddress: "p1",
        entryAtMs: 1000,
        entryPrice: 0.00001,
        entryLiquidityUsd: 20000,
        qtyRemaining: 100,
        costBasisRemainingUsd: 1.8,
        peakPrice: 0.0000145,
        tp1Done: false,
        rentLockedUsd: 0.4,
        lastPrice: 0.0000145,
        priceHistory: [0.0000145],
        liqBadStreak: 0,
      };

      // Holds at 0.0000106 (> breakeven 0.0000105)
      const obsHold = {
        pairPresent: true,
        priceUsd: 0.0000106,
        liquidityUsd: 20000,
        priceChangeM5: 0,
      };
      const rHold = evaluateExits(pos, obsHold, 2000, FIXTURE_CONFIG);
      const ok1 = assertEqual(rHold.decision.type, "HOLD", "x1.06 -> HOLD", d);

      // Exits at 0.0000105 (<= breakeven 0.0000105)
      const obsExit = {
        pairPresent: true,
        priceUsd: 0.0000105,
        liquidityUsd: 20000,
        priceChangeM5: 0,
      };
      const rExit = evaluateExits(pos, obsExit, 2000, FIXTURE_CONFIG);
      const ok2 = assertEqual(rExit.decision.type, "EXIT", "x1.05 -> EXIT", d);
      const ok3 = assertEqual(
        rExit.decision.reason,
        "BREAKEVEN_STOP",
        "reason BREAKEVEN_STOP",
        d,
      );

      return ok1 && ok2 && ok3;
    },
  );

  // Scenario 10: relative trailing: peak x1.70 gives stop x1.36 (holds at x1.37, exits at x1.36, reason TRAILING_STOP)
  addScenario("10: relative trailing peak x1.70 gives stop x1.36", (d) => {
    // Hand math: peak 0.000017 (gain +70% >= arm 65%) -> trail distance 20% -> stopPrice = 0.000017 * 0.8 = 0.0000136
    const pos = {
      mint: "m1",
      pairAddress: "p1",
      entryAtMs: 1000,
      entryPrice: 0.00001,
      entryLiquidityUsd: 20000,
      qtyRemaining: 100,
      costBasisRemainingUsd: 1.8,
      peakPrice: 0.000017,
      tp1Done: false,
      rentLockedUsd: 0.4,
      lastPrice: 0.000017,
      priceHistory: [0.000017],
      liqBadStreak: 0,
    };

    // Holds at 0.0000137 (> 0.0000136)
    const obsHold = {
      pairPresent: true,
      priceUsd: 0.0000137,
      liquidityUsd: 20000,
      priceChangeM5: 0,
    };
    const rHold = evaluateExits(pos, obsHold, 2000, FIXTURE_CONFIG);
    const ok1 = assertEqual(rHold.decision.type, "HOLD", "x1.37 -> HOLD", d);

    // Exits at 0.0000136 (<= 0.0000136)
    const obsExit = {
      pairPresent: true,
      priceUsd: 0.0000136,
      liquidityUsd: 20000,
      priceChangeM5: 0,
    };
    const rExit = evaluateExits(pos, obsExit, 2000, FIXTURE_CONFIG);
    const ok2 = assertEqual(rExit.decision.type, "EXIT", "x1.36 -> EXIT", d);
    const ok3 = assertEqual(
      rExit.decision.reason,
      "TRAILING_STOP",
      "reason TRAILING_STOP",
      d,
    );

    return ok1 && ok2 && ok3;
  });

  // Scenario 11: stagnant exit at 12+ minutes with gain 10% and peak under 40%, and NO stagnant exit when peak was x1.45
  addScenario(
    "11: stagnant exit and stagnant skipped when peak >= 40%",
    (d) => {
      // 11a: hold 12 min, gain 10%, peak 1.2x (< 1.4x) -> EXIT STAGNANT_STOP
      const pos1 = {
        mint: "m1",
        pairAddress: "p1",
        entryAtMs: 0,
        entryPrice: 0.00001,
        entryLiquidityUsd: 20000,
        qtyRemaining: 100,
        costBasisRemainingUsd: 1.8,
        peakPrice: 0.000012,
        tp1Done: false,
        rentLockedUsd: 0.4,
        lastPrice: 0.000011,
        priceHistory: [0.000011],
        liqBadStreak: 0,
      };
      const obsStag = {
        pairPresent: true,
        priceUsd: 0.000011,
        liquidityUsd: 20000,
        priceChangeM5: 0,
      };
      const rStag = evaluateExits(pos1, obsStag, 12 * 60000, FIXTURE_CONFIG);
      const ok1 = assertEqual(
        rStag.decision.type,
        "EXIT",
        "12m peak 1.2x -> EXIT",
        d,
      );
      const ok2 = assertEqual(
        rStag.decision.reason,
        "STAGNANT_STOP",
        "reason STAGNANT_STOP",
        d,
      );

      // 11b: hold 12 min, gain 10%, peak 1.45x (>= 1.4x) -> HOLD
      const pos2 = {
        mint: "m1",
        pairAddress: "p1",
        entryAtMs: 0,
        entryPrice: 0.00001,
        entryLiquidityUsd: 20000,
        qtyRemaining: 100,
        costBasisRemainingUsd: 1.8,
        peakPrice: 0.0000145,
        tp1Done: false,
        rentLockedUsd: 0.4,
        lastPrice: 0.000011,
        priceHistory: [0.000011],
        liqBadStreak: 0,
      };
      const rSkip = evaluateExits(pos2, obsStag, 12 * 60000, FIXTURE_CONFIG);
      const ok3 = assertEqual(
        rSkip.decision.type,
        "HOLD",
        "12m peak 1.45x -> HOLD",
        d,
      );

      return ok1 && ok2 && ok3;
    },
  );

  // Scenario 12: TP1 at +100% sells fraction 0.8, then after closeFraction tp1Done is true and moonbag trails 30% from stored peak
  addScenario(
    "12: TP1 sells 0.8, sets tp1Done and moonbag trails 30% from stored peak",
    (d) => {
      // Realistic size: 170000 tokens bought at 0.00001 (about 1.7 USD)
      const pos = {
        mint: "m1",
        pairAddress: "p1",
        entryAtMs: 1000,
        entryPrice: 0.00001,
        entryLiquidityUsd: 20000,
        qtyRemaining: 170000,
        costBasisRemainingUsd: 1.73425,
        peakPrice: 0.00001,
        tp1Done: false,
        rentLockedUsd: 0.4,
        lastPrice: 0.00001,
        priceHistory: [0.00001],
        liqBadStreak: 0,
      };
      const obsTp1 = {
        pairPresent: true,
        priceUsd: 0.00002,
        liquidityUsd: 20000,
        priceChangeM5: 0,
      };

      const rTp1 = evaluateExits(pos, obsTp1, 2000, FIXTURE_CONFIG);
      const ok1 = assertEqual(rTp1.decision.type, "EXIT", "TP1 -> EXIT", d);
      const ok2 = assertEqual(
        rTp1.decision.reason,
        "TAKE_PROFIT_1",
        "reason TAKE_PROFIT_1",
        d,
      );
      const ok3 = assertNear(rTp1.decision.fraction, 0.8, "fraction 0.8", d);
      // Hand math: qtySold = 136000; gross = 136000 x 0.00002 x 0.985 = 2.6792; pool 20000 -> R = 10000
      const qtySold = 170000 * 0.8;
      const gross = qtySold * 0.00002 * 0.985;
      const expNet =
        gross * (1 - gross / (10000 + gross)) - gross * 0.0025 - 0.00015 * 200;
      const expPeakAfterTp1 = expNet / qtySold; // about 0.0000194249

      const state = createInitialState(
        FIXTURE_CONFIG,
        "testHash",
        "2026-10-28T00:00:00.000Z",
      );
      state.positions["m1"] = rTp1.position;
      const sellFill = computeSellFill(
        rTp1.position.qtyRemaining * 0.8,
        [0.00002],
        20000,
        "NORMAL",
        FIXTURE_CONFIG,
        200,
      );
      closeFraction(
        state,
        rTp1.position,
        0.8,
        sellFill,
        "TAKE_PROFIT_1",
        "2026-10-28T00:01:00.000Z",
      );
      const updatedPos = state.positions["m1"];
      const ok4 = assertEqual(updatedPos.tp1Done, true, "tp1Done is true", d);
      const ok5 = assertNear(
        updatedPos.peakPrice,
        expPeakAfterTp1,
        "peak reset to hand-computed net TP1 fill price",
        d,
      );
      // Moonbag stop = expPeakAfterTp1 x 0.7 = about 0.0000135974. The breakeven floor (0.0000105) is lower, so trailing is the active stop
      const obsHold = {
        pairPresent: true,
        priceUsd: 0.0000137,
        liquidityUsd: 20000,
        priceChangeM5: 0,
      };
      const obsExit = {
        pairPresent: true,
        priceUsd: 0.0000135,
        liquidityUsd: 20000,
        priceChangeM5: 0,
      };
      const rHold = evaluateExits(updatedPos, obsHold, 3000, FIXTURE_CONFIG);
      const rExit = evaluateExits(updatedPos, obsExit, 3000, FIXTURE_CONFIG);
      const ok6 = assertEqual(
        rHold.decision.type,
        "HOLD",
        "above moonbag stop -> HOLD",
        d,
      );
      const ok7 = assertEqual(
        rExit.decision.type,
        "EXIT",
        "below moonbag stop -> EXIT",
        d,
      );
      const ok8 = assertEqual(
        rExit.decision.reason,
        "TRAILING_STOP",
        "reason TRAILING_STOP",
        d,
      );
      return ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8;
    },
  );

  // Scenario 13: TP2 at +250% sells everything, and at gain +300% on same tick TP2 wins over TP1
  addScenario("13: TP2 sells 100%, and TP2 wins over TP1 at +300%", (d) => {
    const pos = {
      mint: "m1",
      pairAddress: "p1",
      entryAtMs: 1000,
      entryPrice: 0.00001,
      entryLiquidityUsd: 20000,
      qtyRemaining: 100,
      costBasisRemainingUsd: 1.8,
      peakPrice: 0.00001,
      tp1Done: false,
      rentLockedUsd: 0.4,
      lastPrice: 0.00001,
      priceHistory: [0.00001],
      liqBadStreak: 0,
    };
    const obs300 = {
      pairPresent: true,
      priceUsd: 0.00004,
      liquidityUsd: 20000,
      priceChangeM5: 0,
    };

    const r300 = evaluateExits(pos, obs300, 2000, FIXTURE_CONFIG);
    const ok1 = assertEqual(r300.decision.type, "EXIT", "+300% -> EXIT", d);
    const ok2 = assertEqual(
      r300.decision.reason,
      "TAKE_PROFIT_2",
      "TP2 wins over TP1",
      d,
    );
    const ok3 = assertNear(r300.decision.fraction, 1.0, "fraction 1.0", d);

    return ok1 && ok2 && ok3;
  });

  // Scenario 14: max hold at 45 minutes
  addScenario("14: max hold at 45 minutes", (d) => {
    const pos = {
      mint: "m1",
      pairAddress: "p1",
      entryAtMs: 0,
      entryPrice: 0.00001,
      entryLiquidityUsd: 20000,
      qtyRemaining: 100,
      costBasisRemainingUsd: 1.8,
      peakPrice: 0.00001,
      tp1Done: false,
      rentLockedUsd: 0.4,
      lastPrice: 0.00001,
      priceHistory: [0.00001],
      liqBadStreak: 0,
    };
    const obsNormal = {
      pairPresent: true,
      priceUsd: 0.00001,
      liquidityUsd: 20000,
      priceChangeM5: 0,
    };

    const rMax = evaluateExits(pos, obsNormal, 45 * 60000, FIXTURE_CONFIG);
    const ok1 = assertEqual(rMax.decision.type, "EXIT", "45m -> EXIT", d);
    const ok2 = assertEqual(
      rMax.decision.reason,
      "MAX_HOLD",
      "reason MAX_HOLD",
      d,
    );

    return ok1 && ok2;
  });

  // Scenario 15: a single observed price works for buy and sell fills
  addScenario(
    "15: a single observed price works for buy and sell fills",
    (d) => {
      const buyFill = computeBuyFill(
        [0.00001],
        20000,
        1.7,
        FIXTURE_CONFIG,
        200,
      );
      const sellFill = computeSellFill(
        100,
        [0.00001],
        20000,
        "NORMAL",
        FIXTURE_CONFIG,
        200,
      );

      const ok1 = assertNear(buyFill.basePrice, 0.00001, "buy basePrice", d);
      const ok2 = assertNear(sellFill.basePrice, 0.00001, "sell basePrice", d);

      return ok1 && ok2;
    },
  );

  // Scenario 16: budget: two positions allowed at tradeSize 1.70 with SOL 180 and SOL 200, and refused at tradeSize 2.10 with SOL 180
  addScenario("16: budget checks for 1.70 vs 2.10", (d) => {
    // 16a: tradeSize 1.70, SOL 180 -> debit = 1.7 + (0.00203928*180) + (0.00015*180) + (1.7*0.0025) = 2.0983204
    // Cash after pos 1 = 5.0 - 2.0983204 = 2.9016796. Cash after pos 2 = 2.9016796 - 2.0983204 = 0.8033592 >= minSolGasBuffer 0.60 -> canAfford true
    const state1 = createInitialState(
      FIXTURE_CONFIG,
      "hash",
      "2026-10-28T00:00:00.000Z",
    );
    const buy1 = computeBuyFill([0.00001], 20000, 1.7, FIXTURE_CONFIG, 180);
    openPosition(state1, "m1", "p1", buy1, 20000, 1000);
    const ok1 = assertEqual(
      canAfford(state1, FIXTURE_CONFIG, "m2", 180),
      true,
      "1.70 SOL 180 canAfford true",
      d,
    );

    // 16b: tradeSize 1.70, SOL 200 -> debit = 1.7 + (0.00203928*200) + (0.00015*200) + (1.7*0.0025) = 2.142106
    // Cash after pos 1 = 5.0 - 2.142106 = 2.857894. Cash after pos 2 = 2.857894 - 2.142106 = 0.715788 >= 0.60 -> canAfford true
    const state2 = createInitialState(
      FIXTURE_CONFIG,
      "hash",
      "2026-10-28T00:00:00.000Z",
    );
    const buy2 = computeBuyFill([0.00001], 20000, 1.7, FIXTURE_CONFIG, 200);
    openPosition(state2, "m1", "p1", buy2, 20000, 1000);
    const ok2 = assertEqual(
      canAfford(state2, FIXTURE_CONFIG, "m2", 200),
      true,
      "1.70 SOL 200 canAfford true",
      d,
    );

    // 16c: tradeSize 2.10, SOL 180 -> debit = 2.1 + (0.00203928*180) + (0.00015*180) + (2.1*0.0025) = 2.4993204
    // Cash after pos 1 = 5.0 - 2.4993204 = 2.5006796. Cash after pos 2 = 2.5006796 - 2.4993204 = 0.0013592 < 0.60 -> canAfford false
    const config21 = {
      ...FIXTURE_CONFIG,
      paper: { ...FIXTURE_CONFIG.paper, tradeSizeUsd: 2.1 },
    };
    const state3 = createInitialState(
      config21,
      "hash",
      "2026-10-28T00:00:00.000Z",
    );
    const buy3 = computeBuyFill([0.00001], 20000, 2.1, config21, 180);
    openPosition(state3, "m1", "p1", buy3, 20000, 1000);
    const ok3 = assertEqual(
      canAfford(state3, config21, "m2", 180),
      false,
      "2.10 SOL 180 canAfford false",
      d,
    );

    return ok1 && ok2 && ok3;
  });

  // Scenario 17: evaluateExits does not mutate its inputs (pass deep-frozen objects) and returns a new position object
  addScenario("17: evaluateExits deep-frozen input immutability", (d) => {
    const frozenPos = Object.freeze({
      mint: "m1",
      pairAddress: "p1",
      entryAtMs: 1000,
      entryPrice: 0.00001,
      entryLiquidityUsd: 20000,
      qtyRemaining: 100,
      costBasisRemainingUsd: 1.8,
      peakPrice: 0.00001,
      tp1Done: false,
      rentLockedUsd: 0.4,
      lastPrice: 0.00001,
      priceHistory: Object.freeze([0.00001]),
      liqBadStreak: 0,
    });
    const frozenObs = Object.freeze({
      pairPresent: true,
      priceUsd: 0.000012,
      liquidityUsd: 20000,
      priceChangeM5: 0,
    });

    const res = evaluateExits(frozenPos, frozenObs, 2000, FIXTURE_CONFIG);
    const ok1 = res.position !== frozenPos;
    const ok2 = res.position.peakPrice === 0.000012;
    const ok3 = frozenPos.peakPrice === 0.00001;

    d.push(`returned new object: ${ok1}, input peakPrice unchanged: ${ok3}`);
    return ok1 && ok2 && ok3;
  });

  // Scenario 18: closeFraction on a partial close stores the passed (updated copy) position back into state.positions
  addScenario(
    "18: closeFraction stores the updated copy back into state.positions",
    (d) => {
      const state = createInitialState(
        FIXTURE_CONFIG,
        "testHash",
        "2026-10-28T00:00:00.000Z",
      );
      const buyFill = computeBuyFill(
        [0.00001],
        20000,
        1.7,
        FIXTURE_CONFIG,
        200,
      );
      const stored = openPosition(state, "m1", "p1", buyFill, 20000, 1000);
      // evaluateExits returns a COPY, so main.js will hold a different object than state.positions[mint]
      const copy = { ...stored, priceHistory: [...stored.priceHistory] };
      copy.lastPrice = 0.00002; // a change that exists only on the copy

      const sellFill = computeSellFill(
        copy.qtyRemaining * 0.8,
        [0.00002],
        20000,
        "NORMAL",
        FIXTURE_CONFIG,
        200,
      );
      closeFraction(
        state,
        copy,
        0.8,
        sellFill,
        "TAKE_PROFIT_1",
        "2026-10-28T00:01:00.000Z",
      );

      const qty0 = 1.7 / (0.00001 * 1.015 * (1 + 1.7 / 10000)); // hand arithmetic for the bought quantity
      const updated = state.positions["m1"];
      const ok1 = assertEqual(
        updated === copy,
        true,
        "state now holds the passed copy",
        d,
      );
      const ok2 = assertEqual(
        updated.lastPrice,
        0.00002,
        "the copy-only change persisted",
        d,
      );
      const ok3 = assertEqual(updated.tp1Done, true, "tp1Done updated", d);
      const ok4 = assertNear(
        updated.qtyRemaining,
        qty0 * 0.2,
        "qtyRemaining is 20% of the bought quantity",
        d,
      );
      return ok1 && ok2 && ok3 && ok4;
    },
  );

  // Scenario 19: checkRentInvariant throws when locked rent is tampered with, and when ataRentReleaseEvents differs from closedTrades
  addScenario("19: checkRentInvariant detects tampered state", (d) => {
    const state = createInitialState(
      FIXTURE_CONFIG,
      "testHash",
      "2026-10-28T00:00:00.000Z",
    );
    const buyFill = computeBuyFill([0.00001], 20000, 1.7, FIXTURE_CONFIG, 200);
    openPosition(state, "m1", "p1", buyFill, 20000, 1000);

    // 19a: Tamper locked rent
    state.lockedAtaRentUsd += 0.1;
    let threw1 = false;
    try {
      checkRentInvariant(state);
    } catch {
      threw1 = true;
    }
    state.lockedAtaRentUsd -= 0.1; // revert

    // 19b: Tamper ataRentReleaseEvents
    state.ataRentReleaseEvents += 1;
    let threw2 = false;
    try {
      checkRentInvariant(state);
    } catch {
      threw2 = true;
    }

    const ok1 = assertEqual(threw1, true, "threw on locked rent tamper", d);
    const ok2 = assertEqual(threw2, true, "threw on release events tamper", d);

    return ok1 && ok2;
  });

  // Scenario 20: evaluateExits throws if config.rug.confirmObservationsForMissingLiquidity is missing
  addScenario(
    "20: evaluateExits throws if confirmObservationsForMissingLiquidity is missing",
    (d) => {
      const badConfig = {
        ...FIXTURE_CONFIG,
        rug: {
          ...FIXTURE_CONFIG.rug,
          confirmObservationsForMissingLiquidity: undefined,
        },
      };
      const pos = {
        mint: "m1",
        pairAddress: "p1",
        entryAtMs: 1000,
        entryPrice: 0.00001,
        entryLiquidityUsd: 20000,
        qtyRemaining: 100,
        costBasisRemainingUsd: 1.8,
        peakPrice: 0.00001,
        tp1Done: false,
        rentLockedUsd: 0.4,
        lastPrice: 0.00001,
        priceHistory: [0.00001],
        liqBadStreak: 0,
      };
      const obsMissing = {
        pairPresent: false,
        priceUsd: null,
        liquidityUsd: null,
        priceChangeM5: null,
      };

      let threw = false;
      try {
        evaluateExits(pos, obsMissing, 2000, badConfig);
      } catch {
        threw = true;
      }

      const ok1 = assertEqual(
        threw,
        true,
        "evaluateExits threw when confirm setting missing",
        d,
      );
      return ok1;
    },
  );

  // Scenario 21: filters tests (passing pair, 17 rule failures, missing metric, sells5m=0, age inclusive, future age_min)
  addScenario("21: filters comprehensive tests", (d) => {
    const nowMs = 1000000000000;
    const basePair = {
      dexId: "raydium",
      pairCreatedAt: nowMs - 10 * 60000, // 10 min age
      liquidity: { usd: 20000 },
      fdv: 50000,
      volume: { m5: 5000, h1: 30000 },
      txns: { m5: { buys: 50, sells: 20 } },
      priceChange: { m5: 10.0, h1: 50.0 },
    };

    // 21a: Fully passing pair
    const resPass = evaluateEntryFilter(basePair, FIXTURE_CONFIG, nowMs);
    const okPass =
      assertEqual(resPass.passed, true, "basePair passed", d) &&
      assertEqual(resPass.failedRules.length, 0, "0 failed rules", d);

    // 21b: Each of 17 rules failing alone
    const ruleTests = [
      { name: "dex_not_tradable", mod: { dexId: "unknown_dex" } },
      { name: "age_min", mod: { pairCreatedAt: nowMs - 2 * 60000 } }, // 2 min < min 3
      { name: "age_max", mod: { pairCreatedAt: nowMs - 50 * 60000 } }, // 50 min > max 45
      { name: "liquidity_min", mod: { liquidity: { usd: 10000 } } }, // 10k < min 12k
      { name: "liquidity_max", mod: { liquidity: { usd: 90000 } } }, // 90k > max 85k
      { name: "fdv_min", mod: { fdv: 20000 } }, // 20k < min 25k
      { name: "fdv_max", mod: { fdv: 200000 } }, // 200k > max 180k
      {
        name: "fdv_to_liquidity_ratio",
        mod: { fdv: 100000, liquidity: { usd: 20000 } },
      }, // ratio 5.0 > max 4.5
      {
        name: "vol1h_to_liquidity_ratio",
        mod: { volume: { m5: 5000, h1: 20000 }, liquidity: { usd: 20000 } },
      }, // ratio 1.0 < min 1.2
      { name: "volume5m_min", mod: { volume: { m5: 3000, h1: 30000 } } }, // 3k < min 4k
      { name: "volume1h_min", mod: { volume: { m5: 5000, h1: 10000 } } }, // 10k < min 15k
      { name: "buys5m_min", mod: { txns: { m5: { buys: 30, sells: 20 } } } }, // 30 < min 35
      {
        name: "buy_sell_ratio",
        mod: { txns: { m5: { buys: 50, sells: 40 } } },
      }, // 1.25 < min 1.4
      { name: "price5m_min", mod: { priceChange: { m5: 3.0, h1: 50.0 } } }, // 3% < min 4%
      { name: "price5m_max", mod: { priceChange: { m5: 40.0, h1: 50.0 } } }, // 40% > max 35%
      { name: "price1h_min", mod: { priceChange: { m5: 10.0, h1: -20.0 } } }, // -20% < min -15%
      { name: "price1h_max", mod: { priceChange: { m5: 10.0, h1: 200.0 } } }, // 200% > max 150%
    ];

    let rulesOk = true;
    for (const rt of ruleTests) {
      const testPair = { ...basePair, ...rt.mod };
      const res = evaluateEntryFilter(testPair, FIXTURE_CONFIG, nowMs);
      const hasRule = res.failedRules.includes(rt.name);
      if (!hasRule) {
        d.push(
          `rule ${rt.name} expected to fail but didn't (failed: ${res.failedRules.join(",")})`,
        );
        rulesOk = false;
      }
    }

    // 21c: Missing metric appears ONCE as missing:<field>
    const pairMissingLiq = { ...basePair, liquidity: null };
    const resMissing = evaluateEntryFilter(
      pairMissingLiq,
      FIXTURE_CONFIG,
      nowMs,
    );
    const countMissingLiq = resMissing.failedRules.filter(
      (r) => r === "missing:liquidityUsd",
    ).length;
    const okMissing = assertEqual(
      countMissingLiq,
      1,
      "missing:liquidityUsd appears once",
      d,
    );

    // 21d: sells5m 0 with buys5m > 0 passes buy_sell_ratio
    const pairZeroSells = { ...basePair, txns: { m5: { buys: 50, sells: 0 } } };
    const resZeroSells = evaluateEntryFilter(
      pairZeroSells,
      FIXTURE_CONFIG,
      nowMs,
    );
    const okZeroSells = assertEqual(
      resZeroSells.failedRules.includes("buy_sell_ratio"),
      false,
      "buys=50, sells=0 passes ratio",
      d,
    );

    // 21e: age boundary inclusive (exact 3 min)
    const pairAgeExact = { ...basePair, pairCreatedAt: nowMs - 3 * 60000 };
    const resAgeExact = evaluateEntryFilter(
      pairAgeExact,
      FIXTURE_CONFIG,
      nowMs,
    );
    const okAgeExact = assertEqual(
      resAgeExact.failedRules.includes("age_min"),
      false,
      "exact 3m age passes age_min",
      d,
    );

    // 21f: pairCreatedAt in future fails age_min
    const pairFuture = { ...basePair, pairCreatedAt: nowMs + 1000 };
    const resFuture = evaluateEntryFilter(pairFuture, FIXTURE_CONFIG, nowMs);
    const okFuture = assertEqual(
      resFuture.failedRules.includes("age_min"),
      true,
      "future pairCreatedAt fails age_min",
      d,
    );

    return (
      okPass && rulesOk && okMissing && okZeroSells && okAgeExact && okFuture
    );
  });

  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;

  return { total, passed, failed, results };
}

// Standalone runner guard
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = runSelftest();
  console.log("=== PAPER-SCANNER SELF-TEST SUITE ===\n");
  for (const r of res.results) {
    console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
    if (!r.ok) {
      console.log(`  Detail: ${r.detail}`);
    }
  }
  console.log(
    `\nSelf-test Summary: ${res.passed}/${res.total} passed (${res.failed} failed)`,
  );
  if (res.failed > 0) {
    process.exitCode = 1;
  }
}
