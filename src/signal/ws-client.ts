import { RealTimeDataClient } from "@polymarket/real-time-data-client";
import type { Message } from "@polymarket/real-time-data-client";
import { EventEmitter } from "events";
import logger from "../utils/logger.js";

const POLYMARKET_WS_HOST = "wss://data-api.polymarket.com";

export class PolymarketWsClient extends EventEmitter {
  private client: RealTimeDataClient | null = null;
  private lastMessageAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  connect(): void {
    this.client = new RealTimeDataClient({
      host: POLYMARKET_WS_HOST,
      autoReconnect: true,
      pingInterval: 30_000,
      onConnect: (c) => {
        this.connected = true;
        this.lastMessageAt = Date.now();
        logger.info("WS connected to Polymarket real-time feed");
        this.stopPollingFallback();
        // Subscribe to global trade activity feed
        c.subscribe({
          subscriptions: [{ topic: "activity", type: "trades" }],
        });
        this.emit("connected");
      },
      onMessage: (_client: RealTimeDataClient, msg: Message) => {
        this.lastMessageAt = Date.now();
        this.emit("message", msg);
      },
      onStatusChange: (status) => {
        logger.debug({ status }, "WS status changed");
        if (status === "DISCONNECTED") {
          this.connected = false;
          this.emit("disconnected");
          this.startPollingFallback();
        }
      },
    });

    this.client.connect();
  }

  disconnect(): void {
    this.stopPollingFallback();
    this.client?.disconnect();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastMessageAge(): number {
    return this.lastMessageAt ? Date.now() - this.lastMessageAt : Infinity;
  }

  // Polling fallback: emits synthetic "poll" events so the signal layer
  // can fetch trades via REST when the WebSocket is down.
  private startPollingFallback(): void {
    if (this.pollTimer) return;
    logger.warn("WS down — starting REST polling fallback every 2s");
    this.pollTimer = setInterval(() => {
      if (this.connected) {
        this.stopPollingFallback();
        return;
      }
      this.emit("poll");
    }, 2_000);
  }

  private stopPollingFallback(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
