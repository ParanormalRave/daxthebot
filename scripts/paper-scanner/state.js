import fs from 'node:fs';
import { readJson, atomicWriteJson, isNonEmptyString, numOrNull } from './util.js';

// Check that a value is a plain non-array object
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Create initial state object per spec schema version 1
export function createInitialState(config, configHash, nowIso) {
  if (!config || !config.paper || typeof config.paper.startingCashUsd !== 'number') {
    throw new Error('Invalid config supplied to createInitialState');
  }
  if (!isNonEmptyString(configHash)) {
    throw new Error('Invalid configHash supplied to createInitialState');
  }
  return {
    schemaVersion: 1,
    configHash,
    runStartedAt: nowIso,
    updatedAt: nowIso,
    cashUsd: config.paper.startingCashUsd,
    lockedAtaRentUsd: 0,
    realizedPnlUsd: 0,
    positions: {},
    watchlist: {},
    dedupe: {
      mints: {},
      pools: {},
    },
    counters: {},
    entryRejectionsByRule: {},
    securityRejectionsByReason: {},
    closedTrades: 0,
    ataRentReleaseEvents: 0,
    equityCurve: [],
    unknownDexIdsSeen: {},
    acceptedConfigChanges: [],
  };
}

// Load state from path, throwing if corrupt or schemaVersion differs
export function loadState(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let parsed = null;
  try {
    parsed = readJson(filePath);
  } catch (err) {
    throw new Error(`Corrupt state JSON file at ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) {
    throw new Error(`Invalid or unsupported state schemaVersion in ${filePath}`);
  }
  validateState(parsed);
  return parsed;
}

// Save state atomically after validating the exact object that will be written
export function saveState(filePath, state, nowIso) {
  if (!state || typeof state !== 'object') {
    throw new Error('Invalid state object passed to saveState');
  }
  state.updatedAt = nowIso;
  validateState(state);
  atomicWriteJson(filePath, state);
}

// Check if config hash matches state hash, handling accept flag
export function checkResumeHash(state, configHash, accept = false, nowIso) {
  if (!state || !isNonEmptyString(configHash)) {
    throw new Error('Invalid arguments to checkResumeHash');
  }
  if (accept && !isNonEmptyString(nowIso)) {
    throw new Error('checkResumeHash requires a non-empty nowIso when accept is true');
  }
  if (state.configHash !== configHash) {
    if (!accept) {
      throw new Error(
        `Config hash mismatch! State hash: ${state.configHash}, Config hash: ${configHash}. Run with --accept-config-change to update state hash.`,
      );
    }
    const record = {
      at: nowIso,
      from: state.configHash,
      to: configHash,
    };
    if (!Array.isArray(state.acceptedConfigChanges)) {
      state.acceptedConfigChanges = [];
    }
    state.acceptedConfigChanges.push(record);
    state.configHash = configHash;
  }
}

// Prune dedupe maps older than ttlMs or over hardCap limit
export function pruneDedupe(state, nowMs, ttlMs, hardCap) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`pruneDedupe requires a positive finite ttlMs, got ${ttlMs}`);
  }
  if (!Number.isFinite(hardCap) || hardCap <= 0) {
    throw new Error(`pruneDedupe requires a positive finite hardCap, got ${hardCap}`);
  }
  if (!state || !state.dedupe) return;
  for (const type of ['mints', 'pools']) {
    const map = state.dedupe[type];
    if (!map || typeof map !== 'object') continue;

    // Remove entries older than ttlMs
    for (const [key, timestamp] of Object.entries(map)) {
      if (typeof timestamp === 'number' && nowMs - timestamp > ttlMs) {
        delete map[key];
      }
    }

    // If still above hardCap, remove oldest entries
    const entries = Object.entries(map)
      .filter(([, ts]) => typeof ts === 'number')
      .sort((a, b) => a[1] - b[1]);

    if (entries.length > hardCap) {
      const toRemoveCount = entries.length - hardCap;
      for (let i = 0; i < toRemoveCount; i++) {
        delete map[entries[i][0]];
      }
    }
  }
}

// Safely increment counter by n (default 1)
export function bump(state, name, n = 1) {
  if (!state) return;
  if (!state.counters || typeof state.counters !== 'object') {
    state.counters = {};
  }
  const current = state.counters[name] || 0;
  state.counters[name] = current + n;
}

// Record equity point, preserving only the newest 5000 entries
export function recordEquity(state, point, nowIso) {
  if (!state) return;
  if (!Array.isArray(state.equityCurve)) {
    state.equityCurve = [];
  }
  const entry = {
    ts: nowIso,
    ...point,
  };
  state.equityCurve.push(entry);
  if (state.equityCurve.length > 5000) {
    state.equityCurve.splice(0, state.equityCurve.length - 5000);
  }
}

// Validate structural integrity, collecting every problem before throwing once
export function validateState(state) {
  if (!isPlainObject(state)) {
    throw new Error('State must be a non-null non-array object');
  }

  const problems = [];

  // Require a plain non-array object at the given path
  const requireObject = (value, fieldPath) => {
    if (!isPlainObject(value)) problems.push(`${fieldPath} must be a plain object`);
  };

  // Require an array at the given path
  const requireArray = (value, fieldPath) => {
    if (!Array.isArray(value)) problems.push(`${fieldPath} must be an array`);
  };

  // Require a finite number at the given path
  const requireFiniteNumber = (value, fieldPath) => {
    if (numOrNull(value) === null) problems.push(`${fieldPath} must be a finite number`);
  };

  // Require a non-empty string at the given path
  const requireNonEmptyString = (value, fieldPath) => {
    if (!isNonEmptyString(value)) problems.push(`${fieldPath} must be a non-empty string`);
  };

  if (state.schemaVersion !== 1) {
    problems.push(`schemaVersion must be 1, got ${state.schemaVersion}`);
  }

  requireObject(state.positions, 'positions');
  requireObject(state.watchlist, 'watchlist');
  requireObject(state.counters, 'counters');
  requireObject(state.dedupe, 'dedupe');
  requireObject(state.dedupe?.mints, 'dedupe.mints');
  requireObject(state.dedupe?.pools, 'dedupe.pools');
  requireObject(state.entryRejectionsByRule, 'entryRejectionsByRule');
  requireObject(state.securityRejectionsByReason, 'securityRejectionsByReason');
  requireObject(state.unknownDexIdsSeen, 'unknownDexIdsSeen');

  requireArray(state.equityCurve, 'equityCurve');
  requireArray(state.acceptedConfigChanges, 'acceptedConfigChanges');

  requireFiniteNumber(state.closedTrades, 'closedTrades');
  requireFiniteNumber(state.ataRentReleaseEvents, 'ataRentReleaseEvents');
  requireFiniteNumber(state.realizedPnlUsd, 'realizedPnlUsd');
  requireFiniteNumber(state.cashUsd, 'cashUsd');
  requireFiniteNumber(state.lockedAtaRentUsd, 'lockedAtaRentUsd');
  if (numOrNull(state.cashUsd) !== null && state.cashUsd < 0) {
    problems.push(`cashUsd must be >= 0, got ${state.cashUsd}`);
  }
  if (numOrNull(state.lockedAtaRentUsd) !== null && state.lockedAtaRentUsd < 0) {
    problems.push(`lockedAtaRentUsd must be >= 0, got ${state.lockedAtaRentUsd}`);
  }

  requireNonEmptyString(state.configHash, 'configHash');
  requireNonEmptyString(state.runStartedAt, 'runStartedAt');
  requireNonEmptyString(state.updatedAt, 'updatedAt');

  if (problems.length > 0) {
    throw new Error(`State validation failed with ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }
}
