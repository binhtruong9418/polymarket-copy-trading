import { checkExposure } from "./exposure-guard.js";
import { checkDrawdown } from "./drawdown-guard.js";
import { checkBalance, getCachedBalance } from "./balance-guard.js";
import logger from "../utils/logger.js";
import type { TradeSignal, RiskDecision } from "../types/index.js";
import type { PositionStore } from "../state/position-store.js";
import type { SessionTracker } from "../state/session-tracker.js";

const SIGNAL_STALE_MS = 10_000;

export class RiskEngine {
  constructor(
    private positions: PositionStore,
    private session: SessionTracker,
  ) {}

  evaluate(signal: TradeSignal, proposedSize: number): RiskDecision {
    // 1. SELL guard — only copy a sell if we actually hold that token
    if (signal.side === "SELL") {
      const pos = this.positions.getPosition(signal.tokenId);
      if (!pos) {
        return {
          approved: false,
          reason: `No position to sell for tokenId ${signal.tokenId.slice(0, 12)}…`,
        };
      }
    }

    // 2. Staleness — price likely moved
    if (Date.now() - signal.timestamp > SIGNAL_STALE_MS) {
      return { approved: false, reason: "Signal stale (>10s old)" };
    }

    // 3. Minimum size
    if (proposedSize < 1) {
      return { approved: false, reason: "Size below $1 minimum" };
    }

    // 4. Balance guard (uses cached value — no I/O)
    const balanceDecision = checkBalance(proposedSize);
    if (!balanceDecision.approved) {
      logger.warn({ reason: balanceDecision.reason }, "Risk: balance rejected");
      return balanceDecision;
    }

    // 5. Exposure caps
    const exposureDecision = checkExposure(
      signal.conditionId,
      proposedSize,
      this.session.getSessionNotional(),
      this.positions,
    );
    if (!exposureDecision.approved) {
      logger.warn(
        { reason: exposureDecision.reason },
        "Risk: exposure rejected",
      );
      return exposureDecision;
    }

    // 6. Drawdown halt
    const drawdownDecision = checkDrawdown(
      this.session.getStartBalance(),
      getCachedBalance(),
    );
    if (!drawdownDecision.approved) {
      logger.error(
        { reason: drawdownDecision.reason },
        "Risk: drawdown halt active",
      );
      return drawdownDecision;
    }

    return { approved: true, adjustedSize: proposedSize };
  }
}
