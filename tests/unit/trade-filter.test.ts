import { describe, it, expect } from "vitest";
import { parseTradeMessage } from "../../src/signal/trade-filter.js";
import type { Message } from "@polymarket/real-time-data-client";

const TARGET = "0xabc123";
const TARGET_SET = new Set([TARGET.toLowerCase()]);

function makeMsg(overrides: Record<string, unknown> = {}): Message {
  return {
    topic: "activity",
    type: "trades",
    timestamp: Date.now(),
    connection_id: "test",
    payload: {
      transactionHash: "0xhash1",
      proxyWallet: TARGET,
      conditionId: "0xcondition1",
      asset: "0xtoken1",
      side: "BUY",
      price: 0.65,
      size: 100,
      timestamp: Date.now(),
      ...overrides,
    },
  } as unknown as Message;
}

describe("parseTradeMessage", () => {
  it("returns a valid TradeSignal for a matching trade", () => {
    const signal = parseTradeMessage(makeMsg(), TARGET_SET);
    expect(signal).not.toBeNull();
    expect(signal?.sourceWallet).toBe(TARGET.toLowerCase());
    expect(signal?.side).toBe("BUY");
    expect(signal?.price).toBe(0.65);
    expect(signal?.size).toBe(100);
    expect(signal?.detectedAt).toBeGreaterThan(0);
  });

  it("returns null for non-trade topic", () => {
    const msg = makeMsg();
    (msg as unknown as Record<string, unknown>).topic = "comments";
    expect(parseTradeMessage(msg, TARGET_SET)).toBeNull();
  });

  it("returns null for non-trade type", () => {
    const msg = makeMsg();
    (msg as unknown as Record<string, unknown>).type = "orders_matched";
    expect(parseTradeMessage(msg, TARGET_SET)).toBeNull();
  });

  it("returns null if wallet is not in target set", () => {
    const signal = parseTradeMessage(makeMsg({ proxyWallet: "0xother" }), TARGET_SET);
    expect(signal).toBeNull();
  });

  it("normalizes wallet to lowercase for matching", () => {
    const signal = parseTradeMessage(makeMsg({ proxyWallet: "0xABC123" }), TARGET_SET);
    expect(signal).not.toBeNull();
  });

  it("returns null if price is out of range", () => {
    expect(parseTradeMessage(makeMsg({ price: 0 }), TARGET_SET)).toBeNull();
    expect(parseTradeMessage(makeMsg({ price: 1 }), TARGET_SET)).toBeNull();
    expect(parseTradeMessage(makeMsg({ price: 1.5 }), TARGET_SET)).toBeNull();
  });

  it("returns null if size is zero or negative", () => {
    expect(parseTradeMessage(makeMsg({ size: 0 }), TARGET_SET)).toBeNull();
    expect(parseTradeMessage(makeMsg({ size: -5 }), TARGET_SET)).toBeNull();
  });

  it("returns null if required fields are missing", () => {
    expect(parseTradeMessage(makeMsg({ transactionHash: undefined }), TARGET_SET)).toBeNull();
    expect(parseTradeMessage(makeMsg({ conditionId: undefined }), TARGET_SET)).toBeNull();
    expect(parseTradeMessage(makeMsg({ asset: undefined }), TARGET_SET)).toBeNull();
  });
});
