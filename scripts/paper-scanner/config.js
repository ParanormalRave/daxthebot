import fs from "node:fs";
import path from "node:path";
import { sha256, isNonEmptyString, numOrNull, positiveOrNull } from "./util.js";

// Schema of expected keys and exact primitive types
export const KNOWN_CONFIG_KEYS = {
  strategyName: "string",
  version: "string",
  mode: "string",
  paths: {
    stateFile: "string",
    tradesLog: "string",
    observationsLog: "string",
    snapshotsLog: "string",
    rugCheckSamplesLog: "string",
    summaryFile: "string",
  },
  polling: {
    discoveryIntervalSec: "number",
    positionCheckIntervalSec: "number",
    watchlistTickSec: "number",
    httpTimeoutMs: "number",
    backoffOn429Sec: "number",
  },
  rateLimits: {
    geckoTerminalMaxReqPerMin: "number",
    geckoTerminalDelayBetweenPagesMs: "number",
    dexScreenerProfilesMaxReqPerMin: "number",
    dexScreenerPairsMaxReqPerMin: "number",
    rugCheckMaxReqPerMin: "number",
    rugCheckDelayBetweenCallsMs: "number",
  },
  discovery: {
    geckoTerminalNewPools: {
      enabled: "boolean",
      url: "string",
      pages: "number",
    },
    dexScreenerProfiles: {
      enabled: "boolean",
      url: "string",
    },
    dexScreenerPairsBatchUrl: "string",
    dexScreenerBatchSize: "number",
  },
  watchlist: {
    launchpadTtlMinutes: "number",
    ammCandidateTtlMinutes: "number",
    pollIntervalSecByState: {
      launchpadFirst60Min: "number",
      launchpadAfter60Min: "number",
      ammCandidate: "number",
    },
    snapshotOffsetsMinutes: "array",
    maxTrackedConcurrently: "number",
    minReserveUsdToTrack: "number",
    countDroppedPools: "boolean",
    launchpadDexIdsRecordOnly: "array",
  },
  entryFilter: {
    chainId: "string",
    tradableDexIds: "array",
    logUnknownDexIds: "boolean",
    pairAgeMinutes: { min: "number", max: "number" },
    liquidityUsd: { min: "number", max: "number" },
    fdvUsd: { min: "number", max: "number" },
    maxFdvToLiquidityRatio: "number",
    minVolume1hToLiquidityRatio: "number",
    volumeUsd: { min5m: "number", min1h: "number" },
    minBuys5m: "number",
    minBuyToSellRatio5m: "number",
    priceChangePercent: {
      min5m: "number",
      max5m: "number",
      min1h: "number",
      max1h: "number",
    },
    rejectOnNull: "boolean",
  },
  recordOnlyFields: "array",
  security: {
    rugCheckReportUrlTemplate: "string",
    onApiFailure: "string",
    unknownAuthorityAction: "string",
    requireMintAuthorityRevoked: "boolean",
    requireFreezeAuthorityRevoked: "boolean",
    excludePoolAndAmmAccountsFromHolders: "boolean",
    maxTop10HoldersPercent: "number",
    maxSingleHolderPercent: "number",
    minLpLockedOrBurnedPercent: "number",
    saveFirstNRawReports: "number",
  },
  paper: {
    startingCashUsd: "number",
    tradeSizeUsd: "number",
    maxConcurrentPositions: "number",
    minSolGasBufferUsd: "number",
    solPriceUsdFallback: "number",
    ataRentSol: "number",
    swapNetworkFeeSol: "number",
    dexFeeBps: "number",
    entrySlippageBps: "number",
    normalExitSlippageBps: "number",
    stopExitSlippageBps: "number",
    modelConstantProductPriceImpact: "boolean",
    fillModel: "string",
  },
  rug: {
    triggerIfPairMissing: "boolean",
    triggerIfLiquidityNullOrZero: "boolean",
    triggerIfLiquidityUsdBelow: "number",
    triggerIfLiquidityDropFromEntryPercent: "number",
    triggerIfPriceChange5mAtOrBelowPercent: "number",
    recoveryFractionOfRemainingCost: "number",
    confirmObservationsForMissingLiquidity: "number",
  },
  exits: {
    exitPriority: "array",
    hardStopPercent: "number",
    breakevenStop: {
      armAtGainPercent: "number",
      lockAtGainPercent: "number",
    },
    stagnantStop: {
      checkAfterMinutes: "number",
      minGainPercent: "number",
      skipIfPeakGainAtOrAbovePercent: "number",
    },
    trailingStop: {
      armAtGainPercent: "number",
      trailDistanceFromPeakPercent: "number",
      mode: "string",
    },
    moonbag: {
      resetPeakAtTp1: "boolean",
      trailDistanceFromPeakPercent: "number",
    },
    maxHoldMinutes: "number",
    takeProfit1: {
      gainPercent: "number",
      sellPercentOfHoldings: "number",
    },
    takeProfit2: {
      gainPercent: "number",
      sellPercentOfHoldings: "number",
    },
  },
  protocol: {
    locked: "boolean",
    maxTrades: "number",
    maxDays: "number",
    minTradesForVerdict: "number",
    minExpectancyUsdPerTrade: "number",
    minProfitFactor: "number",
    maxRugRatePercent: "number",
    minBalanceFloorUsd: "number",
    maxMissingDataRejectRatePercent: "number",
  },
};

