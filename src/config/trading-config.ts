import { env } from "./env-config.js";
import type { CopyRule } from "../types/index.js";

// Build per-wallet copy rules from env. All wallets share the same global
// strategy/ratio unless overridden via a JSON config file in the future.
export function buildCopyRules(): CopyRule[] {
  return env.TARGET_WALLETS.map((wallet) => ({
    wallet,
    strategy: env.COPY_STRATEGY,
    ratio: env.COPY_RATIO,
    maxPerTrade: env.MAX_NOTIONAL_PER_TRADE,
  }));
}

export function getRuleForWallet(
  rules: CopyRule[],
  wallet: string,
): CopyRule | undefined {
  return rules.find((r) => r.wallet === wallet.toLowerCase());
}
