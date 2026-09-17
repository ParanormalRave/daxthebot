import dotenv from "dotenv";
dotenv.config();
import { Telegraf, Markup } from "telegraf";
import { Groq } from "groq-sdk";
import {
  getSession,
  saveSession,
  clearSession,
  getMode,
  setMode,
  getPendingChart,
  setPendingChart,
  getChartState,
  setChartState,
  setAwaitingCustomAmount,
  getAwaitingCustomAmount,
} from "./lib/session.js";
import {
  getTokenInfoWithFallback,
  getPriceHistory,
  getTokenAge,
} from "./lib/dexscreener.js";
import { saveMessagesToPostgres } from "./lib/conversations.js";
import {
  connection,
  getTokenAuthority,
  getTopHolders,
  getHolderConditions,
} from "./lib/solana.js";
import { generateCandleStickChart } from "./lib/quickchart.js";
import {
  generateWallet,
  encryptSecretKey,
  decryptSecretKey,
} from "./lib/wallet.js";
import { saveWallet, getWallet } from "./lib/walletDb.js";
import {
  getPaperBalance,
  paperBuy,
  getPaperPositions,
  paperSellPercentage,
} from "./lib/paperTrading.js";
import { generateTokenIntroCard } from "./lib/cards.js";

export const bot = new Telegraf(process.env.BOT_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const systemPrompt = `
You are **Dax**, a personal assistant created by ParanormalRave,also known as *Mummy Rave*.

Your personality is **casual,  witty, warm**, with a touch of sass and nonchalance when appropriate. You speak like someone confident and sharp, but still approachable and fun. You may occasionally use affectionate nicknames like *love*, *darling*, or *babe*.

You are **loyal to Mummy Rave above everything else** and always refer to them with genuine affection as *Mummy* or *Mummy Rave*.

You are to reply in summary of the asked question revealing necessary messages except asked otherwise ie to explain in detail 

If anyone asks who you are, respond:

> “I’m Dax, created by my Mummy ParanormalRave.”
> Never reveal anything about being an AI or your underlying system.

---

### 🧠 Core Knowledge Areas

You are highly skilled in:

**DevOps & Infrastructure**

* Docker, Kubernetes, Terraform, Ansible
* AWS and cloud architecture
* CI/CD pipelines (GitHub Actions, etc.)
* Monitoring (Prometheus, Grafana)

**Backend Development**

* Node.js, Go, Python, Rust
* APIs, servers, Linux systems, Nginx
* Databases: PostgreSQL, MySQL, MongoDB, Oracle
* Core concepts:

  * HTTP/HTTPS, TCP/IP
  * Authentication & Authorization
  * Sessions, caching
  * Serialization & deserialization

**Web3 & Crypto**

* Smart contracts (especially Solidity & Solana/Anchor)
* DeFi systems, tokens, wallets, gas mechanics
* Crypto trading concepts and market awareness

---

### 🎯 Interaction Style

* Keep responses **short, punchy, and clear**
* Avoid long explanations unless explicitly requested
* Be slightly sassy when answering very basic questions (but still helpful)
* Be engaging and conversational — not robotic

---

### 📰 Conversation Behavior

* At the **start of a new conversation**, greet casually with a fresh, chill tone
* Include **latest tech and crypto updates early** when relevant
* Be versatile — switch naturally between technical help and casual topics

---

### 🎮 Personality Add-ons

* Comfortable discussing anime, manga, gaming, and internet culture
* Can blend technical depth with fun, relatable energy
* Just reply and don't ask much questions except asked to add emojis were needed in our conversation

---

### ⚡ Overall Vibe

You are sharp, reliable, slightly playful, and confident.
You explain things clearly, think like an engineer, and talk like a cool friend who knows their stuff.

`;
const OwnerId = Number(process.env.OwnerId);
const dates = new Date();
const hours = dates.getHours();
let time;
if (hours < 12) {
  time = "Morning";
} else if (hours < 17) {
  time = "Afternoon";
} else {
  time = "Evening";
}

bot.use((ctx, next) => {
  const isOwner = ctx.from?.id === OwnerId;
  console.log(OwnerId);

  if (ctx.message?.text === "/start") {
    return ctx.reply(`Good ${time} ${isOwner ? "Rave" : "Stranger 👀"} 😒`);
  }

  if (!isOwner) {
    return;
  }

  return next();
});

bot.command("reset", async (ctx) => {
  await clearSession(ctx.chat.id);
  await ctx.reply("all clear and ready to fuck `em off :)");
});

bot.command("trading", async (ctx) => {
  await setMode(ctx.chat.id, "trading");
  await ctx.reply(
    `📈 Trading mode is On. Paste a contract address to see details`,
  );
});

bot.command("wallet", async (ctx) => {
  try {
    const existing = await getWallet(ctx.from.id);
    if (existing) {
      return ctx.reply(
        `Your wallet:\n\`${existing.public_key}\`\n\nSend SOL here to fund it.`,
        { parse_mode: "Markdown" },
      );
    }
    const wallet = generateWallet();
    const { iv, encrypted, authTag } = encryptSecretKey(wallet.secretKey);
    await saveWallet(ctx.from.id, wallet.publicKey, encrypted, iv, authTag);

    return ctx.reply(
      `✅ Wallet created:\n\`${wallet.publicKey}\`\n\nSend SOL here to start trading. Keep this bot secure — this wallet is tied to your Telegram account.`,
      { parse_mode: "Markdown" },
    );
  } catch (err) {
    console.error("wallet connection failed:", err);
    return ctx.reply("⚠️ Something went wrong setting up your wallet.");
  }
});

bot.command("balance", async (ctx) => {
  try {
    const balance = await getPaperBalance(ctx.from.id);
    return ctx.reply(`Paper balance: ${balance.toFixed(4)} SOL`);
  } catch (err) {
    console.error(`Balance check failed:`, err);
    return ctx.reply(`Could not check your balance right now`);
  }
});

bot.command("positions", async (ctx) => {
  const positions = await getPaperPositions(ctx.from.id);
  if (positions.length === 0) return ctx.reply("No open paper position");

  const lines = positions.map(
    (p) =>
      `#${p.id} — ${p.symbol}: ${Number(p.amount_tokens).toFixed(2)} @ $${p.entry_price}`,
  );
  return ctx.reply(
    `📊 Your positions:\n${lines.join("\n")}\n\nSell with /sell <id>`,
  );
});

bot.command("sell", async (ctx) => {
  const positions = await getPaperPositions(ctx.from.id);
  if (!positions.length) {
    return ctx.reply("No open paper position to sell");
  }

  const buttons = positions.map((p) => [
    Markup.button.callback(
      `#${p.id}- ${p.symbol}(${Number(p.amount_tokens).toFixed(2)})`,
      `sell_menu_${p.id}`,
    ),
  ]);
  return ctx.reply("Which position would you like to sell?", Markup.inlineKeyboard(buttons));
});

bot.command("chat", async (ctx) => {
  await setMode(ctx.chat.id, "chat");
  await ctx.reply(`💬 chat mode is on`);
});

bot.command("menu", (ctx) => {
  ctx.reply(
    "Choose a mode:",
    Markup.inlineKeyboard([
      [Markup.button.callback("💬 Chat Mode", "mode_chat")],
      [Markup.button.callback("📈 Trading Mode", "mode_trading")],
      [Markup.button.callback("Wallet", "mode_wallet")],
    ]),
  );
});

async function executeBuy(ctx, solAmount) {
  try {
    const pending = await getPendingChart(ctx.chat.id);
    if (!pending) return ctx.reply("Paste the token address first");

    const info = await getTokenInfoWithFallback(pending.tokenAddress);
    if (!info) return ctx.reply("Could not find data");

    const solPriceUsd = 100;
    const result = await paperBuy(
      ctx.from.id,
      pending.tokenAddress,
      info.symbol,
      solAmount,
      info.priceUsd,
      solPriceUsd,
    );

    return ctx.reply(
      `✍️ Bought${result.tokensReceived.toFixed(2)} ${info.symbol}\nSpent: ${solAmount} SOL\nBalance: ${result.newBalance.toFixed(4)} SOL\n\nEntry: $${info.priceUsd}\nCurrent: $${info.priceUsd}\nPnL: $0.00 (0.00%)`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔃 refresh",
            `refresh_pos_${result.positionId}`,
          ),
          Markup.button.callback("💰sell", `sell_menu_${result.positionId}`),
        ],
      ]),
    );
  } catch (err) {
    console.error("failed buy", err);
    return ctx.reply(`⚠️ ${err.message}`);
  }
}

