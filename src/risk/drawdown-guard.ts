import { env } from "../config/env-config.js";
import logger from "../utils/logger.js";
import type { RiskDecision } from "../types/index.js";

// Halt trading for 24h after max drawdown is breached
const HALT_DURATION_MS = 24 * 60 * 60 * 1000;

let haltUntil = 0;

export function checkDrawdown(
  sessionStartBalance: number,
  currentBalance: number,
): RiskDecision {
  if (Date.now() < haltUntil) {
    return {
      approved: false,
      reason: `Drawdown halt active until ${new Date(haltUntil).toISOString()}`,
    };
  }

  if (sessionStartBalance <= 0) return { approved: true };

  const drawdownPct =
    ((sessionStartBalance - currentBalance) / sessionStartBalance) * 100;

  if (drawdownPct >= env.MAX_DRAWDOWN_PCT) {
    haltUntil = Date.now() + HALT_DURATION_MS;
    logger.error(
      { drawdownPct, limit: env.MAX_DRAWDOWN_PCT, haltUntil },
      "Max drawdown breached — halting for 24h",
    );
    return {
      approved: false,
      reason: `Drawdown ${drawdownPct.toFixed(2)}% >= limit ${env.MAX_DRAWDOWN_PCT}%`,
    };
  }

  return { approved: true };
}

export function isHaltActive(): boolean {
  return Date.now() < haltUntil;
}

export function getHaltUntil(): number {
  return haltUntil;
}

// Restore halt state on startup (called by state-recovery)
export function restoreHalt(until: number): void {
  haltUntil = until;
}
