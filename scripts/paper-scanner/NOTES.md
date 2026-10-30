
# Security findings, 2026-10-30 (24 RugCheck reports, pools about 51-54 min old; none under 50 min)
- RugCheck /report returned HTTP 200 for all 24. Authorities were null (revoked) on all 24.
- 14 of 24 passed. All 10 failures were holder concentration. pumpswap (tradable): 2 of 6 passed. pump-fun (bonding curve): 12 of 14. meteora-dbc: 0 of 3 and the pool never matched a RugCheck market.
- lpLockedPct on pumpswap is unreliable (about 1e-9 on five tokens, 100 on one). Keep minLpLockedOrBurnedPercent at 0.
- Open: whether single holders of about 80% are real concentration or accounts RugCheck lists in knownAccounts (see holder-probe.mjs).
- Feed note: in one sample the first two Gecko new_pools pages spanned about 50 minutes; earlier three pages spanned 1-3 minutes. Pool creation rate varies by time of day.