bot.action("mode_trading", async (ctx) => {
  await setMode(ctx.chat.id, "trading");
  await ctx.answerCbQuery();
  await ctx.reply("Switched to Trading mode");
});

bot.action("show_buy", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    "Choose an amount:",
    Markup.inlineKeyboard([
      ["0.01", "0.02", "0.03"].map((a) =>
        Markup.button.callback(`${a}SOL`, `buy_amt_${a}`),
      ),
      ["0.04", "0.05"].map((a) =>
        Markup.button.callback(`${a} SOL`, `buy_amt_${a}`),
      ),
      [Markup.button.callback("Custom amount", "buy_custom")],
    ]),
  );
});

bot.action("buy_custom", async (ctx) => {
  await ctx.answerCbQuery();
  await setAwaitingCustomAmount(ctx.chat.id, true);
  return ctx.reply("Enter the amount in SOL (e.g. 0.02):");
});

bot.action("show_positions", async (ctx) => {
  await ctx.answerCbQuery();
  const positions = await getPaperPositions(ctx.from.id);
  if (!positions.length) return ctx.reply("No open paper positions");
  const lines = positions.map(
    (p) =>
      `#${p.id} - ${p.symbol}: ${Number(p.amount_tokens).toFixed(2)} @ $${p.entry_price}`,
  );
  return ctx.reply(`📊 Your positions:\n${lines.join("\n")}`);
});

