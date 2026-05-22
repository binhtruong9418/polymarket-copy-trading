import type { OpenPosition, PendingOrder } from "../types/index.js";

export class PositionStore {
  private positions = new Map<string, OpenPosition>();   // tokenId → position
  private pendingOrders = new Map<string, PendingOrder>(); // orderId → order

  addPendingOrder(order: PendingOrder): void {
    this.pendingOrders.set(order.orderId, order);
  }

  confirmFill(orderId: string): OpenPosition | null {
    const order = this.pendingOrders.get(orderId);
    if (!order) return null;

    this.pendingOrders.delete(orderId);

    const existing = this.positions.get(order.tokenId);
    if (existing) {
      // Weighted average price for averaging into a position
      const totalSize = existing.size + order.size;
      const avgPrice =
        (existing.avgPrice * existing.size + order.price * order.size) /
        totalSize;
      existing.size = totalSize;
      existing.avgPrice = avgPrice;
      return existing;
    }

    const position: OpenPosition = {
      conditionId: order.conditionId,
      tokenId: order.tokenId,
      side: order.side,
      size: order.size,
      avgPrice: order.price,
      openedAt: order.submittedAt,
    };
    this.positions.set(order.tokenId, position);
    return position;
  }

  removePendingOrder(orderId: string): void {
    this.pendingOrders.delete(orderId);
  }

  closePosition(tokenId: string): OpenPosition | null {
    const pos = this.positions.get(tokenId) ?? null;
    this.positions.delete(tokenId);
    return pos;
  }

  // Total USDC notional allocated to a given market (positions + pending)
  getMarketExposure(conditionId: string): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      if (pos.conditionId === conditionId) total += pos.size;
    }
    for (const ord of this.pendingOrders.values()) {
      if (ord.conditionId === conditionId) total += ord.size;
    }
    return total;
  }

  getPosition(tokenId: string): OpenPosition | undefined {
    return this.positions.get(tokenId);
  }

  getAllPositions(): OpenPosition[] {
    return [...this.positions.values()];
  }

  getAllPendingOrders(): PendingOrder[] {
    return [...this.pendingOrders.values()];
  }
}
