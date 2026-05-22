/**
 * Standalone test: simulate a copy-trade signal in DRY_RUN mode
 * and send the Telegram notification without a live Polymarket connection.
 */
import { OrderType, Side } from "@polymarket/clob-client";
import type { TradeSignal, CopyRule } from "../src/types/index.js";
import type { BuiltOrder } from "../src/execution/order-builder.js";

// Inject test env before loading modules that read it
process.env.TELEGRAM_BOT_TOKEN = "8875554401:AAGr5Wf4L9FoCiJJ4ScODpYIdiuNfPz5oas";
process.env.TELEGRAM_CHAT_ID = "1800896372";
process.env.DRY_RUN = "true";
process.env.LOG_LEVEL = "info";
// Dummy required fields (not used in notification path)
process.env.POLYMARKET_API_KEY = "dummy";
process.env.POLYMARKET_SECRET = "dummy";
process.env.POLYMARKET_PASSPHRASE = "dummy";
process.env.PRIVATE_KEY = "0x" + "a".repeat(64);
process.env.TARGET_WALLETS = "0xdeadbeef";

const { notifyDryRunTrade } = await import("../src/monitoring/alert-notifier.js");

const now = Date.now();

const signal: TradeSignal = {
  id: "0xabc123testSignal",
  sourceWallet: "0x1234567890abcdef1234567890abcdef12345678",
  conditionId: "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
  tokenId: "0xtoken999888777",
  side: "BUY",
  price: 0.65,
  size: 200,        // original trade: $200 USDC
  timestamp: now - 82,
  detectedAt: now,
};

const order: BuiltOrder = {
  userOrder: {
    tokenID: signal.tokenId,
    price: signal.price,
    size: 20,           // copy size: $20 USDC (0.1 ratio)
    side: Side.BUY,
  },
  orderType: OrderType.GTC,
};

const rule: CopyRule = {
  wallet: signal.sourceWallet,
  strategy: "proportional",
  ratio: 0.1,
  maxPerTrade: 50,
};

console.log("Sending dry-run Telegram notification...");
await notifyDryRunTrade(signal, order, rule);
console.log("Done — check your Telegram.");
