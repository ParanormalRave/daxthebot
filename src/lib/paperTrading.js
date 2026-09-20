import { db } from "./postgres.js";

export async function getPaperBalance(telegramUserId) {
  const result = await db.query(
    "SELECT sol_balance FROM paper_balances WHERE telegram_user_id = $1",
    [telegramUserId],
  );
  if (result?.rows?.length === 0) {
    await db.query(
      "INSERT INTO paper_balances (telegram_user_id, sol_balance) VALUES ($1, 10)",
      [telegramUserId],
    );
    return 10;
  }

  return Number(result?.rows[0]?.sol_balance || null);
}

export async function paperBuy(
  telegramUserId,
  tokenAddress,
  pairAddress,
  symbol,
  solAmount,
  tokenPriceUsd,
  solPriceUsd,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const balanceResult = await client.query(
      "SELECT sol_balance FROM paper_balances WHERE telegram_user_id = $1 FOR UPDATE",
      [telegramUserId],
    );
    let balance;
    if (balanceResult.rows.length === 0) {
      await client.query(
        "INSERT INTO paper_balances (telegram_user_id, sol_balance) VALUES ($1, 10)",
        [telegramUserId],
      );
      balance = 10;
    } else {
      balance = Number(balanceResult.rows[0].sol_balance);
    }
    if (solAmount > balance)
      throw new Error(`Insufficient paper balance. You have ${balance} SOL`);
    const usdSpent = solAmount * solPriceUsd;
    const tokensReceived = usdSpent / tokenPriceUsd;

    await client.query(
      "UPDATE paper_balances SET sol_balance = sol_balance - $1 WHERE telegram_user_id = $2",
      [solAmount, telegramUserId],
    );

    const inserted = await client.query(
      "INSERT INTO paper_positions (telegram_user_id, token_address, pair_address, symbol, amount_tokens, entry_price, sol_spent) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [
        telegramUserId,
        tokenAddress,
        pairAddress,
        symbol,
        tokensReceived,
        tokenPriceUsd,
        solAmount,
      ],
    );
    await client.query("COMMIT");

    return {
      tokensReceived,
      newBalance: balance - solAmount,
      positionId: inserted.rows[0].id,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getPaperPositions(telegramUserId) {
  const result = await db.query(
    "SELECT * FROM paper_positions WHERE telegram_user_id = $1",
    [telegramUserId],
  );
  return result?.rows || null;
}

export async function paperSellPercentage(telegramUserId, positionId, percent, currentPriceUsd, solPriceUsd){
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      'SELECT * FROM paper_positions WHERE id = $1 AND telegram_user_id = $2 FOR UPDATE',
      [positionId, telegramUserId],
    )
    const position = result?.rows[0] || null
    if (!position) throw new Error('position not found')

    const fraction = percent / 100
    const tokensToSell = Number(position.amount_tokens) * fraction
    const solSpentPortion = Number(position.sol_spent) * fraction

    const currentValueUsd = tokensToSell * currentPriceUsd
    const solReceived = currentValueUsd / solPriceUsd
    const pnlUsd = currentValueUsd - solSpentPortion * solPriceUsd

    await client.query(
      'UPDATE paper_balances SET sol_balance = sol_balance + $1 WHERE telegram_user_id = $2',
      [solReceived, telegramUserId],
    )

    if (percent >= 100) {
      await client.query('DELETE FROM paper_positions WHERE id = $1', [positionId])
    } else {
      await client.query(
        'UPDATE paper_positions SET amount_tokens = amount_tokens - $1, sol_spent = sol_spent - $2 WHERE id = $3',
        [tokensToSell, solSpentPortion, positionId],
      )
    }

    await client.query('COMMIT')
    return { solReceived, pnlUsd }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// old code being replaced with sell percentage
// export async function paperSell(telegramUserId, positionId, currentPriceUsd, solPriceUsd) {
//     const result = await db.query('SELECT * FROM paper_positions WHERE id = $1 AND telegram_user_id = $2', [positionId, telegramUserId])
//     const position = result?.rows[0] || null

//     if(!position) throw new Error("position not found");

//     const currentValueUsd = Number(position.amount_tokens) * currentPriceUsd
//     const solReceived = currentValueUsd / solPriceUsd
//     const pnlUsd = currentValueUsd - Number(position.sol_spent) * solPriceUsd

//     await db.query('UPDATE paper_balances SET sol_balance = sol_balance + $1 WHERE telegram_user_id = $2', [solReceived, telegramUserId])
//     await db.query('DELETE FROM paper_positions WHERE id = $1', [positionId])

//     return {solReceived, pnlUsd}
// }
