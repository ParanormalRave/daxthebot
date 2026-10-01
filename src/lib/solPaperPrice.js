const WSOL = 'So11111111111111111111111111111111111111112'
let cache = { price: null, at: 0 }

export async function getSolPriceUsd() {
  if (cache.price && Date.now() - cache.at < 30_000) return cache.price
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${WSOL}`,
    )
    if (!res.ok) throw new Error(`status ${res.status}`)
    const data = await res.json()
    const price = Number(data?.data?.attributes?.price_usd)
    if (!price) throw new Error('no price')
    cache = { price, at: Date.now() }
    return price
  } catch (e) {
    if (cache.price) return cache.price // stale beats invented
    throw new Error('SOL price unavailable')
  }
}