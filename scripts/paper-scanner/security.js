import { isNonEmptyString, numOrNull } from './util.js';

// Build the mandatory details object with every required field present
function emptyDetails() {
  return {
    mintAuthorityState: null,
    freezeAuthorityState: null,
    top10Percent: null,
    maxHolderPercent: null,
    lpLockedPercent: null,
    marketType: null,
    dexId: null,
    marketMatched: false,
    authorityPaths: { mint: 'missing', freeze: 'missing' },
    recordOnly: {
      rugged: null,
      scoreNormalised: null,
      totalHolders: null,
      insidersDetected: null,
    },
  };
}

// Return true when a value is a plain non-array object
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Classify an authority value: null revoked, non-empty string active, empty/missing unknown
function authorityState(value) {
  if (value === null) return 'revoked';
  if (isNonEmptyString(value)) return 'active';
  return 'unknown';
}

// Find an authority field in report.token first, then at the report top level
function findAuthority(report, field) {
  if (isObject(report.token) && Object.prototype.hasOwnProperty.call(report.token, field)) {
    return { value: report.token[field], path: `token.${field}` };
  }
  if (Object.prototype.hasOwnProperty.call(report, field)) {
    return { value: report[field], path: field };
  }
  return { value: undefined, path: 'missing' };
}

// Add one trimmed address string to the exclusion set
function addAddress(addressSet, value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    addressSet.add(value.trim());
  }
}

// Collect pool, AMM and LP account addresses from report.markets when exclusion is enabled
function collectExcludedAddresses(report, config) {
  if (config?.security?.excludePoolAndAmmAccountsFromHolders !== true) return new Set();
  const addresses = new Set();
  const markets = Array.isArray(report.markets) ? report.markets : [];
  const marketFields = [
    'pubkey',
    'mintA',
    'mintB',
    'mintLP',
    'mintAAccount',
    'mintBAccount',
    'mintLPAccount',
    'liquidityAAccount',
    'liquidityBAccount',
  ];
  for (const market of markets) {
    if (!isObject(market)) continue;
    for (const field of marketFields) {
      addAddress(addresses, market[field]);
    }
    if (isObject(market.lp)) {
      addAddress(addresses, market.lp.lpMint);
      addAddress(addresses, market.lp.baseMint);
      addAddress(addresses, market.lp.quoteMint);
    }
  }
  return addresses;
}

// Return the report market whose pubkey exactly equals the trimmed pair address
function findMarketByPairAddress(report, pairAddress) {
  const wanted = isNonEmptyString(pairAddress) ? pairAddress.trim() : null;
  if (wanted === null) return null;
  const markets = Array.isArray(report.markets) ? report.markets : [];
  for (const market of markets) {
    if (!isObject(market)) continue;
    if (typeof market.pubkey === 'string' && market.pubkey.trim() === wanted) return market;
  }
  return null;
}

// Read lpLockedPercent, falling back to lpLocked/lpTotalSupply when the percentage is absent
function readLpLockedPercent(market) {
  if (!isObject(market) || !isObject(market.lp)) return null;
  const direct = numOrNull(market.lp.lpLockedPct);
  if (direct !== null) return direct;
  const locked = numOrNull(market.lp.lpLocked);
  const total = numOrNull(market.lp.lpTotalSupply);
  if (locked !== null && total !== null && total > 0) {
    return (locked / total) * 100;
  }
  return null;
}

// Extract a DexScreener-style dexId from the report when one is present
function readDexId(report, market) {
  if (isNonEmptyString(report.dexId)) return report.dexId.trim();
  if (isNonEmptyString(report.market?.dexId)) return report.market.dexId.trim();
  if (isNonEmptyString(market?.dexId)) return market.dexId.trim();
  return null;
}

// Compute top-10 and largest-holder percentages after excluding pool/AMM/LP accounts
function computeHolderConcentration(report, excluded) {
  if (!Array.isArray(report.topHolders) || report.topHolders.length === 0) {
    return { unknown: true, top10Percent: null, maxHolderPercent: null };
  }

  const percentages = [];
  for (const holder of report.topHolders) {
    if (!isObject(holder)) {
      return { unknown: true, top10Percent: null, maxHolderPercent: null };
    }
    const pct = numOrNull(holder.pct);
    if (pct === null) {
      return { unknown: true, top10Percent: null, maxHolderPercent: null };
    }
    const address = typeof holder.address === 'string' ? holder.address.trim() : '';
    const owner = typeof holder.owner === 'string' ? holder.owner.trim() : '';
    if ((address && excluded.has(address)) || (owner && excluded.has(owner))) {
      continue;
    }
    percentages.push(pct);
  }

  percentages.sort((a, b) => b - a);
  const top10Percent = percentages.slice(0, 10).reduce((sum, pct) => sum + pct, 0);
  const maxHolderPercent = percentages.length > 0 ? percentages[0] : 0;
  return { unknown: false, top10Percent, maxHolderPercent };
}

