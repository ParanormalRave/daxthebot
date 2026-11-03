import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const root = process.cwd() + '/scripts/paper-scanner/';
const { loadConfig } = await import(root + 'config.js');
const { checkSecurity, shouldSaveRaw } = await import(root + 'security.js');
const { config } = loadConfig();
let failures = 0;
const check = (name, ok) => { if (!ok) failures++; console.log(ok ? 'OK  ' : 'FAIL', name); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const holders = (n, pct) => Array.from({ length: n }, (_, i) => ({ address: 'H' + (i + 1), owner: 'OH' + (i + 1), pct }));
const clean = () => ({
  mintAuthority: null,
  freezeAuthority: null,
  topHolders: holders(10, 2),
  markets: [{ pubkey: 'POOL', marketType: 'pump_fun_amm', liquidityAAccount: 'LA', lp: { lpLockedPct: 100, lpLockedUSD: 5000 } }],
});
const ctx = { pairAddress: 'POOL' };

let r = checkSecurity(clean(), config, ctx);
check('1 clean report passes (top10 20, max 2, lp 100)', r.passed === true && r.details.top10Percent === 20 && r.details.maxHolderPercent === 2 && r.details.lpLockedPercent === 100 && r.details.mintAuthorityState === 'revoked');

let rep = clean(); rep.mintAuthority = 'SomeKey111';
r = checkSecurity(rep, config, ctx);
check('2 active mint authority rejected', r.passed === false && same(r.reasons, ['mint_authority_active']));

rep = clean(); rep.mintAuthority = ''; rep.freezeAuthority = '';
r = checkSecurity(rep, config, ctx);
check('3 empty-string authorities are UNKNOWN and rejected', same(r.reasons, ['mint_authority_unknown', 'freeze_authority_unknown']));

rep = clean(); delete rep.mintAuthority; delete rep.freezeAuthority;
r = checkSecurity(rep, config, ctx);
check('4 missing authority fields are UNKNOWN and rejected', same(r.reasons, ['mint_authority_unknown', 'freeze_authority_unknown']));

rep = clean(); rep.mintAuthority = 'Zzz'; rep.token = { mintAuthority: null, freezeAuthority: null };
r = checkSecurity(rep, config, ctx);
check('5 report.token is read before the top level', r.details.mintAuthorityState === 'revoked');

rep = clean(); rep.topHolders = [{ address: 'LA', owner: 'X', pct: 40 }, ...holders(10, 2)];
r = checkSecurity(rep, config, ctx);
check('6 a holder that is the pool account is excluded (max 2, top10 20)', r.passed === true && r.details.maxHolderPercent === 2 && r.details.top10Percent === 20);

rep = clean(); rep.topHolders = [{ address: 'W1', owner: 'OW1', pct: 8 }, ...holders(9, 2)];
r = checkSecurity(rep, config, ctx);
check('7 one holder at 8% (limit 6) rejected; top10 = 26 is fine', same(r.reasons, ['single_holder_too_high']));

rep = clean(); rep.topHolders = holders(10, 3);
r = checkSecurity(rep, config, ctx);
check('8 ten holders at 3% = 30% (limit 28) rejected; single 3% is fine', same(r.reasons, ['top10_holders_too_high']));

rep = clean(); delete rep.topHolders;
r = checkSecurity(rep, config, ctx);
check('9 missing holder data is UNKNOWN and rejected', same(r.reasons, ['holders_unknown']));

const bad1 = checkSecurity(null, config);
const bad2 = checkSecurity('text', config);
check('10 malformed reports return security_parse_error and never throw', same(bad1.reasons, ['security_parse_error']) && same(bad2.reasons, ['security_parse_error']) && Object.keys(bad1.details).length >= 7);

const cfgLp = { ...config, security: { ...config.security, minLpLockedOrBurnedPercent: 50 } };
rep = clean(); rep.markets[0].lp.lpLockedPct = 10;
check('11a lp 10% under a 50% minimum rejected (market matched by pair address)', same(checkSecurity(rep, cfgLp, ctx).reasons, ['lp_locked_too_low']));
rep = clean(); rep.markets = [];
check('11b unknown lp rejected when the minimum is above 0', same(checkSecurity(rep, cfgLp, ctx).reasons, ['lp_locked_unknown']));
check('11c unknown lp is fine when the minimum is 0', checkSecurity(rep, config, ctx).passed === true);

rep = clean(); rep.topHolders = [{ address: 'la', owner: 'x', pct: 40 }, ...holders(9, 2)];
r = checkSecurity(rep, config, ctx);
check('12 addresses are case-sensitive: "la" is not the pool "LA"', r.reasons.includes('single_holder_too_high') && r.reasons.includes('top10_holders_too_high'));

const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
let threw = false;
let fr = null;
try { fr = checkSecurity(deepFreeze(clean()), deepFreeze(structuredClone(config)), deepFreeze({ pairAddress: 'POOL' })); } catch { threw = true; }
check('13 frozen inputs are not mutated (still passes, no throw)', threw === false && fr !== null && fr.passed === true);

check('14a saves raw reports while the counter is under the limit', shouldSaveRaw({ counters: { rugCheckRawReportsSaved: 24 } }, config) === true);
check('14b stops at the limit', shouldSaveRaw({ counters: { rugCheckRawReportsSaved: 25 } }, config) === false);
check('14c a missing counter counts as 0', shouldSaveRaw({ counters: {} }, config) === true);

console.log('--- new behavior (15-17 and 19 and 20a/20d need DeepSeek\'s edit) ---');
const cfgNoExcl = { ...config, security: { ...config.security, excludePoolAndAmmAccountsFromHolders: false } };
rep = clean(); rep.topHolders = [{ address: 'LA', owner: 'X', pct: 40 }, ...holders(10, 2)];
check('15 exclusion flag honored: with the flag off the pool counts as a holder', checkSecurity(rep, cfgNoExcl, ctx).reasons.includes('single_holder_too_high'));

rep = clean();
rep.markets = [
  { pubkey: 'PA', marketType: 'amm_a', lp: { lpLockedPct: 100, lpLockedUSD: 9000 } },
  { pubkey: 'PB', marketType: 'amm_b', lp: { lpLockedPct: 0.1, lpLockedUSD: 10 } },
];
r = checkSecurity(rep, config, { dexId: 'pumpswap', pairAddress: 'PB' });
check('16a the market matching the traded pair is used (lp 0.1, amm_b)', r.details.lpLockedPercent === 0.1 && r.details.marketType === 'amm_b' && r.details.marketMatched === true);
r = checkSecurity(rep, config, { dexId: 'pumpswap', pairAddress: 'NOPE' });
check('16b no match means lp unknown, not the best-looking market', r.details.lpLockedPercent === null && r.details.marketMatched === false);
check('16c dexId comes from the context', r.details.dexId === 'pumpswap');

r = checkSecurity(clean(), config, ctx);
check('17 authority paths are reported', typeof r.details.authorityPaths === 'object' && r.details.authorityPaths !== null && r.details.authorityPaths.mint === 'mintAuthority');

rep = clean(); rep.topHolders = [{ address: 'TA1', owner: 'POOL', pct: 40 }, ...holders(10, 2)];
r = checkSecurity(rep, config, ctx);
check('18 a holder whose OWNER is the pool pubkey is excluded (seen in real data)', r.passed === true && r.details.maxHolderPercent === 2);

rep = clean(); rep.rugged = true; rep.score_normalised = 7; rep.totalHolders = 123; rep.graphInsidersDetected = false;
r = checkSecurity(rep, config, ctx);
check('19 record-only fields are captured and never change the result', r.passed === true && !!r.details.recordOnly && r.details.recordOnly.rugged === true && r.details.recordOnly.scoreNormalised === 7 && r.details.recordOnly.totalHolders === 123 && r.details.recordOnly.insidersDetected === false);

r = checkSecurity(null, config, { dexId: ' pumpswap ', pairAddress: 'POOL' });
check('20a parse error still carries the trimmed dexId from context', same(r.reasons, ['security_parse_error']) && r.passed === false && r.details.dexId === 'pumpswap');
r = checkSecurity(null, config, null);
check('20b parse error with a null context does not throw and dexId is null', same(r.reasons, ['security_parse_error']) && r.details.dexId === null);
r = checkSecurity('text', config, 'not-an-object');
check('20c a non-object context is ignored, no throw', same(r.reasons, ['security_parse_error']) && r.details.dexId === null);
r = checkSecurity(null, config);
check('20d parse-error details carry every field, including the new ones', ['mintAuthorityState', 'freezeAuthorityState', 'top10Percent', 'maxHolderPercent', 'lpLockedPercent', 'marketType', 'dexId', 'marketMatched', 'authorityPaths', 'recordOnly'].every((k) => k in r.details) && r.details.marketMatched === false);

console.log(failures === 0 ? 'ALL OK' : failures + ' FAILED');
process.exitCode = failures ? 1 : 0;
