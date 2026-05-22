import logger from "../utils/logger.js";

const RING_SIZE = 1000;

export class MetricsTracker {
  private latencySamples: number[] = [];
  private counters = {
    signalsReceived: 0,
    ordersSubmitted: 0,
    ordersFilled: 0,
    ordersFailed: 0,
    riskRejections: 0,
    wsReconnects: 0,
  };

  recordLatency(ms: number): void {
    if (this.latencySamples.length >= RING_SIZE) this.latencySamples.shift();
    this.latencySamples.push(ms);
  }

  increment(counter: keyof typeof this.counters): void {
    this.counters[counter]++;
  }

  getSummary(): Record<string, unknown> {
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    return {
      ...this.counters,
      latencyP50: percentile(sorted, 50),
      latencyP99: percentile(sorted, 99),
      sampleCount: sorted.length,
    };
  }

  logSummary(): void {
    logger.info(this.getSummary(), "Bot metrics summary");
  }

  startPeriodicLog(intervalMs = 5 * 60 * 1000): ReturnType<typeof setInterval> {
    return setInterval(() => this.logSummary(), intervalMs);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
