import fs from 'node:fs';

const STATUS_FILE = process.env.SCANNER_STATUS_FILE ?? '/home/scanner/dax-scanner/data/paper-scanner/status.txt';
const MAX_AGE_MIN = 5;

// Read a "key: value" text file into an object; null when missing or unreadable
function readKeyValues(filePath) {
  try {
    const out = {};
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  } catch {
    return null;
  }
}

// Read the scanner status file and add the age of the last update in minutes
export function readScannerStatus() {
  const s = readKeyValues(STATUS_FILE);
  if (!s) return null;
  const ageMin = (Date.now() - Date.parse(s.generatedAt)) / 60000;
  return { ...s, ageMin: Number.isFinite(ageMin) ? ageMin : null };
}

// Read a "key: value" text file into an object; null when missing or unreadable
function readKeyValues(filePath) {
  try {
    const out = {};
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  } catch {
    return null;
  }
}

// Read the scanner status file and add the age of the last update in minutes
export function readScannerStatus() {
  const s = readKeyValues(STATUS_FILE);
  if (!s) return null;
  const ageMin = (Date.now() - Date.parse(s.generatedAt)) / 60000;
  return { ...s, ageMin: Number.isFinite(ageMin) ? ageMin : null };
}
