import fs from 'node:fs';
import path from 'node:path';

// Build a JSON replacer that nulls non-finite numbers and BigInt, and optionally truncates long strings
function makeReplacer(truncateStrings) {
  return function replacer(key, value) {
    if (typeof value === 'bigint') return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (truncateStrings && typeof value === 'string' && value.length > 2000) {
      return value.slice(0, 2000);
    }
    return value;
  };
}

// Ensure the parent folder for a log file exists
function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Append one JSONL row to a file, counting failures so loops never die
function appendRow(filePath, row, truncateStrings, stats) {
  try {
    ensureParentDir(filePath);
    const serialized = JSON.stringify(row, makeReplacer(truncateStrings));
    if (typeof serialized !== 'string') {
      throw new Error('serialization produced non-string');
    }
    fs.appendFileSync(filePath, serialized + '\n', 'utf8');
    stats.rowsWritten += 1;
  } catch (err) {
    stats.appendFailures += 1;
    stats.lastAppendError = err && err.message ? err.message : String(err);
    console.error(`[LOGGER] append failed for ${filePath}: ${stats.lastAppendError}`);
  }
}

// Merge mandatory metadata with event fields, protecting the mandatory keys
function buildRow(base, fields) {
  const safeFields = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : { value: fields };
  return {
    ...safeFields,
    ts: base.ts,
    configHash: base.configHash,
    strategyName: base.strategyName,
    version: base.version,
  };
}

// Create a logger bound to config paths and the frozen config hash
export function createLogger(config, configHash) {
  if (!config || !config.paths) {
    throw new Error('createLogger requires config with paths');
  }
  if (typeof configHash !== 'string' || configHash.length === 0) {
    throw new Error('createLogger requires a non-empty configHash');
  }

  const paths = {
    observations: config.paths.observationsLog,
    snapshots: config.paths.snapshotsLog,
    trades: config.paths.tradesLog,
    rugSamples: config.paths.rugCheckSamplesLog,
  };

  for (const [name, filePath] of Object.entries(paths)) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new Error(`createLogger: missing path for ${name}`);
    }
    ensureParentDir(filePath);
  }

  const stats = {
    appendFailures: 0,
    lastAppendError: null,
    rowsWritten: 0,
  };

  // Build the mandatory metadata for every row at write time
  const makeBase = () => ({
    ts: new Date().toISOString(),
    configHash,
    strategyName: config.strategyName,
    version: config.version,
  });

  // Append one discovery observation row
  const logObservation = (fields) => {
    appendRow(paths.observations, buildRow(makeBase(), fields), true, stats);
  };

  // Append one price snapshot row
  const logSnapshot = (fields) => {
    appendRow(paths.snapshots, buildRow(makeBase(), fields), true, stats);
  };

  // Append one paper trade row
  const logTrade = (fields) => {
    appendRow(paths.trades, buildRow(makeBase(), fields), true, stats);
  };

  // Append one raw RugCheck sample without string truncation
  const logRugSample = (fields) => {
    appendRow(paths.rugSamples, buildRow(makeBase(), fields), false, stats);
  };

  // Report a fatal condition to stderr only, never to a log file
  const logFatal = (message, error) => {
    const detail = error && error.stack ? error.stack : error ? String(error) : '';
    console.error(`[PAPER-SCANNER FATAL] ${message}${detail ? `: ${detail}` : ''}`);
  };

  // Return a snapshot of internal append counters
  const getStats = () => ({ ...stats });

  // Close the logger; appendFileSync needs no buffer flush but keeps the API stable
  const close = () => {};

  return {
    logObservation,
    logSnapshot,
    logTrade,
    logRugSample,
    logFatal,
    close,
    getStats,
  };
}
