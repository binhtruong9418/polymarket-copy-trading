import { getClobClient } from "../execution/clob-client-singleton.js";
import { sendAlert } from "./alert-notifier.js";
import logger from "../utils/logger.js";
import type { SignalEmitter } from "../signal/signal-emitter.js";

const STALE_WS_MS = 2 * 60 * 1000; // 2 minutes without WS message = stale

export class HealthChecker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private signalEmitter: SignalEmitter) {}

  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => this.check(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  isHealthy(): boolean {
    return (
      this.signalEmitter.isConnected() &&
      this.signalEmitter.getLastMessageAge() < STALE_WS_MS
    );
  }

  private async check(): Promise<void> {
    const age = this.signalEmitter.getLastMessageAge();

    if (age > STALE_WS_MS) {
      logger.warn({ ageMs: age }, "WS feed stale — triggering reconnect");
      await sendAlert("WARNING", "ws-stale", `No WS message for ${Math.round(age / 1000)}s`);
    }

    try {
      // Lightweight REST ping to verify CLOB API reachability
      await getClobClient().getBalanceAllowance();
    } catch (err) {
      logger.error({ err }, "CLOB API unreachable");
      await sendAlert("ERROR", "clob-unreachable", "CLOB API health check failed");
    }
  }
}
