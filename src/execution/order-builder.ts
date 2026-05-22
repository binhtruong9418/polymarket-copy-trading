import { Side, OrderType } from "@polymarket/clob-client";
import type { UserOrder } from "@polymarket/clob-client";
import type { TradeSignal, CopyRule } from "../types/index.js";

const MIN_ORDER_SIZE_USDC = 1;

export interface BuiltOrder {
  userOrder: UserOrder;
  // GTC limit order at the target's price — fills if liquidity exists at that level
  orderType: OrderType.GTC;
}

export function buildCopyOrder(
  signal: TradeSignal,
  rule: CopyRule,
  availableBalance: number,
): BuiltOrder | null {
  const copySize = computeCopySize(signal.size, rule, availableBalance);
  if (copySize < MIN_ORDER_SIZE_USDC) return null;

  const userOrder: UserOrder = {
    tokenID: signal.tokenId,
    price: signal.price,
    size: copySize,
    side: signal.side === "BUY" ? Side.BUY : Side.SELL,
  };

  // GTC limit order at the exact copied price
  return { userOrder, orderType: OrderType.GTC };
}

function computeCopySize(
  signalSize: number,
  rule: CopyRule,
  balance: number,
): number {
  const base =
    rule.strategy === "exact" ? signalSize : signalSize * rule.ratio;
  const maxAllowed = Math.min(rule.maxPerTrade, balance * 0.95);
  const capped = Math.min(base, maxAllowed);
  // Round to 2 decimal places (USDC cents)
  return Math.floor(capped * 100) / 100;
}