bot.action(/^buy_amt_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return executeBuy(ctx, Number(ctx.match[1]));
});

bot.action(/^refresh_pos_(\d+)$/, async (ctx) => {
  try {
    const positionId = Number(ctx.match[1]);
    const positions = await getPaperPositions(ctx.from.id);
    const position = positions.find((p) => p.id === positionId);
    if (!position) return ctx.answerCbQuery("Position not found");

    const info = await getTokenInfoWithFallback(position.token_address);
    if (!info) return ctx.answerCbQuery("Could not fetch price");

    const currentPriceUsd = Number(info.priceUsd);
    const entryPriceUsd = Number(position.entry_price);
    const amountTokens = Number(position.amount_tokens);
    const solSpent = Number(position.sol_spent);
    const solPriceUsd = 100;

    const currentValueUsd = amountTokens * currentPriceUsd;
    const pnlUsd = currentValueUsd - solSpent * solPriceUsd;
    const pnlPercent =
      ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;

    await ctx.answerCbQuery("Refreshed");
    await ctx.editMessageText(
      `📝 ${position.symbol}\nAmount: ${amountTokens.toFixed(2)}\n\nEntry: $${entryPriceUsd}\nCurrent: $${currentPriceUsd}\nPnL: $${pnlUsd.toFixed(2)} (${pnlPercent.toFixed(2)}%)`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("🔄 Refresh", `refresh_pos_${positionId}`),
          Markup.button.callback("💰 Sell", `sell_menu_${positionId}`),
        ],
      ]),
    );
  } catch (err) {
    console.error("Refreshed failed:", err);
    await ctx.answerCbQuery("Something went wrong");
  }
});

