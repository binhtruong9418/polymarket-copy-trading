/**
 * Standalone dry-run monitor — connects to Polymarket public WebSocket,
 * watches a target wallet, and sends Telegram notifications per detected trade.
 * No Polymarket API keys required (public feed, DRY_RUN only).
 *
 * Usage:
 *   npx tsx scripts/dry-run-monitor.ts
 *   TARGET_WALLETS=0x... COPY_RATIO=0.2 npx tsx scripts/dry-run-monitor.ts
 *
 * All config is self-contained below — no .env file required for dry-run mode.
 */
import { RealTimeDataClient } from "@polymarket/real-time-data-client";
import type { Message } from "@polymarket/real-time-data-client";
import { Side, OrderType } from "@polymarket/clob-client";
import { parseTradeMessage } from "../src/signal/trade-filter.js";
import { buildCopyOrder } from "../src/execution/order-builder.js";
import { DedupCache } from "../src/execution/dedup-cache.js";
import { enrichSignalMetadata } from "../src/signal/market-enricher.js";
import pino from "pino";

// ── Config (override via env vars) ──────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   ?? "";
const TARGET_WALLETS     = (process.env.TARGET_WALLETS ?? "0xce25e214d5cfe4f459cf67f08df581885aae7fdc")
  .split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
const COPY_RATIO         = Number(process.env.COPY_RATIO ?? "0.1");
const COPY_STRATEGY      = (process.env.COPY_STRATEGY ?? "proportional") as "proportional" | "exact";
const MAX_PER_TRADE      = Number(process.env.MAX_NOTIONAL_PER_TRADE ?? "50");
// ────────────────────────────────────────────────────────────────────────────

const log = pino({ level: "info", transport: { target: "pino-pretty", options: { colorize: true } } });

const targetSet = new Set(TARGET_WALLETS);
const dedup = new DedupCache();

const rule = { wallet: TARGET_WALLETS[0], strategy: COPY_STRATEGY, ratio: COPY_RATIO, maxPerTrade: MAX_PER_TRADE };

log.info({ targets: TARGET_WALLETS, rule }, "Dry-run monitor starting");
await tg(`🚀 <b>Dry-run monitor started</b>\n\nWatching: <code>${TARGET_WALLETS.join("\n")}</code>\nRatio: ${COPY_RATIO} × original size\nMax/trade: $${MAX_PER_TRADE}`);

const client = new RealTimeDataClient({
  autoReconnect: true,
  pingInterval: 30_000,

  onConnect: (c) => {
    log.info("Connected to Polymarket real-time feed");
    c.subscribe({ subscriptions: [{ topic: "activity", type: "trades" }] });
  },

  onMessage: async (_c: RealTimeDataClient, msg: Message) => {
    const signal = parseTradeMessage(msg, targetSet);
    if (!signal || dedup.isDuplicate(signal.id)) return;

    log.info({ side: signal.side, price: signal.price, size: signal.size }, "Target trade detected");

    const order = buildCopyOrder(signal, rule, 10_000);
    if (!order) { log.warn("Copy size below minimum — skipped"); return; }

    // Enrich with Gamma API when WS omits market metadata
    if (!signal.title || !signal.outcome) {
      const meta = await enrichSignalMetadata(signal.tokenId, signal.conditionId);
      if (meta.title)   signal.title   = meta.title;
      if (meta.outcome) signal.outcome = meta.outcome;
      if (meta.slug)    signal.slug    = meta.slug;
    }

    const sideEmoji    = signal.side === "BUY" ? "🟢" : "🔴";
    const outcomeEmoji = signal.outcome === "Up" ? "📈" : signal.outcome === "Down" ? "📉" : "🎯";
    const lag = signal.detectedAt - signal.timestamp;
    const ts  = new Date(signal.timestamp).toISOString();

    const lines = [`<b>🔍 DRY-RUN Copy Trade Signal</b>`, ``];
    if (signal.title)   lines.push(`📌 <b>${signal.title}</b>`);
    if (signal.outcome) lines.push(`${outcomeEmoji} Outcome: <b>${signal.outcome}</b>`);
    lines.push(
      ``,
      `${sideEmoji} <b>${signal.side}</b>  |  Price: <b>${(signal.price * 100).toFixed(2)}¢</b>  |  Implied: ${(signal.price * 100).toFixed(0)}%`,
      `Copy size: <b>$${order.userOrder.size} USDC</b>  (original: $${signal.size})`,
      `Strategy: ${rule.strategy} × ${rule.ratio}`,
      ``,
      `Source wallet: <code>${signal.sourceWallet}</code>`,
      `Signal lag: ${lag}ms  |  ${ts}`,
    );
    await tg(lines.join("\n"));
  },

  onStatusChange: (status) => {
    log.info({ status }, "WS status");
    if (status === "DISCONNECTED") tg("⚠️ WebSocket disconnected — reconnecting...").catch(() => {});
  },
});

client.connect();
log.info("Listening for trades… (Ctrl+C to stop)");

process.on("SIGINT", async () => {
  client.disconnect();
  await tg("🛑 Dry-run monitor stopped");
  process.exit(0);
});

async function tg(text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (err) {
    log.warn({ err }, "Telegram send failed");
  }
}
