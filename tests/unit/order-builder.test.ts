import { describe, it, expect } from "vitest";
import { buildCopyOrder } from "../../src/execution/order-builder.js";
import { OrderType } from "@polymarket/clob-client";
import type { TradeSignal, CopyRule } from "../../src/types/index.js";

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: "0xhash",
    sourceWallet: "0xabc",
    conditionId: "0xcond",
    tokenId: "0xtoken",
    side: "BUY",
    price: 0.65,
    size: 100,
    timestamp: Date.now(),
    detectedAt: Date.now(),
    ...overrides,
  };
}

function makeRule(overrides: Partial<CopyRule> = {}): CopyRule {
  return {
    wallet: "0xabc",
    strategy: "proportional",
    ratio: 0.1,
    maxPerTrade: 50,
    ...overrides,
  };
}

describe("buildCopyOrder", () => {
  it("proportional: size = signal.size * ratio", () => {
    const result = buildCopyOrder(makeSignal({ size: 100 }), makeRule({ ratio: 0.1 }), 1000);
    expect(result?.userOrder.size).toBe(10);
  });

  it("exact: size = signal.size", () => {
    const result = buildCopyOrder(makeSignal({ size: 30 }), makeRule({ strategy: "exact" }), 1000);
    expect(result?.userOrder.size).toBe(30);
  });

  it("caps size at maxPerTrade", () => {
    const result = buildCopyOrder(makeSignal({ size: 1000 }), makeRule({ ratio: 1.0, maxPerTrade: 50 }), 1000);
    expect(result?.userOrder.size).toBe(50);
  });

  it("caps size at 95% of available balance", () => {
    const result = buildCopyOrder(makeSignal({ size: 100 }), makeRule({ ratio: 1.0, maxPerTrade: 1000 }), 20);
    expect(result?.userOrder.size).toBe(19); // floor(20 * 0.95 * 100) / 100 = 19
  });

  it("returns null if computed size is below $1", () => {
    const result = buildCopyOrder(makeSignal({ size: 1 }), makeRule({ ratio: 0.001 }), 1000);
    expect(result).toBeNull();
  });

  it("returns null if balance is too low to cover minimum", () => {
    const result = buildCopyOrder(makeSignal({ size: 100 }), makeRule({ ratio: 1.0 }), 0.5);
    expect(result).toBeNull();
  });

  it("uses GTC order type", () => {
    const result = buildCopyOrder(makeSignal(), makeRule(), 1000);
    expect(result?.orderType).toBe(OrderType.GTC);
  });

  it("preserves signal price and tokenId", () => {
    const result = buildCopyOrder(makeSignal({ price: 0.72, tokenId: "0xtoken99" }), makeRule(), 1000);
    expect(result?.userOrder.price).toBe(0.72);
    expect(result?.userOrder.tokenID).toBe("0xtoken99");
  });
});
