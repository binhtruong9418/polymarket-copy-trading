import type { Side, OrderType } from "@polymarket/clob-client";

export type { Side, OrderType };

export interface TradeSignal {
  id: string;           // transactionHash — used as dedup key
  sourceWallet: string; // proxyWallet of the copied trader
  conditionId: string;  // Polymarket CTF condition ID
  tokenId: string;      // ERC1155 outcome token (asset field from WS)
  side: "BUY" | "SELL";
  price: number;        // 0–1 probability
  size: number;         // USDC amount
  timestamp: number;    // Unix ms from trade event
  detectedAt: number;   // Unix ms when bot received signal
  // Human-readable market metadata (from WS payload)
  title?: string;       // e.g. "Bitcoin Up or Down - May 22, 12:50AM ET"
  outcome?: string;     // e.g. "Up" or "Down"
  slug?: string;        // e.g. "btc-updown-5m-1779425400"
}

export interface CopyRule {
  wallet: string;
  strategy: "exact" | "proportional";
  ratio: number;        // multiplier when proportional (e.g. 0.1)
  maxPerTrade: number;  // USDC cap per single trade
  markets?: string[];   // if set, only copy these conditionIds
}

export interface OpenPosition {
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  size: number;
  avgPrice: number;
  openedAt: number;
}

export interface PendingOrder {
  orderId: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  submittedAt: number;
  sourceTradeId: string;
}

export type EventType =
  | "ORDER_SUBMITTED"
  | "ORDER_FILLED"
  | "ORDER_FAILED"
  | "POSITION_CLOSED";

export interface LogEvent {
  type: EventType;
  payload: Record<string, unknown>;
  ts: number;
}

export interface RiskDecision {
  approved: boolean;
  adjustedSize?: number;
  reason?: string;
}