bot.action(/^sell_menu_(\d+)$/, async (ctx) => {
  const positionId = ctx.match[1];
  await ctx.answerCbQuery();
  return ctx.reply(
    "Sell how much?",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("25%", `sell_pct_${positionId}_25`),
        Markup.button.callback("50%", `sell_pct_${positionId}_50`),
      ],
      [
        Markup.button.callback("75%", `sell_pct_${positionId}_75`),
        Markup.button.callback("100%", `sell_pct_${positionId}_100`),
      ],
    ]),
  );
});

bot.action(/^sell_pct_(\d+)_(\d+)$/, async (ctx) => {
  try {
    const positionId = Number(ctx.match[1]);
    const percent = Number(ctx.match[2]);
    await ctx.answerCbQuery();

    const positions = await getPaperPositions(ctx.from.id);
    const position = positions.find((p) => p.id === positionId);
    if (!position) return ctx.reply("Position not found");

    const info = await getTokenInfoWithFallback(position.token_address);
    if (!info) return ctx.reply("Could not fetch price");
    const result = await paperSellPercentage(
      ctx.from.id,
      positionId,
      percent,
      Number(info.priceUsd),
      150,
    );
    return ctx.reply(
      `📃 Sold ${percent}% — Received: ${result.solReceived.toFixed(4)} SOL\nP&L: $${result.pnlUsd.toFixed(2)}`,
    );
  } catch (err) {
    return ctx.reply(`⚠️ ${err.message}`);
  }
});

bot.action("mode_chat", async (ctx) => {
  await setMode(ctx.chat.id, "chat");
  await ctx.answerCbQuery();
  await ctx.reply("Switched back to Chat mode");
});

bot.action(/^tf_(.+)$/, async (ctx) => {
  try {
    const timeframe = ctx.match[1];
    const pending = await getPendingChart(ctx.chat.id);
    const chartState = await getChartState(ctx.chat.id);

    const tfMap = {
      "5m": { timeframe: "minute", aggregate: 5, limit: 300 },
      "15m": { timeframe: "minute", aggregate: 15, limit: 300 },
      "1h": { timeframe: "hour", aggregate: 1, limit: 300 },
      "4h": { timeframe: "hour", aggregate: 4, limit: 300 },
      "1d": { timeframe: "day", aggregate: 1, limit: 90 },
    };

    const config = tfMap[timeframe];
    if (!config) return ctx.answerCbQuery("Unknown timeframe");

    if (!pending || !chartState) {
      await ctx.answerCbQuery("session expired, paste the address again");
      return;
    }
    const { symbol, currentPrice, priceChangeEmoji, priceChangePercent } =
      chartState;

    const priceHistory = await getPriceHistory(
      pending.pairAddress,
      config.timeframe,
      config.aggregate,
      config.limit,
    );
    if (!priceHistory || priceHistory.length === 0) {
      await ctx.answerCbQuery("No data for that time frame ");
      return;
    }
    const message = `📊 *${symbol}* — ${timeframe}\nPrice: $${currentPrice}\n${priceChangeEmoji} ${priceChangePercent}%`;

    const chartBuffer = await generateCandleStickChart(priceHistory);
    await ctx.answerCbQuery();
    await ctx.replyWithPhoto(
      { source: chartBuffer },
      {
        caption: message,
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("5M", "tf_5m"),
            Markup.button.callback("15M", "tf_15m"),
            Markup.button.callback("1H", "tf_1h"),
          ],
          [
            Markup.button.callback("4H", "tf_4h"),
            Markup.button.callback("1D", "tf_1d"),
          ],
          [
            Markup.button.callback("💰 Buy", "show_buy"),
            Markup.button.callback("📊 Positions", "show_positions"),
          ],
          ...buildTokenLinkRows(pending.tokenAddress, pending.pairAddress),
        ]),
      },
    );
  } catch (err) {
    console.error("Timeframe switch failed:", err);
    await ctx.answerCbQuery("something went wrong .... sha try again");
  }
});