// Check whether unknown authority data must be rejected under the configured action
function rejectsUnknown(config) {
  return config.security.unknownAuthorityAction === 'reject_and_log';
}

// Read record-only RugCheck fields without letting them affect the decision
function readRecordOnly(report) {
  const insiders = report.graphInsidersDetected;
  return {
    rugged: typeof report.rugged === 'boolean' ? report.rugged : null,
    scoreNormalised: numOrNull(report.score_normalised),
    totalHolders: numOrNull(report.totalHolders),
    insidersDetected:
      typeof insiders === 'boolean' || (typeof insiders === 'number' && Number.isFinite(insiders))
        ? insiders
        : null,
  };
}

// Run all security checks over a RugCheck report without throwing
export function checkSecurity(report, config, context) {
  const details = emptyDetails();

  try {
    const ctx = isObject(context) ? context : null;
    if (ctx !== null && isNonEmptyString(ctx.dexId)) {
      details.dexId = ctx.dexId.trim();
    }

    if (!isObject(report) || !isObject(config?.security)) {
      return { passed: false, reasons: ['security_parse_error'], details };
    }

    const security = config.security;
    const market = findMarketByPairAddress(report, ctx?.pairAddress);
    details.marketMatched = market !== null;
    if (details.dexId === null) {
      details.dexId = readDexId(report, market);
    }
    details.marketType = market !== null && isNonEmptyString(market.marketType) ? market.marketType.trim() : null;
    details.lpLockedPercent = market !== null ? readLpLockedPercent(market) : null;

    const mintAuthority = findAuthority(report, 'mintAuthority');
    const freezeAuthority = findAuthority(report, 'freezeAuthority');
    details.authorityPaths = { mint: mintAuthority.path, freeze: freezeAuthority.path };
    details.mintAuthorityState = authorityState(mintAuthority.value);
    details.freezeAuthorityState = authorityState(freezeAuthority.value);
    details.recordOnly = readRecordOnly(report);

    const reasons = [];

    if (security.requireMintAuthorityRevoked === true) {
      if (details.mintAuthorityState === 'active') {
        reasons.push('mint_authority_active');
      } else if (details.mintAuthorityState === 'unknown' && rejectsUnknown(config)) {
        reasons.push('mint_authority_unknown');
      }
    }

    if (security.requireFreezeAuthorityRevoked === true) {
      if (details.freezeAuthorityState === 'active') {
        reasons.push('freeze_authority_active');
      } else if (details.freezeAuthorityState === 'unknown' && rejectsUnknown(config)) {
        reasons.push('freeze_authority_unknown');
      }
    }

    const excluded = collectExcludedAddresses(report, config);
    const holders = computeHolderConcentration(report, excluded);
    details.top10Percent = holders.top10Percent;
    details.maxHolderPercent = holders.maxHolderPercent;

    if (holders.unknown) {
      if (rejectsUnknown(config)) reasons.push('holders_unknown');
    } else {
      if (typeof security.maxTop10HoldersPercent === 'number' && holders.top10Percent > security.maxTop10HoldersPercent) {
        reasons.push('top10_holders_too_high');
      }
      if (typeof security.maxSingleHolderPercent === 'number' && holders.maxHolderPercent > security.maxSingleHolderPercent) {
        reasons.push('single_holder_too_high');
      }
    }

    const minLpLocked = numOrNull(security.minLpLockedOrBurnedPercent);
    if (details.lpLockedPercent !== null && minLpLocked !== null) {
      if (details.lpLockedPercent < minLpLocked) {
        reasons.push('lp_locked_too_low');
      }
    } else if (details.lpLockedPercent === null && minLpLocked !== null && minLpLocked > 0) {
      reasons.push('lp_locked_unknown');
    }

    return {
      passed: reasons.length === 0,
      reasons,
      details,
    };
  } catch (err) {
    return { passed: false, reasons: ['security_parse_error'], details };
  }
}

// Decide whether another raw RugCheck report should be saved
export function shouldSaveRaw(state, config) {
  const saved = numOrNull(state?.counters?.rugCheckRawReportsSaved) ?? 0;
  const limit = numOrNull(config?.security?.saveFirstNRawReports);
  if (limit === null || limit <= 0) return false;
  return saved < limit;
}
