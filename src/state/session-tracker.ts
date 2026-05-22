export class SessionTracker {
  private startBalance = 0;
  private sessionNotional = 0;
  private realizedPnl = 0;

  setStartBalance(balance: number): void {
    this.startBalance = balance;
  }

  getStartBalance(): number {
    return this.startBalance;
  }

  addNotional(size: number): void {
    this.sessionNotional += size;
  }

  getSessionNotional(): number {
    return this.sessionNotional;
  }

  recordPnl(pnl: number): void {
    this.realizedPnl += pnl;
  }

  getRealizedPnl(): number {
    return this.realizedPnl;
  }

  getDrawdownPct(currentBalance: number): number {
    if (this.startBalance <= 0) return 0;
    return ((this.startBalance - currentBalance) / this.startBalance) * 100;
  }

  getSummary(): Record<string, number> {
    return {
      startBalance: this.startBalance,
      sessionNotional: this.sessionNotional,
      realizedPnl: this.realizedPnl,
    };
  }
}
