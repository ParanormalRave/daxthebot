PAPER-SCANNER SPEC (pre-registered, do not deviate). Branch paper-scanner. Files only in scripts/paper-scanner/ and data/paper-scanner/.

GLOBAL RULES (every module)
G1 Imports: only node: builtins and sibling files. Never src/, never wallet/jupiter/solana code, never process.env or .env, no new dependencies.
G2 ES modules, plain JavaScript, named exports only, a one-line comment on every function.
G3 Every tunable comes from the frozen config passed in. No hard-coded thresholds. Allowed constants: unit conversions (1000, 60000, 10000 for bps) and the two quote mints: WSOL So11111111111111111111111111111111111111112, USDC EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
G4 Solana mint and pool addresses are case-sensitive. Never lowercase them. Trim only.
G5 Null, undefined, NaN or a missing numeric metric means UNKNOWN. Unknown is never treated as 0. Use numOrNull.
G6 round() only for USD amounts and percentages. Never for prices, token quantities or ratios used in decisions.
G7 Time is passed in as nowMs or nowIso. Pure modules never call Date.now().
G8 Pure modules (filters, security, paperEngine, selftest, summarize math) do no I/O.
G9 One bad row never kills a loop: try/catch per row, count it, continue. Only programmer errors (wrong argument types) may throw.
G10 Never mutate config. Never write outside data/paper-scanner/.
G11 After each module: run node --check on it, print path, exports and assumptions, then STOP and wait for my reply. One module per turn, one tool call at a time (free-tier rate limit).
G12 No network call until I say so.
G13 If this spec is ambiguous or conflicts with config.json, ask me. Never guess.

BUILD ORDER: config (fix pass), state, logger, filters, paperEngine, selftest, security, http, discovery, watchlist, summarize, summarize-cli, dryConfig, main. After selftest is written, STOP so I can run it.

MODULE config.js (fix pass)
- validateConfig is schema-driven: every key in KNOWN_CONFIG_KEYS is required with its exact type (finite numbers, non-empty strings, booleans, arrays). Collect ALL errors and throw once with the full list.
- Logic checks: every {min,max} has min<=max; hardStopPercent<0; breakeven lockAtGainPercent<armAtGainPercent; trailing and moonbag distances in (0,100); takeProfit1.gainPercent<takeProfit2.gainPercent; takeProfit1.sellPercentOfHoldings in (0,100); takeProfit2.sellPercentOfHoldings==100; recoveryFractionOfRemainingCost in [0,1]; all bps>=0; tradeSizeUsd<startingCashUsd; ataRentSol>0; snapshotOffsetsMinutes ascending positive; geckoTerminal pages an integer 1-5; dexScreenerBatchSize<=30; exitPriority contains exactly RUG, HARD_STOP, TRAILING_STOP, BREAKEVEN_STOP, MAX_HOLD, STAGNANT_STOP, TAKE_PROFIT_2, TAKE_PROFIT_1 once each; fillModel==worse_of_last_two_observed_prices; onApiFailure and unknownAuthorityAction==reject_and_log; chainId==solana; mode==PAPER_ONLY; every URL is https with host in {api.geckoterminal.com, api.dexscreener.com, api.rugcheck.xyz}; the rugCheck template contains {mint}.
- Return a deep-frozen config. Drop rawBytes from the return value. Unknown keys: warn only.
- Containment is resolved against process.cwd(); fail clearly if package.json is not there.

