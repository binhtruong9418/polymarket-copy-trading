import type { Message } from "@polymarket/real-time-data-client";
import type { TradeSignal } from "../types/index.js";

// Shape of trade payload from Polymarket activity/trades WS feed
interface TradePayload {
  transactionHash?: string;
  proxyWallet?: string;
  conditionId?: string;
  asset?: string;
  side?: string;
  price?: number;
  size?: number;
  timestamp?: number;
  // Human-readable market metadata included in the WS payload
  title?: string;
  outcome?: string;
  slug?: string;
}

export function parseTradeMessage(
  msg: Message,
  targetWallets: Set<string>,
): TradeSignal | null {
  if (msg.topic !== "activity" || msg.type !== "trades") return null;

  const p = msg.payload as TradePayload;

  // Validate required fields
  if (
    !p.transactionHash ||
    !p.proxyWallet ||
    !p.conditionId ||
    !p.asset ||
    !p.side ||
    p.price == null ||
    p.size == null ||
    !p.timestamp
  ) {
    return null;
  }

  // Filter by target wallet (case-insensitive)
  const wallet = p.proxyWallet.toLowerCase();
  if (!targetWallets.has(wallet)) return null;

  const side = p.side.toUpperCase();
  if (side !== "BUY" && side !== "SELL") return null;

  const price = Number(p.price);
  if (price <= 0 || price >= 1) return null;

  const size = Number(p.size);
  if (size <= 0) return null;

  return {
    id: p.transactionHash,
    sourceWallet: wallet,
    conditionId: p.conditionId,
    tokenId: p.asset,
    side: side as "BUY" | "SELL",
    price,
    size,
    // WS timestamp is Unix seconds; convert to ms for consistency with Date.now()
    timestamp: Number(p.timestamp) * 1000,
    detectedAt: Date.now(),
    title: p.title,
    outcome: p.outcome,
    slug: p.slug,
  };
}