const ALLOWED_URL_HOSTS = new Set([
  "api.geckoterminal.com",
  "api.dexscreener.com",
  "api.rugcheck.xyz",
]);

const REQUIRED_EXIT_PRIORITY = [
  "RUG",
  "HARD_STOP",
  "TRAILING_STOP",
  "BREAKEVEN_STOP",
  "MAX_HOLD",
  "STAGNANT_STOP",
  "TAKE_PROFIT_2",
  "TAKE_PROFIT_1",
];

// Deep-freeze an object recursively
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

// Find unknown keys against expected schema
export function findUnknownKeys(
  actual,
  expected = KNOWN_CONFIG_KEYS,
  prefix = "",
) {
  const unknown = [];
  if (!actual || typeof actual !== "object" || Array.isArray(actual))
    return unknown;
  for (const key of Object.keys(actual)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (!(key in expected)) {
      unknown.push(fullPath);
    } else if (
      expected[key] &&
      typeof expected[key] === "object" &&
      !Array.isArray(expected[key]) &&
      typeof actual[key] === "object" &&
      !Array.isArray(actual[key])
    ) {
      unknown.push(...findUnknownKeys(actual[key], expected[key], fullPath));
    }
  }
  return unknown;
}

// Ensure all configured output paths strictly resolve inside data/paper-scanner/
export function assertOutputPathsContainment(
  paths,
  baseDir = "data/paper-scanner",
) {
  const cwd = process.cwd();
  const pkgPath = path.resolve(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`process.cwd() (${cwd}) does not contain package.json`);
  }
  const allowedDir = path.resolve(cwd, baseDir);
  for (const [key, relativePath] of Object.entries(paths || {})) {
    if (!isNonEmptyString(relativePath)) {
      throw new Error(`Invalid path configuration for "${key}"`);
    }
    const resolved = path.resolve(cwd, relativePath);
    if (
      !resolved.startsWith(allowedDir + path.sep) &&
      resolved !== allowedDir
    ) {
      throw new Error(
        `Output path for "${key}" (${relativePath}) escapes ${baseDir}`,
      );
    }
  }
}

// Recursively validate types for schema
function validateSchemaTypes(actual, expected, prefix = "", errors = []) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    errors.push(`${prefix || "config"}: expected non-null object`);
    return errors;
  }
  for (const [key, spec] of Object.entries(expected)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (!(key in actual)) {
      errors.push(`${fullKey}: missing required key`);
      continue;
    }
    const val = actual[key];
    if (typeof spec === "string") {
      if (spec === "number") {
        if (numOrNull(val) === null) {
          errors.push(
            `${fullKey}: expected finite number, got ${JSON.stringify(val)}`,
          );
        }
      } else if (spec === "string") {
        if (!isNonEmptyString(val)) {
          errors.push(`${fullKey}: expected non-empty string`);
        }
      } else if (spec === "boolean") {
        if (typeof val !== "boolean") {
          errors.push(`${fullKey}: expected boolean`);
        }
      } else if (spec === "array") {
        if (!Array.isArray(val)) {
          errors.push(`${fullKey}: expected array`);
        }
      }
    } else if (typeof spec === "object") {
      validateSchemaTypes(val, spec, fullKey, errors);
    }
  }
  return errors;
}