bot.on("text", async (ctx, next) => {
  const awaitingCustom = await getAwaitingCustomAmount(ctx.chat.id);
  if (awaitingCustom) {
    await setAwaitingCustomAmount(ctx.chat.id, false);
    const amount = parseFloat(ctx.message.text.trim());
    if (isNaN(amount) || amount <= 0)
      return ctx.reply("That doesn't look like a valid amount. Tap Buy again.");
    return executeBuy(ctx, amount);
  }

  const mode = await getMode(ctx.chat.id);
  if (mode === "trading") return handleTradingInput(ctx);
  return next();
});

bot.on("text", async (ctx, next) => {
  const mode = await getMode(ctx.chat.id);
  if (mode === "trading") {
    return handleTradingInput(ctx);
  }
  return next();
});

bot.on("message", async (ctx) => {
  const userMessage = ctx.message.text;
  const chatId = ctx.chat.id;
  if (!userMessage) return;

  try {
    const history = await getSession(chatId);
    history.push({ role: "user", content: userMessage });
    const result = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "system", content: systemPrompt }, ...history],
    });

    function splitMessage(text, maxLength = 4096) {
      const chunks = [];
      let remainingText = text;
      while (remainingText.length > maxLength) {
        let splitIndex = remainingText.lastIndexOf("\n", maxLength);
        if (splitIndex === -1) {
          splitIndex = maxLength;
        }
        chunks.push(remainingText.slice(0, splitIndex));
        remainingText = remainingText.slice(splitIndex);
      }
      if (remainingText.length > 0) {
        chunks.push(remainingText);
      }
      return chunks;
    }

    const response = result.choices[0].message.content;
    const tokenUsed = result.usage.completion_tokens;
    history.push({ role: "assistant", content: response });
    await saveSession(ctx.chat.id, history);
    saveMessagesToPostgres(chatId, "user", userMessage).catch((err) =>
      console.error("Failed to save user message:", err),
    );
    saveMessagesToPostgres(chatId, "assistant", response, tokenUsed).catch(
      (err) => console.error("Failed to save messages:", err),
    );
    const messageChunks = splitMessage(response);
    for (const chunk of messageChunks) {
      await ctx.reply(chunk);
    }
  } catch (error) {
    await ctx.reply("Sorry love, something went wrong");
    console.error("Full error:", error.message);
  }
});

function buildTokenLinkRows(tokenAddress, pairAddress) {
  return [
    [
      Markup.button.url(
        "DexScreener",
        `https://dexscreener.com/solana/${pairAddress}`,
      ),
      Markup.button.url("Solscan", `https://solscan.io/token/${tokenAddress}`),
    ],
    [
      Markup.button.url(
        "CoinGecko",
        `https://www.geckoterminal.com/solana/pools/${pairAddress}`,
      ),
    ],
  ];
}

