import { describe, it, expect, beforeEach, vi } from "vitest";
import { RiskEngine } from "../../src/risk/risk-engine.js";
import { PositionStore } from "../../src/state/position-store.js";
import { SessionTracker } from "../../src/state/session-tracker.js";
import type { TradeSignal } from "../../src/types/index.js";

// Mock env so guards use test-friendly limits
vi.mock("../../src/config/env-config.js", () => ({
  env: {
    MAX_NOTIONAL_PER_TRADE: 100,
    MAX_MARKET_EXPOSURE: 500,
    MAX_SESSION_NOTIONAL: 1000,
    MAX_DRAWDOWN_PCT: 15,
    SLACK_WEBHOOK_URL: undefined,
  },
}));

// Mock balance guard to return a fixed cached balance
vi.mock("../../src/risk/balance-guard.js", () => ({
  checkBalance: (size: number) =>
    size > 950
      ? { approved: false, reason: "Insufficient balance" }
      : { approved: true },
  getCachedBalance: () => 1000,
}));

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: "tx1",
    sourceWallet: "0xabc",
    conditionId: "cond1",
    tokenId: "token1",
    side: "BUY",
    price: 0.5,
    size: 10,
    timestamp: Date.now(),
    detectedAt: Date.now(),
    ...overrides,
  };
}

describe("RiskEngine", () => {
  let engine: RiskEngine;
  let positions: PositionStore;
  let session: SessionTracker;

  beforeEach(() => {
    positions = new PositionStore();
    session = new SessionTracker();
    session.setStartBalance(1000);
    engine = new RiskEngine(positions, session);
  });

  it("approves a valid signal", () => {
    const result = engine.evaluate(makeSignal(), 10);
    expect(result.approved).toBe(true);
  });

  it("rejects stale signal (>10s old)", () => {
    const signal = makeSignal({ timestamp: Date.now() - 15_000 });
    const result = engine.evaluate(signal, 10);
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/stale/i);
  });

  it("rejects size below $1", () => {
    const result = engine.evaluate(makeSignal(), 0.5);
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/minimum/i);
  });

  it("rejects when session notional cap is breached", () => {
    session.addNotional(995); // already close to 1000 limit
    const result = engine.evaluate(makeSignal(), 10);
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/session notional/i);
  });

  it("rejects SELL when bot has no position for that token", () => {
    const signal = makeSignal({ side: "SELL", tokenId: "token-not-held" });
    const result = engine.evaluate(signal, 10);
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/no position/i);
  });

  it("approves SELL when bot holds the token", () => {
    // Add a pending order (simulates a held position for exposure tracking)
    positions.addPendingOrder({
      orderId: "o1", conditionId: "cond1", tokenId: "token1",
      side: "BUY", size: 10, price: 0.4, submittedAt: Date.now(), sourceTradeId: "x",
    });
    positions.confirmFill("o1"); // move to open position
    const signal = makeSignal({ side: "SELL", tokenId: "token1" });
    const result = engine.evaluate(signal, 10);
    expect(result.approved).toBe(true);
  });

  it("rejects when market exposure cap is breached", () => {
    // Fill up market exposure to 495
    for (let i = 0; i < 9; i++) {
      positions.addPendingOrder({
        orderId: `o${i}`,
        conditionId: "cond1",
        tokenId: `tok${i}`,
        side: "BUY",
        size: 55,
        price: 0.5,
        submittedAt: Date.now(),
        sourceTradeId: "x",
      });
    }
    const result = engine.evaluate(makeSignal(), 10);
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/exposure/i);
  });
});