// Validate URL helper
function checkUrl(urlStr, fieldName, errors) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:") {
      errors.push(
        `${fieldName}: protocol must be https: (got ${parsed.protocol})`,
      );
    }
    if (!ALLOWED_URL_HOSTS.has(parsed.hostname)) {
      errors.push(
        `${fieldName}: host ${parsed.hostname} not in allowed hosts list`,
      );
    }
  } catch (err) {
    errors.push(`${fieldName}: invalid URL (${err.message})`);
  }
}

// Comprehensive schema and logic validation
export function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Config must be a non-null object");
  }

  // Schema presence and type check
  validateSchemaTypes(config, KNOWN_CONFIG_KEYS, "", errors);

  // Containment check
  try {
    assertOutputPathsContainment(config.paths);
  } catch (err) {
    errors.push(`paths containment error: ${err.message}`);
  }

  // Logic checks
  if (config.mode !== "PAPER_ONLY") {
    errors.push(`mode must be "PAPER_ONLY", got ${config.mode}`);
  }
  if (config.entryFilter?.chainId !== "solana") {
    errors.push(
      `entryFilter.chainId must be "solana", got ${config.entryFilter?.chainId}`,
    );
  }
  if (config.security?.onApiFailure !== "reject_and_log") {
    errors.push(
      `security.onApiFailure must be "reject_and_log", got ${config.security?.onApiFailure}`,
    );
  }
  if (config.security?.unknownAuthorityAction !== "reject_and_log") {
    errors.push(
      `security.unknownAuthorityAction must be "reject_and_log", got ${config.security?.unknownAuthorityAction}`,
    );
  }
  if (config.paper?.fillModel !== "worse_of_last_two_observed_prices") {
    errors.push(
      `paper.fillModel must be "worse_of_last_two_observed_prices", got ${config.paper?.fillModel}`,
    );
  }

  // Range checks
  const checkMinMax = (obj, name) => {
    if (obj && typeof obj.min === "number" && typeof obj.max === "number") {
      if (obj.min > obj.max) {
        errors.push(`${name}: min (${obj.min}) must be <= max (${obj.max})`);
      }
    }
  };
  checkMinMax(config.entryFilter?.pairAgeMinutes, "entryFilter.pairAgeMinutes");
  checkMinMax(config.entryFilter?.liquidityUsd, "entryFilter.liquidityUsd");
  checkMinMax(config.entryFilter?.fdvUsd, "entryFilter.fdvUsd");
  if (config.entryFilter?.priceChangePercent) {
    const pc = config.entryFilter.priceChangePercent;
    if (pc.min5m > pc.max5m)
      errors.push("entryFilter.priceChangePercent: min5m must be <= max5m");
    if (pc.min1h > pc.max1h)
      errors.push("entryFilter.priceChangePercent: min1h must be <= max1h");
  }

  // Exits logic
  if (
    numOrNull(config.exits?.hardStopPercent) === null ||
    config.exits.hardStopPercent >= 0
  ) {
    errors.push("exits.hardStopPercent must be < 0");
  }
  if (
    config.exits?.breakevenStop &&
    config.exits.breakevenStop.lockAtGainPercent >=
      config.exits.breakevenStop.armAtGainPercent
  ) {
    errors.push(
      "exits.breakevenStop.lockAtGainPercent must be < armAtGainPercent",
    );
  }
  const checkDist = (val, name) => {
    if (val <= 0 || val >= 100) errors.push(`${name} must be in (0, 100)`);
  };
  checkDist(
    config.exits?.trailingStop?.trailDistanceFromPeakPercent,
    "exits.trailingStop.trailDistanceFromPeakPercent",
  );
  checkDist(
    config.exits?.moonbag?.trailDistanceFromPeakPercent,
    "exits.moonbag.trailDistanceFromPeakPercent",
  );

  const tp1 = config.exits?.takeProfit1;
  const tp2 = config.exits?.takeProfit2;
  if (tp1 && tp2) {
    if (tp1.gainPercent >= tp2.gainPercent) {
      errors.push(
        "exits.takeProfit1.gainPercent must be < takeProfit2.gainPercent",
      );
    }
    if (tp1.sellPercentOfHoldings <= 0 || tp1.sellPercentOfHoldings >= 100) {
      errors.push(
        "exits.takeProfit1.sellPercentOfHoldings must be in (0, 100)",
      );
    }
    if (tp2.sellPercentOfHoldings !== 100) {
      errors.push(
        "exits.takeProfit2.sellPercentOfHoldings must be exactly 100",
      );
    }
  }

  // Rug recovery
  const recov = config.rug?.recoveryFractionOfRemainingCost;
  if (typeof recov !== "number" || recov < 0 || recov > 1) {
    errors.push("rug.recoveryFractionOfRemainingCost must be in [0, 1]");
  }

  // Rug confirmation streak must be an integer from 1 to 5
  const confirmObs = config.rug?.confirmObservationsForMissingLiquidity;
  if (!Number.isInteger(confirmObs) || confirmObs < 1 || confirmObs > 5) {
    errors.push("rug.confirmObservationsForMissingLiquidity must be an integer between 1 and 5");
  }

  // Paper & bps
  const bpsFields = [
    "dexFeeBps",
    "entrySlippageBps",
    "normalExitSlippageBps",
    "stopExitSlippageBps",
  ];
  for (const f of bpsFields) {
    if (typeof config.paper?.[f] !== "number" || config.paper[f] < 0) {
      errors.push(`paper.${f} must be >= 0`);
    }
  }
  if (config.paper?.tradeSizeUsd >= config.paper?.startingCashUsd) {
    errors.push("paper.tradeSizeUsd must be < startingCashUsd");
  }
  if (positiveOrNull(config.paper?.ataRentSol) === null) {
    errors.push("paper.ataRentSol must be > 0");
  }

  // Watchlist snapshots & discovery bounds
  const offsets = config.watchlist?.snapshotOffsetsMinutes;
  if (Array.isArray(offsets)) {
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i] <= 0)
        errors.push(
          `watchlist.snapshotOffsetsMinutes contains non-positive offset: ${offsets[i]}`,
        );
      if (i > 0 && offsets[i] <= offsets[i - 1]) {
        errors.push(
          "watchlist.snapshotOffsetsMinutes must be strictly ascending",
        );
        break;
      }
    }
  }
  const pages = config.discovery?.geckoTerminalNewPools?.pages;
  if (!Number.isInteger(pages) || pages < 1 || pages > 5) {
    errors.push(
      "discovery.geckoTerminalNewPools.pages must be an integer between 1 and 5",
    );
  }
  const batchSize = config.discovery?.dexScreenerBatchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 30) {
    errors.push(
      "discovery.dexScreenerBatchSize must be an integer between 1 and 30",
    );
  }

  // Exit priority exact contents
  const ep = config.exits?.exitPriority;
  if (Array.isArray(ep)) {
    const set = new Set(ep);
    if (
      set.size !== REQUIRED_EXIT_PRIORITY.length ||
      !REQUIRED_EXIT_PRIORITY.every((k) => set.has(k))
    ) {
      errors.push(
        `exits.exitPriority must contain exactly [${REQUIRED_EXIT_PRIORITY.join(", ")}] once each`,
      );
    }
  }

  // URLs
  checkUrl(
    config.discovery?.geckoTerminalNewPools?.url,
    "discovery.geckoTerminalNewPools.url",
    errors,
  );
  checkUrl(
    config.discovery?.dexScreenerProfiles?.url,
    "discovery.dexScreenerProfiles.url",
    errors,
  );
  checkUrl(
    config.discovery?.dexScreenerPairsBatchUrl,
    "discovery.dexScreenerPairsBatchUrl",
    errors,
  );
  const rugUrl = config.security?.rugCheckReportUrlTemplate;
  if (typeof rugUrl === "string") {
    if (!rugUrl.includes("{mint}")) {
      errors.push('security.rugCheckReportUrlTemplate must contain "{mint}"');
    }
    checkUrl(
      rugUrl.replace("{mint}", "testMint"),
      "security.rugCheckReportUrlTemplate",
      errors,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Config validation failed with ${errors.length} error(s):\n  - ${errors.join("\n  - ")}`,
    );
  }

  return true;
}

// Read, compute SHA-256 of raw bytes, validate, and return deep-frozen config and hash
export function loadConfig(configPath = "data/paper-scanner/config.json") {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at: ${configPath}`);
  }
  const rawBytes = fs.readFileSync(configPath);
  const hash = sha256(rawBytes);

  let parsed = null;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch (err) {
    throw new Error(
      `Config file at ${configPath} is not valid JSON: ${err.message}`,
    );
  }

  const unknown = findUnknownKeys(parsed);
  if (unknown.length > 0) {
    console.warn(
      `[CONFIG] Unknown keys detected in ${configPath}: ${unknown.join(", ")}`,
    );
  }

  validateConfig(parsed);

  return {
    config: deepFreeze(parsed),
    configHash: hash,
    unknownKeys: unknown,
  };
}
