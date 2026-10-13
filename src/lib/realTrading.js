import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { db } from "./postgres.js";
import { connection, getTokenAuthority } from "./solana.js";
import { getWallet } from "./walletDb.js";
import { decryptSecretKey } from "./wallet.js";
import {
  isRealEnabled,
  reserveSpend,
  releaseSpend,
  acquireTradeLock,
  releaseTradeLock,
} from "./realLimits.js";

const BASE_URL = "https://api.jup.ag/swap/v2";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1_000_000_000;
const SLIPPAGE_BPS = Number(process.env.REAL_SLIPPAGE_BPS || 500);
const MIN_SOL_BUFFER = Number(process.env.REAL_MIN_SOL_BUFFER || 0.01);

const fail = (error) => ({ ok: false, error });
const str = (v) => (v === undefined || v === null ? null : v.toString());

function apiKey() {
  const k = process.env.JUPITER_API_KEY;
  if (!k) throw new Error("JUPITER_API_KEY is not set");
  return k;
}

async function jupGetOrder(params) {
  const res = await fetch(`${BASE_URL}/order?${new URLSearchParams(params)}`, {
    headers: { "x-api-key": apiKey() },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Jupiter /order returned ${res.status}`);
  return res.json();
}

// price check only: no taker, so no transaction is built
export async function previewBuy(tokenAddress, solAmount) {
  const order = await jupGetOrder({
    inputMint: SOL_MINT,
    outputMint: tokenAddress,
    amount: String(Math.round(solAmount * LAMPORTS)),
  });
  const { decimals } = await getTokenAuthority(tokenAddress);
  return {
    expectedTokens: Number(order.outAmount) / 10 ** decimals,
    router: order.router,
    feeBps: order.feeBps,
  };
}

// the secret key exists in memory only inside the trade, and is never logged or stored
async function loadKeypair(userId) {
  const row = await getWallet(userId);
  if (!row) throw new Error("No wallet for this user");
  const kp = Keypair.fromSecretKey(
    decryptSecretKey(row.encrypted_secret, row.iv, row.auth_tag),
  );
  if (kp.publicKey.toString() !== row.public_key)
    throw new Error("Decrypted key does not match the stored address");
  return kp;
}

async function getTokenBalanceRaw(owner, mint) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(mint),
  });
  let raw = 0n;
  let decimals = null;
  for (const { account } of res.value) {
    const t = account.data.parsed.info.tokenAmount;
    raw += BigInt(t.amount);
    decimals = t.decimals;
  }
  return { raw, decimals };
}

async function waitForSignature(signature, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const st = value[0];
    if (st) {
      if (st.err) return "failed";
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")
        return "landed";
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return "unknown";
}

// sign the transaction Jupiter built, then hand it to /execute
async function signAndExecute(order, keypair) {
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([keypair]);
  const ourSignature = bs58.encode(tx.signatures[0]);
  const signedTransaction = Buffer.from(tx.serialize()).toString("base64");
  try {
    const res = await fetch(`${BASE_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey() },
      body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Jupiter /execute returned ${res.status}`);
    const data = await res.json();
    return { ...data, signature: data.signature || ourSignature };
  } catch (err) {
    // we don't know whether it landed. NEVER treat this as "didn't happen"
    return { status: "Unknown", signature: ourSignature, error: err.message };
  }
}

async function logTrade(t) {
  await db
    .query(
      `INSERT INTO real_trades
       (telegram_user_id, side, token_address, symbol, sol_lamports, token_raw, signature, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [t.userId, t.side, t.tokenAddress, t.symbol ?? null, str(t.solLamports), str(t.tokenRaw), t.signature ?? null, t.status, t.error ?? null],
    )
    .catch((e) => console.error("logTrade failed:", e.message));
}

export async function getRealPositions(userId) {
  const r = await db.query(
    "SELECT * FROM real_positions WHERE telegram_user_id = $1 AND status = 'open' ORDER BY id",
    [userId],
  );
  return r.rows;
}

export async function realBuy({ userId, tokenAddress, symbol, solAmount }) {
  if (!(await isRealEnabled())) return fail("Real trading is switched off.");
  if (!(await acquireTradeLock(userId)))
    return fail("Another real trade is still running. Wait for it to finish.");

  let reserved = false;
  let sent = false;
  const lamports = Math.round(solAmount * LAMPORTS);
  try {
    const keypair = await loadKeypair(userId);
    const owner = keypair.publicKey;

    const solBalance = (await connection.getBalance(owner)) / LAMPORTS;
    if (solBalance < solAmount + MIN_SOL_BUFFER)
      return fail(
        `Not enough SOL. Need ${solAmount} plus a ${MIN_SOL_BUFFER} SOL fee reserve. Balance: ${solBalance.toFixed(4)}.`,
      );

    const authority = await getTokenAuthority(tokenAddress);
    if (authority.isFreezable)
      return fail("Blocked: this token has a freeze authority, so your tokens could be frozen.");

    const spend = await reserveSpend(userId, solAmount);
    if (!spend.ok) return fail(spend.reason);
    reserved = true;

    const before = await getTokenBalanceRaw(owner, tokenAddress);
    const order = await jupGetOrder({
      inputMint: SOL_MINT,
      outputMint: tokenAddress,
      amount: String(lamports),
      taker: owner.toString(),
      slippageBps: String(SLIPPAGE_BPS),
    });
    if (!order.transaction) {
      await releaseSpend(userId, solAmount);
      reserved = false;
      await logTrade({ userId, side: "buy", tokenAddress, symbol, solLamports: lamports, status: "no_route", error: `${order.router} ${order.errorCode}` });
      return fail(`No tradable route (${order.router ?? "n/a"}, code ${order.errorCode ?? "?"}).`);
    }

    sent = true;
    const result = await signAndExecute(order, keypair);
    let status = result.status;
    let tokensRaw;
    let spentLamports;
    let approximate = false;

    if (status === "Unknown") {
      const chain = await waitForSignature(result.signature);
      if (chain === "landed") {
        const after = await getTokenBalanceRaw(owner, tokenAddress);
        tokensRaw = after.raw - before.raw;
        spentLamports = BigInt(lamports);
        approximate = true;
        status = "Success";
      } else if (chain === "failed") {
        status = "Failed";
      } else {
        await logTrade({ userId, side: "buy", tokenAddress, symbol, solLamports: lamports, signature: result.signature, status: "unknown", error: result.error });
        return { ok: false, unknown: true, signature: result.signature, error: "Could not confirm this order. Check Solscan before trying again. The amount stays counted against today's cap." };
      }
    } else if (status === "Success") {
      tokensRaw = BigInt(result.totalOutputAmount);
      spentLamports = BigInt(result.totalInputAmount);
    }

    if (status !== "Success") {
      await releaseSpend(userId, solAmount);
      reserved = false;
      await logTrade({ userId, side: "buy", tokenAddress, symbol, solLamports: lamports, signature: result.signature, status: "failed", error: `code ${result.code}` });
      return fail(`Swap failed (code ${result.code ?? "?"}). Nothing was bought.`);
    }

    const after = await getTokenBalanceRaw(owner, tokenAddress);
    const decimals = after.decimals ?? authority.decimals;
    const ins = await db.query(
      `INSERT INTO real_positions
       (telegram_user_id, token_address, symbol, decimals, amount_raw, sol_spent_lamports, buy_signature)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [userId, tokenAddress, symbol ?? null, decimals, tokensRaw.toString(), spentLamports.toString(), result.signature],
    );
    await logTrade({ userId, side: "buy", tokenAddress, symbol, solLamports: spentLamports, tokenRaw: tokensRaw, signature: result.signature, status: "success" });
    reserved = false; // the spend stays counted against the daily cap
    return {
      ok: true,
      positionId: ins.rows[0].id,
      signature: result.signature,
      tokens: Number(tokensRaw) / 10 ** decimals,
      solSpent: Number(spentLamports) / LAMPORTS,
      approximate,
    };
  } catch (err) {
    console.error("realBuy error:", err.message);
    if (reserved && !sent) await releaseSpend(userId, solAmount).catch(() => {});
    return fail("Something went wrong during the buy. Check /positions and Solscan before retrying.");
  } finally {
    await releaseTradeLock(userId);
  }
}

export async function realSell({ userId, positionId, percent }) {
  if (!(percent > 0 && percent <= 100)) return fail("Invalid percentage.");
  if (!(await acquireTradeLock(userId)))
    return fail("Another real trade is still running. Wait for it to finish.");
  try {
    const { rows } = await db.query(
      "SELECT * FROM real_positions WHERE id = $1 AND telegram_user_id = $2 AND status = 'open'",
      [positionId, userId],
    );
    const pos = rows[0];
    if (!pos) return fail("Position not found or already closed.");

    const keypair = await loadKeypair(userId);
    const owner = keypair.publicKey;

    const solBefore = await connection.getBalance(owner);
    if (solBefore / LAMPORTS < MIN_SOL_BUFFER / 2)
      return fail(`Not enough SOL left for the network fee (${(solBefore / LAMPORTS).toFixed(4)}).`);

    const stored = BigInt(pos.amount_raw);
    const held = await getTokenBalanceRaw(owner, pos.token_address);
    const base = held.raw < stored ? held.raw : stored; // never try to sell more than we hold
    const sellRaw = percent >= 100 ? base : (base * BigInt(percent)) / 100n;
    if (sellRaw <= 0n) return fail("Nothing to sell: the token balance is zero.");

    const order = await jupGetOrder({
      inputMint: pos.token_address,
      outputMint: SOL_MINT,
      amount: sellRaw.toString(),
      taker: owner.toString(),
      slippageBps: String(SLIPPAGE_BPS),
    });
    if (!order.transaction) {
      await logTrade({ userId, side: "sell", tokenAddress: pos.token_address, symbol: pos.symbol, tokenRaw: sellRaw, status: "no_route", error: `${order.router} ${order.errorCode}` });
      return fail(`No sell route (${order.router ?? "n/a"}, code ${order.errorCode ?? "?"}). This token may not be sellable right now.`);
    }

    const result = await signAndExecute(order, keypair);
    let status = result.status;
    let lamportsOut;
    let approximate = false;

    if (status === "Unknown") {
      const chain = await waitForSignature(result.signature);
      if (chain === "landed") {
        const solAfter = await connection.getBalance(owner);
        lamportsOut = BigInt(Math.max(0, solAfter - solBefore));
        approximate = true;
        status = "Success";
      } else if (chain === "failed") {
        status = "Failed";
      } else {
        await logTrade({ userId, side: "sell", tokenAddress: pos.token_address, symbol: pos.symbol, tokenRaw: sellRaw, signature: result.signature, status: "unknown", error: result.error });
        return { ok: false, unknown: true, signature: result.signature, error: "Could not confirm this sell. Check Solscan before trying again." };
      }
    } else if (status === "Success") {
      lamportsOut = BigInt(result.totalOutputAmount);
    }

    if (status !== "Success") {
      await logTrade({ userId, side: "sell", tokenAddress: pos.token_address, symbol: pos.symbol, tokenRaw: sellRaw, signature: result.signature, status: "failed", error: `code ${result.code}` });
      return fail(`Sell failed (code ${result.code ?? "?"}). Your tokens are still in the wallet.`);
    }

    const costTotal = BigInt(pos.sol_spent_lamports);
    const costPortion = (costTotal * sellRaw) / stored;
    const remaining = stored - sellRaw;
    const closed = percent >= 100 || remaining <= 0n;
    await db.query(
      "UPDATE real_positions SET amount_raw = $1, sol_spent_lamports = $2, status = $3 WHERE id = $4",
      [closed ? "0" : remaining.toString(), (costTotal - costPortion).toString(), closed ? "closed" : "open", positionId],
    );
    await logTrade({ userId, side: "sell", tokenAddress: pos.token_address, symbol: pos.symbol, solLamports: lamportsOut, tokenRaw: sellRaw, signature: result.signature, status: "success" });
    return {
      ok: true,
      signature: result.signature,
      solReceived: Number(lamportsOut) / LAMPORTS,
      pnlSol: Number(lamportsOut - costPortion) / LAMPORTS,
      approximate,
    };
  } catch (err) {
    console.error("realSell error:", err.message);
    return fail("Something went wrong during the sell. Check Solscan before retrying.");
  } finally {
    await releaseTradeLock(userId);
  }
}