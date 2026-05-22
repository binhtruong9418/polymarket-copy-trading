import { EventEmitter } from "events";
import type { Message } from "@polymarket/real-time-data-client";
import type { ClobClient } from "@polymarket/clob-client";
import { parseTradeMessage } from "./trade-filter.js";
import { PolymarketWsClient } from "./ws-client.js";
import type { TradeSignal } from "../types/index.js";
import logger from "../utils/logger.js";

// Emits 'trade' events with TradeSignal for every detected copy-target trade.
// Handles WS primary path and REST polling fallback transparently.
export class SignalEmitter extends EventEmitter {
  private wsClient: PolymarketWsClient;
  private targetWallets: Set<string>;
  private clobClient: ClobClient;
  // Track last seen trade IDs per wallet for dedup during REST polling
  private lastPolledTradeIds = new Map<string, Set<string>>();

  constructor(targetWallets: string[], clobClient: ClobClient) {
    super();
    this.targetWallets = new Set(targetWallets.map((w) => w.toLowerCase()));
    this.clobClient = clobClient;
    this.wsClient = new PolymarketWsClient();

    this.wsClient.on("message", (msg: Message) => {
      const signal = parseTradeMessage(msg, this.targetWallets);
      if (signal) {
        logger.debug(
          { signal, lag: signal.detectedAt - signal.timestamp },
          "Signal detected via WS",
        );
        this.emit("trade", signal);
      }
    });

    // REST polling fallback when WS is disconnected
    this.wsClient.on("poll", () => this.pollTargetWallets());

    this.wsClient.on("connected", () => this.emit("connected"));
    this.wsClient.on("disconnected", () => this.emit("disconnected"));
  }

  start(): void {
    this.wsClient.connect();
  }

  stop(): void {
    this.wsClient.disconnect();
  }

  isConnected(): boolean {
    return this.wsClient.isConnected();
  }

  getLastMessageAge(): number {
    return this.wsClient.getLastMessageAge();
  }

  private async pollTargetWallets(): Promise<void> {
    for (const wallet of this.targetWallets) {
      try {
        const trades = await this.clobClient.getTrades({
          maker_address: wallet,
        });

        const seen = this.lastPolledTradeIds.get(wallet) ?? new Set<string>();

        for (const trade of trades) {
          if (seen.has(trade.id)) continue;
          seen.add(trade.id);

          const side = trade.side.toUpperCase() as "BUY" | "SELL";
          const price = parseFloat(trade.price);
          const size = parseFloat(trade.size);

          if (price <= 0 || price >= 1 || size <= 0) continue;

          const signal: TradeSignal = {
            id: trade.id,
            sourceWallet: wallet,
            conditionId: trade.market,
            tokenId: trade.asset_id,
            side,
            price,
            size,
            timestamp: new Date(trade.match_time).getTime(),
            detectedAt: Date.now(),
          };

          logger.debug({ signal }, "Signal detected via REST poll");
          this.emit("trade", signal);
        }

        // Keep only the last 200 IDs to bound memory
        if (seen.size > 200) {
          const arr = [...seen];
          this.lastPolledTradeIds.set(wallet, new Set(arr.slice(-100)));
        } else {
          this.lastPolledTradeIds.set(wallet, seen);
        }
      } catch (err) {
        logger.warn({ wallet, err }, "REST poll failed for wallet");
      }
    }
  }
}
