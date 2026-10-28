import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Return number or null. Only accepts numbers or non-empty trimmed strings.
export function numOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// Return number strictly > 0, or null
export function positiveOrNull(value) {
  const num = numOrNull(value);
  return num !== null && num > 0 ? num : null;
}

// Return ISO timestamp string
export function nowIso() {
  return new Date().toISOString();
}

// Sleep for given milliseconds
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// Round number to decimal places.
// WARNING: NEVER use on prices or token quantities. ONLY on USD amounts and percentages.
export function round(value, decimals = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

// Calculate SHA-256 hex string of string or buffer
export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Validate whether a value is a non-empty trimmed string
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Safely compute percentage (a / b * 100) or null
export function pct(numerator, denominator, decimals = 2) {
  const n = numOrNull(numerator);
  const d = numOrNull(denominator);
  if (n === null || d === null || d === 0) return null;
  return round((n / d) * 100, decimals);
}

// Atomically write JSON data using temp file, fsync, close, rename, and cleanup on failure
export function atomicWriteJson(filePath, data, spaces = 2) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'w');
    const serialized = JSON.stringify(data, null, spaces);
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error during cleanup
      }
    }
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore unlink error during cleanup
      }
    }
    throw err;
  }
}

// Read JSON file safely, returning null if missing
export function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}