MODULE state.js
- createInitialState(config, configHash, nowIso): schemaVersion 1, configHash, runStartedAt, updatedAt, cashUsd=startingCashUsd, lockedAtaRentUsd 0, realizedPnlUsd 0, positions {} keyed by mint, watchlist {} keyed by mint, dedupe {mints:{}, pools:{}}, counters {}, entryRejectionsByRule {}, securityRejectionsByReason {}, closedTrades 0, ataRentReleaseEvents 0, equityCurve [], unknownDexIdsSeen {}, acceptedConfigChanges [].
- loadState(path): null if the file is missing. If the JSON is corrupt or schemaVersion differs, THROW. Never silently reset.
- saveState(path, state, nowIso): sets updatedAt, writes via atomicWriteJson only.
- checkResumeHash(state, configHash, accept): mismatch and not accept -> throw a clear message. With accept: update the hash and append {at, from, to} to acceptedConfigChanges. Never reset anything.
- pruneDedupe(state, nowMs, ttlMs, hardCap): drop entries older than ttl, then drop oldest-first above hardCap.
- bump(state, name, n=1). recordEquity(state, point, nowIso) keeps the newest 5000 points only. validateState(state): types, cashUsd>=0, lockedAtaRentUsd>=0.

MODULE logger.js
- createLogger(config, configHash) returns logObservation, logSnapshot, logTrade, logRugSample, logFatal, close, getStats. getStats() returns {appendFailures,lastAppendError,rowsWritten}. A failed append is counted, never thrown. main.js copies appendFailures into state counters and summarize treats appendFailures>0 as an operational failure.
- Append-only JSONL using fs.appendFileSync, folders created if missing. Never read or rewrite existing lines.
- Every row gets ts (ISO), configHash, strategyName, version, then the event fields.
- One line per row. JSON replacer turns NaN, Infinity and BigInt into null. Strings over 2000 chars are truncated, except rugCheck raw samples.
- logFatal writes to console.error only. Never log secrets, headers or full HTTP bodies except RugCheck raw samples.

MODULE filters.js (pure)
- evaluateEntryFilter(pair, config, nowMs) returns {passed, failedRules[], missingData, metrics}.
- Metrics (DexScreener pair): ageMinutes=(nowMs-pairCreatedAt)/60000 of THIS pair; liquidity.usd; fdv; volume.m5; volume.h1; txns.m5.buys and sells; priceChange.m5 and h1; dexId.
- Rules, each with its own name: dex_not_tradable, age_min, age_max, liquidity_min, liquidity_max, fdv_min, fdv_max, fdv_to_liquidity_ratio, vol1h_to_liquidity_ratio, volume5m_min, volume1h_min, buys5m_min, buy_sell_ratio, price5m_min, price5m_max, price1h_min, price1h_max.
- Boundaries are inclusive. A missing metric adds "missing:<field>" and fails (rejectOnNull). Ratios are only computed when the denominator>0. If sells5m==0 and buys5m>0 the buy/sell ratio passes.
- Return ALL failed rules, not just the first. No I/O.

