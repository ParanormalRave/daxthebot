const default_token_image = "https://zgbcqmmmjbafpitahnto.supabase.co/storage/v1/object/public/dax_default_image/dax_default_image.jpg"

const getTokeninfo = async (address) => {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`)
  const data = await res.json()

  if (!data.pairs || data.pairs.length === 0) return null
  const pair = data.pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0]
  console.log(data)
  return {
    address,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    priceUsd: pair.priceUsd,
    priceChange24h: pair.priceChange?.h24,
    liquidityUsd: pair.liquidity?.usd,
    volume24h: pair.volume?.h24,
    marketCap: pair.marketCap ?? null,
    dex: pair.dexId,
    pairAddress: pair.pairAddress,
    pairCreatedAt: pair.pairCreatedAt,
    chartUrl: pair.url,
    imageUrl: pair.info?.imageUrl ?? default_token_image,
    fetchedAt: new Date().toISOString(),
  }
}

export async function getPairInfo(pairAddress) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`)
  const data = await res.json()
  const pair = data.pair ?? data.pairs?.[0]
  if (!pair) return null
  return {
    priceUsd: pair.priceUsd,
    priceChange24h: pair.priceChange?.h24,
    liquidityUsd: pair.liquidity?.usd,
    volume24h: pair.volume?.h24,
    marketCap: pair.marketCap ?? null,
    imageUrl: pair.info?.imageUrl ?? default_token_image,
  }
}

export async function getTokenInfoWithFallback(address) {
  try {
    const dex = await getTokeninfo(address)
    if (dex) return dex
  } catch (e) {
    console.warn('Dex Screeener is not connected, trying coingecko')
  }

  const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${address}`)
  const data = await res.json()
  const attrs = data?.data?.attributes

  const topPoolId = data?.data?.relationships?.top_pools?.data?.[0]?.id
  const poolAddress = topPoolId ? topPoolId.split('_')[1] : null

  return {
    name: attrs?.name,
    symbol: attrs?.symbol,
    priceUsd: attrs?.price_usd,
    marketCap: attrs?.market_cap_usd,
    imageUrl: attrs?.image_url ?? default_token_image,
    pairAddress: poolAddress,
    source: `geckoterminal`,
  }
}

export async function getPriceHistory(poolAddress, timeframe = 'hour', aggregate = 1, limit = 300) {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}`,
  )
  const data = await res.json()
  const candles = (await data.data?.attributes?.ohlcv_list) ?? []

  return candles
    .map(([timestamp, open, high, low, close]) => ({
      timestamp: timestamp * 1000,
      open,
      high,
      low,
      close,
    }))
    .reverse()
}

export function getTokenAge(pairCreatedAt) {
  if (!pairCreatedAt) return 'Unknown'
  const ageMs = Date.now() - pairCreatedAt
  const minutes = Math.floor(ageMs / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}