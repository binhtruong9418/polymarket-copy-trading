import { EventEmitter } from "events";
import { buildCopyOrder } from "./order-builder.js";
import { DedupCache } from "./dedup-cache.js";
import {
  getClobClient,
  isCircuitOpen,
  recordSuccess,
  recordFailure,
} from "./clob-client-singleton.js";
import { notifyDryRunTrade } from "../monitoring/alert-notifier.js";
import { env } from "../config/env-config.js";
import logger from "../utils/logger.js";
import type { TradeSignal, CopyRule } from "../types/index.js";

const SIGNAL_STALE_MS = 10_000;
const ORDER_TIMEOUT_MS = 3_000;

export class OrderExecutor extends EventEmitter {
  private dedup = new DedupCache();

  async execute(
    signal: TradeSignal,
    rule: CopyRule,
    availableBalance: number,
  ): Promise<void> {
    // Staleness check — market may have moved
    if (Date.now() - signal.timestamp > SIGNAL_STALE_MS) {
      logger.debug({ id: signal.id }, "Signal stale, skipping");
      return;
    }

    if (this.dedup.isDuplicate(signal.id)) {
      logger.debug({ id: signal.id }, "Duplicate signal, skipping");
      return;
    }

    if (isCircuitOpen()) {
      logger.warn("Circuit open — order skipped");
      return;
    }

    const built = buildCopyOrder(signal, rule, availableBalance);
    if (!built) {
      logger.debug({ signal }, "Order size below minimum, skipping");
      return;
    }

    const submittedAt = Date.now();

    if (env.DRY_RUN) {
      logger.info({ order: built.userOrder, orderType: built.orderType }, "DRY_RUN — order not submitted");
      await notifyDryRunTrade(signal, built, rule);
      this.emit("orderDryRun", { signal, order: built });
      return;
    }

    try {
      const result = await Promise.race([
        getClobClient().createAndPostOrder(built.userOrder, undefined, built.orderType),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Order timeout")), ORDER_TIMEOUT_MS),
        ),
      ]);

      const latencyMs = Date.now() - signal.detectedAt;
      recordSuccess();
      logger.info(
        {
          orderId: result?.orderID,
          tokenId: signal.tokenId,
          side: signal.side,
          size: built.userOrder.size,
          price: built.userOrder.price,
          latencyMs,
          signalLagMs: signal.detectedAt - signal.timestamp,
        },
        "Order submitted",
      );
      this.emit("orderSubmitted", {
        signal,
        order: built,
        result,
        submittedAt,
        latencyMs,
      });
    } catch (err) {
      recordFailure();
      logger.error({ err, signal }, "Order submission failed");
      this.emit("orderFailed", { signal, err });
    }
  }
}