MODULE paperEngine.js (pure, most important)
- Costs: solPrice is passed in. ataRentUsd=ataRentSol*solPrice; networkFeeUsd=swapNetworkFeeSol*solPrice; dexFeeUsd=notional*dexFeeBps/10000.
- canAfford(state, config, mint, solPrice): no open position for the mint; open positions<maxConcurrentPositions; cashUsd-(tradeSizeUsd+ataRentUsd+networkFeeUsd+dexFeeUsd)>=minSolGasBufferUsd.
- Buy fill: base price=MAX(last two observed prices, or the single one if only one exists); R=liquidityUsd/2; fillPrice=base*(1+entrySlippageBps/10000)*(1+notional/R). Missing liquidity -> refuse entry. qty=notional/fillPrice. Cash debit=notional+dexFeeUsd+networkFeeUsd+ataRentUsd (rent debited once per position, moved to lockedAtaRentUsd). costBasisUsd=notional+dexFeeUsd+networkFeeUsd (rent excluded).
- Sell fill: base=MIN(last two observed prices, or the single one); slippage=stopExitSlippageBps for HARD_STOP, TRAILING_STOP and BREAKEVEN_STOP exits, else normalExitSlippageBps; grossValue=qtySold*base*(1-slippage/10000); impactFactor=1-grossValue/(R+grossValue); proceeds=grossValue*impactFactor-dexFee-networkFee, clamped at >=0.
- Position fields: mint, pairAddress, entryAtMs, entryPrice (fill price), entryLiquidityUsd, qtyRemaining, costBasisRemainingUsd, peakPrice, tp1Done, rentLockedUsd, lastPrice, history of the last two observed prices.
- gain=observedPrice/entryPrice-1 on the OBSERVED price. Peak updates BEFORE exit evaluation. peakGain=peakPrice/entryPrice-1.
- evaluateExits(position, obs, nowMs, config): walk config.exits.exitPriority in order, first match wins, ONE action per position per check.
  RUG: pair missing from a SUCCESSFUL response, or liquidity null or 0, or liquidity < triggerIfLiquidityUsdBelow, or drop from entryLiquidityUsd >= triggerIfLiquidityDropFromEntryPercent, or priceChange.m5 <= triggerIfPriceChange5mAtOrBelowPercent. Close ALL at recoveryFractionOfRemainingCost*costBasisRemainingUsd minus exit dex and network fees, clamped >=0, no slippage or impact.
  HARD_STOP: gain<=hardStopPercent.
  TRAILING_STOP: armed when peakGain>=trailingStop.armAtGainPercent; stopPrice=peakPrice*(1-trailDistance/100) (relative to price, never percentage points). After TP1 use moonbag.trailDistanceFromPeakPercent.
  BREAKEVEN_STOP: armed when peakGain>=breakevenStop.armAtGainPercent; stopPrice=entryPrice*(1+lockAtGainPercent/100).
  Active stop=the HIGHEST stop price among hard, armed breakeven and armed trailing. Exit if observed price<=active stop. Reason=the rule that supplies it (ties: trailing, then breakeven, then hard).
  CLARIFICATION: HARD_STOP, TRAILING_STOP and BREAKEVEN_STOP are ONE combined check using the highest stop price. exitPriority only orders the groups: RUG, STOPS, MAX_HOLD, STAGNANT_STOP, TAKE_PROFIT_2, TAKE_PROFIT_1. The logged reason is the rule that supplies the highest stop price.
  MAX_HOLD: holdMinutes>=maxHoldMinutes -> close all.
  STAGNANT_STOP: holdMinutes>=checkAfterMinutes AND gain<minGainPercent AND peakGain<skipIfPeakGainAtOrAbovePercent AND NOT tp1Done -> close all.
  TAKE_PROFIT_2: gain>=takeProfit2.gainPercent -> sell 100% of what remains.
  TAKE_PROFIT_1: NOT tp1Done AND gain>=takeProfit1.gainPercent -> sell takeProfit1.sellPercentOfHoldings of qtyRemaining, set tp1Done, set peakPrice = the TP1 fill price, switch to moonbag trailing. The breakeven floor stays active.
- closeFraction(state, position, fraction, fill, reason, nowIso): fraction in (0,1]. pnl=proceeds-costBasisSold. cashUsd+=proceeds; realizedPnlUsd+=pnl; costBasisRemaining and qty shrink. On full close: release rentLockedUsd into cashUsd, ataRentReleaseEvents++, closedTrades++, delete the position. PnL never includes rent.
- Equity points: equityCostBasisUsd=cashUsd+lockedAtaRentUsd+sum(open costBasisRemainingUsd); equityMarkUsd=cashUsd+lockedAtaRentUsd+sum(qtyRemaining*lastPrice). The balance floor uses equityCostBasisUsd.
- checkRentInvariant(state): lockedAtaRentUsd equals the sum of open positions' rent; ataRentReleaseEvents equals closedTrades; cashUsd>=0. Throw with details if broken.
- Exports: canAfford, computeBuyFill, computeSellFill, computeRugFill, openPosition, evaluateExits, closeFraction, equityPoint, checkRentInvariant.

