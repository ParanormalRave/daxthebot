import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getWallet } from "../src/lib/walletDb.js";
import { decryptSecretKey } from "../src/lib/wallet.js";

const [toAddress, amountSol] = process.argv.slice(2);
if (!toAddress || !amountSol) {
  console.log(
    "usage: node --env-file=.env scripts/devnet-test.js <toAddress> <sol>",
  );
  process.exit(1);
}

// devnet is hard-coded on purpose. This script can never touch mainnet.
const conn = new Connection(clusterApiUrl("devnet"), "confirmed");

const row = await getWallet(Number(process.env.OwnerId));
if (!row) {
  console.log("no wallet row for OwnerId");
  process.exit(1);
}

const keypair = Keypair.fromSecretKey(
  decryptSecretKey(row.encrypted_secret, row.iv, row.auth_tag),
);
if (keypair.publicKey.toString() !== row.public_key) {
  console.log("decrypted key does not match stored address");
  process.exit(1);
}

const before = await conn.getBalance(keypair.publicKey);
console.log(
  "from:",
  row.public_key,
  "| devnet balance:",
  before / LAMPORTS_PER_SOL,
  "SOL",
);

const lamports = Math.round(Number(amountSol) * LAMPORTS_PER_SOL);
if (before < lamports + 10_000) {
  console.log("not enough devnet SOL. Fund it first.");
  process.exit(1);
}

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: new PublicKey(toAddress),
    lamports,
  }),
);
const signature = await sendAndConfirmTransaction(conn, tx, [keypair]);
console.log("sent. signature:", signature);
console.log(`https://solscan.io/tx/${signature}?cluster=devnet`);
process.exit(0);
