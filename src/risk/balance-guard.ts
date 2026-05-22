import { getClobClient } from "../execution/clob-client-singleton.js";
import logger from "../utils/logger.js";
import type { RiskDecision } from "../types/index.js";

const REFRESH_INTERVAL_MS = 30_000;

let cachedBalance = 0;
let lastRefreshedAt = 0;

export async function getAvailableBalance(): Promise<number> {
  if (Date.now() - lastRefreshedAt > REFRESH_INTERVAL_MS) {
    await refreshBalance();
  }
  return cachedBalance;
}

export async function refreshBalance(): Promise<void> {
  try {
    const res = await getClobClient().getBalanceAllowance();
    // asset_id undefined = USDC collateral balance
    const balance = parseFloat(String(res.balance ?? "0"));
    cachedBalance = balance;
    lastRefreshedAt = Date.now();
    logger.debug({ balance }, "Balance refreshed");
  } catch (err) {
    logger.warn({ err }, "Balance refresh failed — using last known value");
  }
}

export function checkBalance(proposedSize: number): RiskDecision {
  if (proposedSize > cachedBalance * 0.95) {
    return {
      approved: false,
      reason: `Insufficient balance: have=${cachedBalance}, need=${proposedSize}`,
    };
  }
  return { approved: true };
}

export function getCachedBalance(): number {
  return cachedBalance;
}