MODULE selftest.js (pure, no network, no files)
- Expected values are HAND-COMPUTED in comments. Do not derive them by calling the functions under test.
- Scenarios: rug via missing pair; rug via liquidity 0; rug proceeds never negative; hard stop; breakeven floor; relative trailing (peak 1.70x -> stop 1.36x); stagnant exit; stagnant skipped when peakGain>=40%; TP1 then moonbag trailing from the TP1 fill price; TP2; TP1 and TP2 on the same tick -> TP2 wins; max hold; first observation uses the single price; budget check refuses a second position at tradeSize 2.10 with SOL=180 but allows it at 1.70 at both SOL=180 and SOL=200; rent invariant across a full sequence.
- Print expected vs actual per scenario; exit code 1 on any mismatch. After writing it, run it, then STOP.

MODULE security.js (pure over a report object)
- checkSecurity(report, config) returns {passed, reasons[], details}. details ALWAYS includes mintAuthorityState, freezeAuthorityState, top10Percent, maxHolderPercent, lpLockedPercent, marketType, dexId.
- authorityState: null -> revoked; non-empty string -> active; ""/undefined -> unknown. Look in report.token first, then top level. Record which path was used in NOTES.md.
- requireMintAuthorityRevoked / requireFreezeAuthorityRevoked: active -> fail; unknown -> unknownAuthorityAction (reject_and_log -> fail with reason).
- Holders: exclude pool, AMM and LP accounts (addresses from report.markets). Compute top 10 sum and the max single holder after exclusion. Missing holder data -> unknown -> reject_and_log.
- LP: reject ONLY if lpLockedPercent < minLpLockedOrBurnedPercent. Unknown LP -> reject only if the minimum > 0.
- Wrap in try/catch; a weird report returns passed=false with reason security_parse_error. Never throws.
- shouldSaveRaw(state, config): true while saved raw reports < saveFirstNRawReports.

MODULE http.js
- Hosts allowlist from config; https only; any other host throws (programmer error).
- requestJson(url): AbortSignal.timeout(httpTimeoutMs); max 3 attempts on network errors, 429 and 5xx; 429 honours Retry-After else backoffOn429Sec; no retry on other 4xx; returns {ok,status,data,error}; never throws on HTTP errors; header User-Agent dax-paper-scanner; no cookies, no keys.
- createLimiter(maxReqPerMin, minGapMs): one token-bucket queue PER HOST. A slow host never blocks another.
- Helpers: geckoNewPools(page), dexProfiles(), dexTokens(mints) which rejects more than 30 mints and never alters case, rugCheckReport(mint), solPriceUsd() from the highest-liquidity DexScreener WSOL pair, cached 60 s, falling back to solPriceUsdFallback.
- getRequestStats() returns rolling per-host request counts.

MODULE discovery.js
- runDiscovery: fetch GeckoTerminal pages 1..pages staggered by geckoTerminalDelayBetweenPagesMs, plus DexScreener profiles. Normalize every row defensively; skip rows with a missing mint or pool.
- Gecko row: base_token id with the solana_ prefix stripped is the candidate; skip if the base is WSOL or USDC. Keep poolAddress, geckoDexId, poolCreatedAt (ISO to ms), reserve_in_usd and fdv_usd via numOrNull.
- Profile row: chainId must be solana. Record hasWebsite, hasTwitter, hasSocialLinks, isCtoFlag (cto), addressEndsWithPump. Profiles carry no reserve: reserveKnown=false and they ARE tracked.
- Dedupe by mint against state.dedupe. One observation per new mint, logged even if never tracked. If two sources report the same mint, keep the first and record alsoSeenIn.
- Below minReserveUsdToTrack: not tracked, but bump poolsDroppedBelowMinReserve and record the reason in the observation.
- Discovery NEVER decides tradability, never opens positions, never calls RugCheck.