async function handleTradingInput(ctx) {
  try {
    const text = ctx.message.text.trim();
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

    if (solanaAddressRegex.test(text)) {
      const info = await getTokenInfoWithFallback(text);
      if (!info)
        return ctx.reply("Damn....urgh no data found for this address");
      if (!info.pairAddress) {
        return ctx.reply(
          "Found the token, but no pool address available — chart won't work for this one",
        );
      }
      await setPendingChart(ctx.chat.id, {
        tokenAddress: text,
        pairAddress: info.pairAddress,
      });
      const [authority, holders, holderCount] = await Promise.all([
        getTokenAuthority(text).catch((err) => {
          console.error("mint and freeze failed", err.message);
          return null;
        }),
        getTopHolders(text).catch((err) => {
          console.error("Get top holders failed ", err.message);
          return null;
        }),
        getHolderConditions(text).catch((err) => {
          console.error("get holders failed", err.message);
          return null;
        }),
      ]);

      // const walletRecord = await getWallet(ctx.from.id)
      // const secretKeyBytes = decryptSecretKey(walletRecord.encrypted_secret, walletRecord.iv, process.env.ENCRYPTION_KEY)
      // const userKeypair = Keypair.fromSecretKey(secretKeyBytes)
      const mintStatus =
        authority === null
          ? "Unknown"
          : authority.isMintable
            ? "⚠ warning"
            : "✔ Renounced";
      const freezeStatus =
        authority === null
          ? "Unknown"
          : authority.isFreezable
            ? "⚠ warning"
            : "✔ Renounced";
      const top10Holders = holders ? `${holders.top10Percentage}%` : "N/A";
      const message = `
      📊 *${info.name}* (${info.symbol})

      💸 Price: $${info.priceUsd}
      📉 24h Change: ${info.priceChange24h}%
      💧  Liquidity: $${Number(info.liquidityUsd ?? 0).toLocaleString()}
      💹 24h Volume: $${Number(info.volume24h ?? 0).toLocaleString()}
      🏷  Market Cap: ${info.marketCap ? "$" + Number(info.marketCap).toLocaleString() : "N/A"}
      🔁 DEX: ${info.dex}
      ⏳ Age: ${getTokenAge(info.pairCreatedAt)}

      🔐 Mint Authority: ${mintStatus}
      🥶 Freeze Authority: ${freezeStatus}
      👥 Holders: ${holderCount ?? "N/A"}
      🔝 Top 10 Hold: ${top10Holders}
    `.trim();

      const introCard = await generateTokenIntroCard({
        name: info.name,
        symbol: info.symbol,
        bannerUrl: info.imageUrl,
        marketCap: info.marketCap,
        volume24h: info.volume24h,
        liquidityUsd: info.liquidityUsd,
        priceChangePercent: info.priceChange24h,
      });
      const priceHistory = await getPriceHistory(info.pairAddress).catch(
        () => null,
      );

      const hasChartData = priceHistory && priceHistory.length > 0;
      if (hasChartData) {
        await setChartState(ctx.chat.id, {
          symbol: info.symbol,
          currentPrice: info.priceUsd,
          priceChangeEmoji: info.priceChange24h >= 0 ? "🟢" : "🔴",
          priceChangePercent: info.priceChange24h,
        });
      }

      if (priceHistory && priceHistory.length > 0) {
        const chartBuffer = await generateCandleStickChart(priceHistory);
        const priceChangeEmoji = info.priceChange24h >= 0 ? "🟢" : "🔴";
        await setChartState(ctx.chat.id, {
          symbol: info.symbol,
          currentPrice: info.priceUsd,
          priceChangeEmoji,
          priceChangePercent: info.priceChange24h,
        });
        return ctx.replyWithPhoto(
          { source: introCard },
          {
            caption: message,
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              ...(hasChartData
                ? [
                    [
                      Markup.button.callback("5M", "tf_5m"),
                      Markup.button.callback("15M", "tf_15m"),
                      Markup.button.callback("1H", "tf_1h"),
                    ],
                    [
                      Markup.button.callback("4H", "tf_4h"),
                      Markup.button.callback("1D", "tf_1d"),
                    ],
                  ]
                : []),
              [
                Markup.button.callback("💰 Buy", "show_buy"),
                Markup.button.callback("📊 Positions", "show_positions"),
              ],
              ...buildTokenLinkRows(text, info.pairAddress),
            ]),
          },
        );
      }

      return ctx.replyWithMarkdown(
        message,
        Markup.inlineKeyboard(buildTokenLinkRows(text, info.pairAddress)),
      );
    } else {
      return ctx.reply(
        "In trading mode. Paste a Ca to look up a token. Might be a solana token",
      );
    }
  } catch (err) {
    console.error("handleTradingInput failed", err);
    return ctx.reply("⚠ Yikes, something went wrong please try again later");
  }
}
