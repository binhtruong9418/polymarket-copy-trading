import { env } from "../config/env-config.js";
import type { PositionStore } from "../state/position-store.js";
import type { RiskDecision } from "../types/index.js";

export function checkExposure(
  conditionId: string,
  proposedSize: number,
  sessionNotional: number,
  positions: PositionStore,
): RiskDecision {
  const marketExposure = positions.getMarketExposure(conditionId);

  if (marketExposure + proposedSize > env.MAX_MARKET_EXPOSURE) {
    return {
      approved: false,
      reason: `Market exposure cap: current=${marketExposure}, proposed=${proposedSize}, limit=${env.MAX_MARKET_EXPOSURE}`,
    };
  }

  if (sessionNotional + proposedSize > env.MAX_SESSION_NOTIONAL) {
    return {
      approved: false,
      reason: `Session notional cap: current=${sessionNotional}, proposed=${proposedSize}, limit=${env.MAX_SESSION_NOTIONAL}`,
    };
  }

  return { approved: true };
}