MODULE watchlist.js
- States: launchpad_watch -> amm_candidate -> in_position -> closed, plus expired and dropped.
- Entry fields: mint, discoveredAtMs, firstSource, state, launchpadDexId, nextPollAtMs, snapshotsLogged[], firstPrice, maxPrice, minPrice, graduationAtMs, graduationDelayMinutes, ammPair{pairAddress,dexId,pairCreatedAtMs}.
- addEntry respects maxTrackedConcurrently; over the cap -> drop and bump droppedCapReached.
- pickTradablePair(pairs, config): chainId solana, dexId in tradableDexIds, then highest liquidity.usd. Pairs with a null pairCreatedAt are ignored for entry and counted.
- Poll cadence: launchpad_watch uses launchpadFirst60Min for the first 60 minutes after discovery, then launchpadAfter60Min; amm_candidate uses ammCandidate.
- Promotion: when a tradable pair first appears, state=amm_candidate and record graduationDelayMinutes. Expiry: launchpad_watch after launchpadTtlMinutes (droppedTtlExpired); amm_candidate when that pair's age passes ammCandidateTtlMinutes.
- Batches of at most 30 mints per call. If a batch FAILS: change nothing except a lastError counter and retry next tick. A mint missing from a SUCCESSFUL response is recorded as missing, never treated as an error.
- Snapshots: at each snapshotOffsetsMinutes from discovery (first poll at or after the offset, each logged once) with priceUsd, liquidityUsd, fdv, buys5m, sells5m, dexId, pairAgeMinutes, forwardReturnFromDiscoveryPct (vs firstPrice), maxDrawdownFromDiscoveryPct ((minPrice/firstPrice-1)*100), isMissing.
- Returns the list of amm_candidates polled this cycle with their chosen pair for the entry check. Never opens positions, never calls RugCheck.

MODULE summarize.js
- Stream the JSONL files line by line, skip corrupt or partial lines and count them. No network.
- Metrics: closedTrades, win rate, total and average PnL, expectancy per trade, profit factor (null if there are no losses), rug rate (exit reason RUG / closed trades), min equityCostBasisUsd and max drawdown, results by discoverySource and by exit reason, best and worst 5, entry rejections by rule, security rejections, graduationDelayMinutes min/median/p90, all drop counters, missing-data reject rate, and for every observed token whether it hit +100% before -28%.
- Scorecard from config.protocol: expectancy, profit factor, rug rate, balance floor, then operational checks (ataRentReleaseEvents==closedTrades, missing-data reject rate).
- Verdict: closedTrades<minTradesForVerdict -> INCONCLUSIVE, never PASS. Floor breach -> HARD FAIL. Otherwise PASS only if every criterion passes, else FAIL.
- Always print: results are conditional on tokens above the reserve floor and say nothing about the whole market.

MODULE summarize-cli.js: thin wrapper. Load config, run summarize, write summaryFile via atomicWriteJson, print the report. Reads nothing but config and logs.

MODULE dryConfig.js
- No network, no writes. Print the resolved config summary; the budget check for the 1st and 2nd position at solPriceUsdFallback; projected requests/min per host from the assumptions (30 new tokens/min, snapshot and poll cadence) flagged against config.rateLimits; estimated disk/day. Exit code 1 if any flag is raised.

MODULE main.js
- Flags: --selftest, --dry-config, --once, --accept-config-change, default loop. Unknown flag -> usage and exit 1.
- ONE sequential scheduler (never concurrent cycles). Each tick runs the due tasks in this order: position checks, watchlist cycle, discovery. Cycles never overlap.
- Entry flow per ready candidate: filters -> (only if passed) RugCheck through the limiter -> security -> canAfford -> openPosition -> logTrade -> saveState. Log every rejection with its rule names.
- Position check: DexScreener batch for open mints. API FAILURE -> skip that tick and count it (never a rug). Mint missing from a SUCCESSFUL response -> rug.
- Protocol: stop opening positions once closed trades>=maxTrades or maxDays have passed since runStartedAt or equityCostBasisUsd<minBalanceFloorUsd (record the reason; keep managing open positions until closed).
- State saved once per completed batch or trade event, atomically. Dedupe pruned every cycle.
- SIGINT/SIGTERM: stop scheduling, wait for the in-flight cycle (force exit after 5 s), save state, exit 0.
- --once works on an in-memory COPY of state. It writes no state and no logs, and prints what it would do.
- Startup banner: config hash, mode, tradeSizeUsd, unknown keys, and a warning if the hash changed.
