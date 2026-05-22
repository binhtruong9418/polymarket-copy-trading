import { describe, it, expect, beforeEach } from "vitest";
import { PositionStore } from "../../src/state/position-store.js";
import type { PendingOrder } from "../../src/types/index.js";

function makeOrder(overrides: Partial<PendingOrder> = {}): PendingOrder {
  return {
    orderId: "order1",
    conditionId: "cond1",
    tokenId: "token1",
    side: "BUY",
    size: 50,
    price: 0.6,
    submittedAt: Date.now(),
    sourceTradeId: "trade1",
    ...overrides,
  };
}

describe("PositionStore", () => {
  let store: PositionStore;

  beforeEach(() => {
    store = new PositionStore();
  });

  it("addPendingOrder includes order in market exposure", () => {
    store.addPendingOrder(makeOrder({ size: 50 }));
    expect(store.getMarketExposure("cond1")).toBe(50);
  });

  it("confirmFill moves order to open position", () => {
    store.addPendingOrder(makeOrder());
    const pos = store.confirmFill("order1");
    expect(pos).not.toBeNull();
    expect(pos?.size).toBe(50);
    expect(store.getAllPendingOrders()).toHaveLength(0);
    expect(store.getAllPositions()).toHaveLength(1);
  });

  it("confirmFill averages into existing position", () => {
    store.addPendingOrder(makeOrder({ orderId: "o1", size: 50, price: 0.6 }));
    store.confirmFill("o1");
    store.addPendingOrder(makeOrder({ orderId: "o2", tokenId: "token1", size: 50, price: 0.8 }));
    const pos = store.confirmFill("o2");
    expect(pos?.size).toBe(100);
    expect(pos?.avgPrice).toBeCloseTo(0.7);
  });

  it("removePendingOrder removes without creating position", () => {
    store.addPendingOrder(makeOrder());
    store.removePendingOrder("order1");
    expect(store.getAllPendingOrders()).toHaveLength(0);
    expect(store.getAllPositions()).toHaveLength(0);
  });

  it("closePosition removes and returns the position", () => {
    store.addPendingOrder(makeOrder());
    store.confirmFill("order1");
    const closed = store.closePosition("token1");
    expect(closed?.size).toBe(50);
    expect(store.getAllPositions()).toHaveLength(0);
  });

  it("getMarketExposure sums positions + pending for same conditionId", () => {
    store.addPendingOrder(makeOrder({ orderId: "o1", tokenId: "tokenA", size: 30 }));
    store.confirmFill("o1");
    store.addPendingOrder(makeOrder({ orderId: "o2", tokenId: "tokenB", size: 20 }));
    expect(store.getMarketExposure("cond1")).toBe(50);
  });

  it("getMarketExposure excludes different conditionId", () => {
    store.addPendingOrder(makeOrder({ conditionId: "cond2", size: 100 }));
    expect(store.getMarketExposure("cond1")).toBe(0);
  });
});
