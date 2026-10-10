import { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
export const connection = new Connection(RPC_URL, "confirmed");

export async function getBalance(walletAddress) {
  const publicKey = new PublicKey(walletAddress);
  const lamports = await connection.getBalance(publicKey);
  return lamports / 1e9;
}

// mint and freeze check
export async function getTokenAuthority(tokenAddress) {
  const mintPubkey = new PublicKey(tokenAddress);
  const accountInfo = await connection.getAccountInfo(mintPubkey);
  if(!accountInfo)throw new Error ('Mint account not found')


  const programId = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
  ? TOKEN_2022_PROGRAM_ID
  : TOKEN_PROGRAM_ID


  const mintInfo = await getMint(connection, mintPubkey, 'confirmed', programId)
  return {
    mintAuthority: mintInfo.mintAuthority
      ? mintInfo.mintAuthority.toString()
      : null,
    isMintable: mintInfo.mintAuthority !== null,
    freezeAuthority: mintInfo.freezeAuthority
      ? mintInfo.freezeAuthority.toString()
      : null, 
    isFreezable: mintInfo.freezeAuthority !== null,
    currentSupply: mintInfo.supply.toString(),
    decimals: mintInfo.decimals,
  };
}

const KNOWN_BURN_ADDRESSES = [
  "1nc1nerator11111111111111111111111111111111",
  "11111111111111111111111111111111",
];

export async function checkLiquidityBurnStatus(lpMintAddress) {
  const lpMintPublicKey = new PublicKey(lpMintAddress);

  const supply = await connection.getTokenSupply(lpMintPublicKey);
  const totalLpSupply = Number(supply.value.amount);

  const largestAccount =
    await connection.getTokenLargestAccounts(lpMintPublicKey);
  let burnedAmount = 0;
  let burnedPercentage = 0; // FIX: declared outside the loop so it survives past it

  for (const account of largestAccount.value) {
    const accountInfo = await connection.getParsedAccountInfo(account.address);
    const owner = accountInfo.value?.data?.parsed?.info?.owner;

    if (KNOWN_BURN_ADDRESSES.includes(owner)) {
      burnedAmount += Number(account.amount);
    }
  }

  // FIX: percentage calculated once after the loop, using the final burnedAmount
  burnedPercentage = (burnedAmount / totalLpSupply) * 100;

  return {
    totalLpSupply,
    burnedAmount,
    burnedPercentage: burnedPercentage.toFixed(2),
    isEffective: burnedPercentage > 95,
  };
}

export async function getTopHolders(tokenAddress) {
  const mintAddress = new PublicKey(tokenAddress);
  const largestAccounts = await connection.getTokenLargestAccounts(mintAddress);

  const top10 = largestAccounts.value.slice(0, 10);
  const totalSupply = await connection.getTokenSupply(mintAddress);

  const top10WithOwners = await Promise.all(
    top10.map(async (acc) => {
      const accountInfo = await connection.getParsedAccountInfo(acc.address);
      const owner = accountInfo.value?.data?.parsed?.info?.owner;
      return { owner, amount: acc.amount };
    }),
  );

  const top10supply = top10.reduce((sum, acc) => sum + Number(acc.amount), 0);
  const totalSupplyAmount = Number(totalSupply.value.amount);
  const tenPercent = (top10supply / totalSupplyAmount) * 100;

  return {
    top10Holders: top10WithOwners.map((acc) => ({
      address: acc.owner ?? "Unknown",
      balance: acc.amount,
    })),
    top10Percentage: tenPercent.toFixed(2),
  };
}

const MAX_PAGES = 20;            // 20 pages x 1000 accounts = counts up to 20,000 holders
const MAX_TIME_MS = 15_000;      // stop paging after 15 seconds in total
const REQUEST_TIMEOUT_MS = 8_000; // give up on any single request after 8 seconds

export async function getHolderConditions(tokenAddress) {
  let cursor = null;
  const owners = new Set();
  const deadline = Date.now() + MAX_TIME_MS;
  let pages = 0;
  let capped = false;

  while (true) {
    if (pages >= MAX_PAGES || Date.now() > deadline) {
      capped = true; // there were more pages, we just stopped early
      break;
    }
    pages++;

    const body = {
      jsonrpc: "2.0",
      id: "holder account",
      method: "getTokenAccounts",
      params: {
        mint: tokenAddress,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      },
    };
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Helius returned ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Helius error: ${data.error.message}`);

    const accounts = data.result?.token_accounts ?? [];
    if (accounts.length === 0) break;

    for (const acc of accounts) owners.add(acc.owner);

    cursor = data.result?.cursor;
    if (!cursor) break;
  }
  return { count: owners.size, capped };
}