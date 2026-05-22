import type { TransactionLog } from "./transaction-log.js";
import type { PositionStore } from "./position-store.js";
import type { SessionTracker } from "./session-tracker.js";
import type { PendingOrder, OpenPosition } from "../types/index.js";
import logger from "../utils/logger.js";

// Replay all events from the transaction log to rebuild in-memory state.
export function recoverState(
  log: TransactionLog,
  positions: PositionStore,
  session: SessionTracker,
): void {
  const events = log.readAll();
  logger.info({ count: events.length }, "Replaying events for state recovery");

  for (const event of events) {
    try {
      switch (event.type) {
        case "ORDER_SUBMITTED": {
          const order = event.payload as unknown as PendingOrder;
          positions.addPendingOrder(order);
          session.addNotional(order.size);
          break;
        }
        case "ORDER_FILLED": {
          const { orderId } = event.payload as { orderId: string };
          positions.confirmFill(orderId);
          break;
        }
        case "ORDER_FAILED": {
          const { orderId } = event.payload as { orderId: string };
          positions.removePendingOrder(orderId);
          break;
        }
        case "POSITION_CLOSED": {
          const { tokenId, pnl } = event.payload as {
            tokenId: string;
            pnl: number;
          };
          positions.closePosition(tokenId);
          session.recordPnl(pnl);
          break;
        }
      }
    } catch (err) {
      logger.warn({ err, event }, "Failed to replay event — skipping");
    }
  }

  logger.info(
    {
      openPositions: positions.getAllPositions().length,
      pendingOrders: positions.getAllPendingOrders().length,
      session: session.getSummary(),
    },
    "State recovery complete",
  );
}

// Reconcile recovered state against live CLOB API data.
// Logs mismatches but does not auto-correct (human review required).
export async function reconcileWithLive(
  positions: PositionStore,
  getOpenOrders: () => Promise<unknown>,
): Promise<void> {
  try {
    const liveOrders = await getOpenOrders();
    const pendingCount = positions.getAllPendingOrders().length;
    const liveCount = Array.isArray(liveOrders) ? liveOrders.length : 0;

    if (pendingCount !== liveCount) {
      logger.warn(
        { local: pendingCount, live: liveCount },
        "Pending order count mismatch between local state and CLOB API — manual review recommended",
      );
    } else {
      logger.info("State reconciliation OK");
    }
  } catch (err) {
    logger.warn({ err }, "Live reconciliation failed — continuing with recovered state");
  }
}
