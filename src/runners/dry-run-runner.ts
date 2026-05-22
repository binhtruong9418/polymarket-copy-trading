import { RealTimeDataClient } from "@polymarket/real-time-data-client";
import type { Message } from "@polymarket/real-time-data-client";
import { parseTradeMessage } from "../signal/trade-filter.js";
import { buildCopyOrder } from "../execution/order-builder.js";
import { DedupCache } from "../execution/dedup-cache.js";
import { enrichSignalMetadata } from "../signal/market-enricher.js";
import { notifyDryRunTrade } from "../monitoring/alert-notifier.js";
import { sendTelegram } from "../monitoring/alert-notifier.js";
import { buildCopyRules, getRuleForWallet } from "../config/trading-config.js";
import { env } from "../config/env-config.js";
import logger from "../utils/logger.js";

export async function startDryRunRunner(): Promise<void> {
  const rules = buildCopyRules();
  const targetSet = new Set(env.TARGET_WALLETS);
  const dedup = new DedupCache();

  logger.info({ targets: env.TARGET_WALLETS, dryRun: true }, "Starting in DRY-RUN mode");

  await sendTelegram(
    `🚀 <b>Dry-run monitor started</b>\n\n` +
    `Watching: <code>${env.TARGET_WALLETS.join("\n")}</code>\n` +
    `Ratio: ${env.COPY_RATIO} × original size\n` +
    `Max/trade: $${env.MAX_NOTIONAL_PER_TRADE}`,
  );

  const client = new RealTimeDataClient({
    autoReconnect: true,
    pingInterval: 30_000,

    onConnect: (c) => {
      logger.info("WS connected — subscribing to trade feed");
      c.subscribe({ subscriptions: [{ topic: "activity", type: "trades" }] });
    },

    onMessage: async (_c: RealTimeDataClient, msg: Message) => {
      const signal = parseTradeMessage(msg, targetSet);
      if (!signal || dedup.isDuplicate(signal.id)) return;

      const rule = getRuleForWallet(rules, signal.sourceWallet);
      if (!rule) return;

      logger.info(
        { side: signal.side, price: signal.price, size: signal.size, title: signal.title },
        "Signal detected",
      );

      // Enrich with Gamma API when WS omits market metadata
      if (!signal.title || !signal.outcome) {
        const meta = await enrichSignalMetadata(signal.tokenId, signal.conditionId);
        if (meta.title)   signal.title   = meta.title;
        if (meta.outcome) signal.outcome = meta.outcome;
        if (meta.slug)    signal.slug    = meta.slug;
      }

      const order = buildCopyOrder(signal, rule, 10_000);
      if (!order) {
        logger.debug({ size: signal.size * rule.ratio }, "Copy size below $1 minimum — skipped");
        return;
      }

      await notifyDryRunTrade(signal, order, rule);
    },

    onStatusChange: (status) => {
      logger.info({ status }, "WS status");
      if (status === "DISCONNECTED") {
        sendTelegram("⚠️ WebSocket disconnected — reconnecting...").catch(() => {});
      }
    },
  });

  client.connect();

  process.on("SIGINT",  () => shutdown(client, "SIGINT"));
  process.on("SIGTERM", () => shutdown(client, "SIGTERM"));
}

async function shutdown(client: RealTimeDataClient, reason: string): Promise<void> {
  logger.info({ reason }, "Dry-run monitor stopping");
  client.disconnect();
  await sendTelegram("🛑 Dry-run monitor stopped");
  process.exit(0);
}
