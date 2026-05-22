import { initClobClient, getClobClient } from "../execution/clob-client-singleton.js";
import { SignalEmitter } from "../signal/signal-emitter.js";
import { OrderExecutor } from "../execution/order-executor.js";
import { RiskEngine } from "../risk/risk-engine.js";
import { PositionStore } from "../state/position-store.js";
import { SessionTracker } from "../state/session-tracker.js";
import { TransactionLog } from "../state/transaction-log.js";
import { recoverState, reconcileWithLive } from "../state/state-recovery.js";
import { refreshBalance, getCachedBalance } from "../risk/balance-guard.js";
import { sendAlert } from "./alert-notifier.js";
import { MetricsTracker } from "./metrics-tracker.js";
import { HealthChecker } from "./health-checker.js";
import { buildCopyRules, getRuleForWallet } from "../config/trading-config.js";
import { env } from "../config/env-config.js";
import logger from "../utils/logger.js";
import type { TradeSignal } from "../types/index.js";

export class BotOrchestrator {
  private positions = new PositionStore();
  private session = new SessionTracker();
  private log = new TransactionLog();
  private metrics = new MetricsTracker();
  private rules = buildCopyRules();

  private signalEmitter!: SignalEmitter;
  private executor!: OrderExecutor;
  private riskEngine!: RiskEngine;
  private healthChecker!: HealthChecker;
  private metricsTimer!: ReturnType<typeof setInterval>;

  async start(): Promise<void> {
    logger.info({ targetWallets: env.TARGET_WALLETS, dryRun: env.DRY_RUN }, "Bot starting");

    // 1. Init CLOB client + fetch initial balance
    await initClobClient();
    await refreshBalance();
    this.session.setStartBalance(getCachedBalance());

    // 2. Recover state from SQLite, then reconcile with live API
    recoverState(this.log, this.positions, this.session);
    await reconcileWithLive(this.positions, () =>
      getClobClient().getOpenOrders(),
    );

    // 3. Wire components
    this.riskEngine = new RiskEngine(this.positions, this.session);
    this.executor = new OrderExecutor();
    this.signalEmitter = new SignalEmitter(env.TARGET_WALLETS, getClobClient());

    // 4. Hook executor events → state + metrics
    this.executor.on("orderSubmitted", ({ signal, order, submittedAt, latencyMs }) => {
      this.metrics.increment("ordersSubmitted");
      this.metrics.recordLatency(latencyMs);
      this.log.append("ORDER_SUBMITTED", {
        orderId: submittedAt.toString(), // temp key until fill confirms
        conditionId: signal.conditionId,
        tokenId: signal.tokenId,
        side: signal.side,
        size: order.userOrder.size,
        price: order.userOrder.price,
        submittedAt,
        sourceTradeId: signal.id,
      });
      this.session.addNotional(order.userOrder.size);
    });

    this.executor.on("orderFailed", () => {
      this.metrics.increment("ordersFailed");
    });

    // 5. Trade signal handler — critical hot path
    this.signalEmitter.on("trade", (signal: TradeSignal) => {
      this.metrics.increment("signalsReceived");
      this.handleSignal(signal).catch((err) =>
        logger.error({ err }, "Unhandled error in signal handler"),
      );
    });

    this.signalEmitter.on("disconnected", () => {
      this.metrics.increment("wsReconnects");
      sendAlert("WARNING", "ws-disconnect", "WebSocket disconnected — polling fallback active");
    });

    // 6. Start health checks + metrics logging
    this.healthChecker = new HealthChecker(this.signalEmitter);
    this.healthChecker.start();
    this.metricsTimer = this.metrics.startPeriodicLog();

    // 7. Connect WebSocket
    this.signalEmitter.start();

    // 8. Graceful shutdown handlers
    process.on("SIGTERM", () => this.stop("SIGTERM"));
    process.on("SIGINT", () => this.stop("SIGINT"));

    logger.info("Bot started — listening for signals");
  }

  private async handleSignal(signal: TradeSignal): Promise<void> {
    const rule = getRuleForWallet(this.rules, signal.sourceWallet);
    if (!rule) return;

    // Market filter: skip if rule restricts to specific markets
    if (rule.markets && !rule.markets.includes(signal.conditionId)) return;

    const proposedSize =
      rule.strategy === "exact"
        ? signal.size
        : signal.size * rule.ratio;

    const decision = this.riskEngine.evaluate(signal, proposedSize);
    if (!decision.approved) {
      this.metrics.increment("riskRejections");
      logger.debug({ reason: decision.reason }, "Signal rejected by risk engine");
      return;
    }

    await this.executor.execute(signal, rule, getCachedBalance());
  }

  async stop(reason: string): Promise<void> {
    logger.info({ reason }, "Bot stopping — graceful shutdown");
    this.healthChecker?.stop();
    clearInterval(this.metricsTimer);
    this.signalEmitter?.stop();
    this.metrics.logSummary();
    this.log.close();
    await sendAlert("INFO", "bot-shutdown", `Bot stopped (${reason})`);
    process.exit(0);
  }
}
