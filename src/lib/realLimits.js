import { redis } from "./redis.js";

export const MAX_PER_TRADE = Number(process.env.REAL_MAX_SOL_PER_TRADE || 0);
export const MAX_PER_DAY = Number(process.env.REAL_MAX_SOL_PER_DAY || 0);

// the kill switch lives in Redis and defaults to OFF
export async function isRealEnabled() {
  const v = await redis.get("real:enabled");
  return (v === "1" || v === 1) && MAX_PER_TRADE > 0 && MAX_PER_DAY > 0;
}
export async function setRealEnabled(on) {
  if (on) await redis.set("real:enabled", "1");
  else await redis.del("real:enabled");
}

const dayKey = (userId) =>
  `real:spent:${userId}:${new Date().toISOString().slice(0, 10)}`; // UTC day

// reserve the budget BEFORE sending; give it back if the trade didn't happen
export async function reserveSpend(userId, sol) {
  if (!(sol > 0)) return { ok: false, reason: "Invalid amount" };
  if (sol > MAX_PER_TRADE)
    return { ok: false, reason: `Over the per-trade cap (${MAX_PER_TRADE} SOL)` };
  const key = dayKey(userId);
  const total = Number(await redis.incrbyfloat(key, sol));
  await redis.expire(key, 172800);
  if (total > MAX_PER_DAY) {
    await redis.incrbyfloat(key, -sol);
    return { ok: false, reason: `Over the daily cap (${MAX_PER_DAY} SOL)` };
  }
  return { ok: true };
}
export async function releaseSpend(userId, sol) {
  await redis.incrbyfloat(dayKey(userId), -sol);
}

// one real trade at a time per user (blocks double taps)
export async function acquireTradeLock(userId) {
  const r = await redis.set(`real:lock:${userId}`, "1", { nx: true, ex: 90 });
  return r === "OK";
}
export async function releaseTradeLock(userId) {
  await redis.del(`real:lock:${userId}`);
}