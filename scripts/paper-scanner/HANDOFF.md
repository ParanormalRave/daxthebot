# HANDOFF (update by hand after each step; last updated 2026-10-30)

## What this is
A PAPER-trading Solana memecoin scanner for the Dax Telegram bot. $5 virtual account, no wallets or keys, no real money. Code is in scripts/paper-scanner/. Rules are in scripts/paper-scanner/SPEC.md (binding; later lines override earlier ones). Settings are in data/paper-scanner/config.json (frozen and fingerprinted; copy in scripts/paper-scanner/config.frozen-v1.json). Branch: paper-scanner. Models write code through OpenCode; a reviewer writes tests, reads every file and teaches the owner.

## State
Done and committed: util, config, state, logger, filters, paperEngine (locked), selftest (21 scenarios, locked), security (29 tests OK in tests/security.test.mjs; NOT locked yet: waiting for the holder-probe result).
Next, one module per turn: http, discovery, watchlist, summarize, summarize-cli, dryConfig, alerts (optional, can be skipped; if skipped main.js writes outbox.txt as NONE), main. Then an end-to-end test with fake fetch and a fake clock, then the gates: selftest, --dry-config, --once, e2e, a 1-hour supervised run on the VPS, then the real run (3 to 7 days or 50 trades), summarize, verdict.

## Decisions worth remembering
- tradeSizeUsd 1.7, minSolGasBufferUsd 0.6, balance floor 3.0, minTradesForVerdict 30 (fewer = INCONCLUSIVE, never PASS).
- minLpLockedOrBurnedPercent stays 0 (RugCheck LP numbers are unreliable on PumpSwap). Unknown authority or holder data is rejected.
- Rug needs 2 bad liquidity readings in a row (confirmObservationsForMissingLiquidity 2); numeric rug triggers fire at once.
- Config edits during a run are blocked by the fingerprint check. The only allowed extension is raising protocol.maxDays to 14 with --accept-config-change.
- Hermes (separate Telegram bot) only reads status.txt and summary.json. It never edits, starts or stops anything.
- Real money, withdrawal and wallet code are a separate, later project with their own review.

## Routines
RESUME: cd ~/Downloads/daxthebot-fresh2; pwd; git status --short; git log --oneline -8; node scripts/paper-scanner/selftest.js; node scripts/paper-scanner/tests/security.test.mjs | grep -E "FAIL|ALL OK"; tail -n 60 scripts/paper-scanner/SPEC.md
PER MODULE: model writes only that file; node --check; git status --short; grep -rnE "src/|\.\./|wallet|jupiter|\.env|process\.env" scripts/paper-scanner/*.js (must print nothing); reviewer maps SPEC bullets to code lines; test written from the spec with hand-computed values; run on real saved samples; break it on purpose with a sed mutation (a test must go red); git commit; chmod 444.
IF A MODEL SAYS "NOT IN THE SPEC": grep -n "<word>" scripts/paper-scanner/SPEC.md. If absent, write it into SPEC.md first. Never let a model guess.

## Rules for any model
Edit only the file you were asked to. Never touch approved files. No network while coding. Never import from src/, never read .env or wallet code. One file edit, one node --check, then report exports, rules checked, ambiguities, spec doubts, and STOP.
Never change a test expectation to match code. Verify a model's claim about a bug with your own arithmetic first.
Scripts use relative paths: run from the project folder. /tmp is wiped on restart: keep probes in data/paper-scanner/probes/ and tests in scripts/paper-scanner/tests/.
