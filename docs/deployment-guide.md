# Deployment Guide

## Server Requirements

### Hardware
- **CPU:** 2+ cores (x86-64 or ARM64)
- **RAM:** 512 MB minimum, 2 GB recommended
- **Disk:** 10 GB (for SQLite, logs, node_modules)
- **Network:** Stable, low-latency connection (latency-critical)

### Operating System
- **Recommended:** Ubuntu 20.04 LTS or 22.04 LTS
- **Also Supported:** Debian 11+, CentOS 8+, Amazon Linux 2
- **Not Recommended:** Windows (use WSL2 if necessary)

### Software
- **Node.js:** 20.10 or higher (check with `node --version`)
- **npm:** 10+ (bundled with Node.js)
- **Git:** For cloning repository

---

## Pre-Deployment Checklist

### 1. Get Polymarket CLOB Credentials

**For live trading only** (skip if using DRY_RUN=true).

```bash
# Option A: Derive keys from existing wallet
# (Instructions: https://polymarket.com/docs/api)
# Run once, save credentials securely

# You'll get:
# - POLYMARKET_API_KEY (32-char hex)
# - POLYMARKET_SECRET (32-char hex)
# - POLYMARKET_PASSPHRASE (random string)
# - Private key (0x-prefixed 64-char hex)
```

**Security:**
- Store credentials in `.env` (never in code)
- Rotate if exposed
- Use minimal-permission wallet (not main holdings)

### 2. Fund Wallet

**For live trading only** (skip if using DRY_RUN=true).

- Send USDC to the wallet address derived from PRIVATE_KEY
- Recommended minimum: $100–$500 (depends on trading strategy)
- Polygon network (not Ethereum mainnet)

### 3. Setup Telegram Alerts (Optional)

```bash
# A. Create bot via @BotFather
# - Open Telegram, search @BotFather
# - /newbot → follow prompts
# - Copy bot token (looks like 123456:ABC-DEF)

# B. Get chat ID
# - Forward message to @userinfobot
# - Note the "id" field

# C. Set in .env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
TELEGRAM_CHAT_ID=987654321
```

### 4. Setup Slack Alerts (Optional)

```bash
# A. Create webhook
# - Go to Slack app settings
# - Incoming Webhooks → New Webhook
# - Copy webhook URL (looks like https://hooks.slack.com/...)

# B. Set in .env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

---

## Installation Steps

### Step 1: Clone Repository

```bash
cd /home/ubuntu    # or your preferred directory
git clone https://github.com/sotatek/polymarket-copy-trading.git
cd polymarket-copy-trading
```

### Step 2: Install Dependencies

```bash
npm install
# This installs all production dependencies
# (typescript, ethers, @polymarket/clob-client, better-sqlite3, etc.)
```

### Step 3: Verify Installation

```bash
npm run typecheck    # Check TypeScript compilation
npm run lint         # Verify code quality
npm test             # Run test suite (should all pass)
```

### Step 4: Create .env File

```bash
cp .env.example .env
# Now edit .env with your configuration (see Configuration section)
```

---

## Configuration

### Environment Variables

Create `.env` file in project root:

```bash
# ┌─────────────────────────────────────────────────────────┐
# │ MODE                                                    │
# └─────────────────────────────────────────────────────────┘

# DRY_RUN=true  → Monitor trades, no orders (no creds needed)
# DRY_RUN=false → Live trading, places real orders
DRY_RUN=false

# ┌─────────────────────────────────────────────────────────┐
# │ COPY TARGETS (Required)                                 │
# └─────────────────────────────────────────────────────────┘

# Comma-separated Polygon addresses to copy-trade from
# Example: 0xce25e214d5cfe4f459cf67f08df581885aae7fdc,0x1234...
TARGET_WALLETS=0xce25e214d5cfe4f459cf67f08df581885aae7fdc

# ┌─────────────────────────────────────────────────────────┐
# │ COPY SIZING                                             │
# └─────────────────────────────────────────────────────────┘

# Strategy: exact | proportional
# - exact: copy exact trade size
# - proportional: multiply by COPY_RATIO
COPY_STRATEGY=proportional

# Multiplier when using proportional strategy (0.01 to 1.0)
# Example: 0.1 = copy 10% of target trade size
COPY_RATIO=0.1

# Maximum USDC per single copied trade
# Example: 50 = never copy a trade bigger than $50 USDC
MAX_NOTIONAL_PER_TRADE=50

# Maximum USDC allocated to one market
# Example: 500 = cap at $500 per market
MAX_MARKET_EXPOSURE=500

# Maximum total USDC traded per session
# Example: 2000 = halt if session reaches $2000 traded
MAX_SESSION_NOTIONAL=2000

# Maximum session drawdown percentage before halt
# Example: 15 = halt trading if drawdown reaches 15%
MAX_DRAWDOWN_PCT=15

# ┌─────────────────────────────────────────────────────────┐
# │ NOTIFICATIONS (Optional)                                │
# └─────────────────────────────────────────────────────────┘

# Telegram alerts (if empty: disabled)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Slack alerts (if empty: disabled)
SLACK_WEBHOOK_URL=

# ┌─────────────────────────────────────────────────────────┐
# │ LIVE TRADING ONLY (DRY_RUN=false)                       │
# └─────────────────────────────────────────────────────────┘

# CLOB API credentials (get from Polymarket docs)
POLYMARKET_API_KEY=
POLYMARKET_SECRET=
POLYMARKET_PASSPHRASE=

# Polygon wallet private key (0x-prefixed, from above)
PRIVATE_KEY=

# Optional: Proxy wallet for advanced users
FUNDER_ADDRESS=

# ┌─────────────────────────────────────────────────────────┐
# │ LOGGING                                                 │
# └─────────────────────────────────────────────────────────┘

# Log level: trace | debug | info | warn | error
LOG_LEVEL=info
```

### Configuration Validation

The bot validates `.env` at startup using Zod. Invalid config will cause immediate exit with error message.

**Example Error:**
```
Invalid environment config:
  TARGET_WALLETS: Expected at least 1 item(s)
  POLYMARKET_API_KEY: Required for live trading
```

---

## Running the Bot

### Local Development

```bash
# Start bot (mode depends on DRY_RUN env var)
npm start

# You should see:
# [timestamp] INFO: Bot starting (or Mode: DRY_RUN)
# [timestamp] INFO: Connecting to RealTimeData
# [timestamp] INFO: Ready - listening for trades
```

### Kill Bot

```bash
# Press Ctrl+C to gracefully shutdown
# Bot will:
#   1. Close WebSocket connection
#   2. Flush pending events to SQLite
#   3. Log final metrics
#   4. Exit cleanly
```

---

## Process Management (PM2)

For production, use PM2 to manage the bot process (auto-restart on crash, log management).

### Install PM2 Globally

```bash
sudo npm install -g pm2
```

### Start Bot with PM2

```bash
cd /home/ubuntu/polymarket-copy-trading

# Start bot (name: polymarket-bot)
pm2 start npm --name polymarket-bot -- start

# Check status
pm2 status

# View logs
pm2 logs polymarket-bot

# Stop bot
pm2 stop polymarket-bot

# Restart bot
pm2 restart polymarket-bot

# Stop & remove
pm2 delete polymarket-bot
```

### Auto-Start on Server Reboot

```bash
# Generate startup script
pm2 startup

# Save PM2 process list
pm2 save

# Now bot auto-starts after server reboot
```

### Log Rotation (Keep Logs From Growing)

```bash
# Install log rotation module
pm2 install pm2-logrotate

# Logs now rotate daily and compress (keeps 10 backups)
```

### Monitor Resource Usage

```bash
# Real-time dashboard
pm2 monit

# Export metrics (JSON)
pm2 web    # Opens http://localhost:9615 in browser
```

---

## Docker Deployment (Optional)

### Build Docker Image

```dockerfile
# Create Dockerfile in project root
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src ./src
COPY tsconfig.json .

ENV NODE_ENV=production

CMD ["npm", "start"]
```

### Build & Run

```bash
# Build image
docker build -t polymarket-bot:latest .

# Run container with .env
docker run \
  --name polymarket-bot \
  --env-file .env \
  -v /path/to/data:/app/data \
  polymarket-bot:latest

# View logs
docker logs -f polymarket-bot

# Stop container
docker stop polymarket-bot
```

---

## Monitoring & Observability

### Check Bot Status

```bash
# Is bot running?
ps aux | grep "tsx\|npm start"

# Check process uptime
ps -eo etime,cmd | grep polymarket-bot
```

### Read Logs

```bash
# With npm start (outputs to stdout)
npm start

# With PM2
pm2 logs polymarket-bot

# Tail last 100 lines
pm2 logs polymarket-bot -n 100

# Tail with colors
pm2 logs polymarket-bot --format
```

### Log Locations

- **PM2 logs:** `~/.pm2/logs/polymarket-bot-*.log`
- **SQLite state:** `./polymarket.db` (in project root)
- **Archive logs:** `./logs/` (if configured)

### Database Inspection

```bash
# View SQLite state (if sqlite3 CLI installed)
sqlite3 polymarket.db

# List tables
.tables

# View recent events
SELECT type, ts, payload FROM events ORDER BY ts DESC LIMIT 10;

# Check drawdown halt status
SELECT * FROM drawdown_halt;

# Exit
.quit
```

### Health Checks

**Manual check:**
```bash
# Look for in logs:
# - "health check: OK" → WS + CLOB API healthy
# - "⚠️ WS data stale" → WebSocket reconnecting
# - "⚠️ CLOB API slow" → Order submission slow
```

**Automated check:**
```bash
# Health check every 60s (logged in metrics_report)
# If WS stale >2min OR CLOB API unresponsive:
# - Alert sent immediately
# - Bot continues with REST fallback
# - Check logs for recovery
```

---

## Troubleshooting

### Bot Won't Start

**Symptom:** Process exits immediately with error.

**Cause 1: Invalid .env**
```
Invalid environment config:
  TARGET_WALLETS: Expected at least 1 item(s)
```

**Fix:** Check TARGET_WALLETS is set in .env
```bash
grep TARGET_WALLETS .env
```

**Cause 2: Missing node_modules**
```bash
npm install
npm start
```

**Cause 3: CLOB credentials missing (live mode)**
```
Live trading requires these env vars:
  POLYMARKET_API_KEY
  POLYMARKET_SECRET
  ...
```

**Fix:** Either set DRY_RUN=true or provide all live creds.

### Orders Not Being Placed

**Symptom:** Trades detected but no orders appear.

**Check 1: Is DRY_RUN enabled?**
```bash
grep DRY_RUN .env
# If DRY_RUN=true: bot won't place orders (expected)
```

**Check 2: Are trades being detected?**
```bash
pm2 logs polymarket-bot | grep "signal received\|trade"
# If nothing: check TARGET_WALLETS
# If present: proceed to next check
```

**Check 3: Are risk guards blocking?**
```bash
pm2 logs polymarket-bot | grep "rejected\|guard"
# Common reasons: no SELL position, balance insufficient, exposure cap
```

**Check 4: Is CLOB API responsive?**
```bash
pm2 logs polymarket-bot | grep "ORDER_SUBMITTED"
# If none: CLOB API may be down or credentials invalid
```

### High Latency / Slow Order Submission

**Symptom:** Orders taking >2s to submit.

**Cause 1: Network latency**
- Check ping to Polymarket API servers
- Consider VPS closer to Polymarket infrastructure

**Cause 2: CLOB API overloaded**
- Check logs for "⚠️ CLOB API slow"
- Load-test during off-peak hours

**Cause 3: Risk guard evaluation slow**
- Unlikely (should be <20ms)
- Check if position store has 1000+ positions (memory issue)

**Solution:**
- Monitor metrics every 5min: `pm2 logs | grep "metrics_report"`
- Look for P99 latency trends
- If consistently >1.5s, investigate network or API issues

### SQLite Database Locked

**Symptom:** Errors like "database is locked".

**Cause:** WAL mode contention under high trade volume.

**Solution:**
```bash
# Pause bot briefly
pm2 stop polymarket-bot

# Checkpoint the WAL
sqlite3 polymarket.db "PRAGMA wal_checkpoint(RESTART);"

# Restart bot
pm2 restart polymarket-bot
```

### Telegram/Slack Alerts Not Arriving

**Symptom:** Trades happening but no notifications.

**Check 1: Are webhooks configured?**
```bash
grep TELEGRAM_BOT_TOKEN .env
grep SLACK_WEBHOOK_URL .env
# If empty: alerts disabled (expected)
```

**Check 2: Is bot sending alerts?**
```bash
pm2 logs | grep "alert sent\|sending telegram"
# If nothing: no alerts triggered yet
```

**Check 3: Are webhooks valid?**
```bash
# Test Telegram webhook manually
curl -X POST \
  -H 'Content-Type: application/json' \
  -d '{"text":"Test"}' \
  https://api.telegram.org/bot{TOKEN}/sendMessage?chat_id={CHAT_ID}
```

**Fix:** Update .env with correct token/URL, restart bot.

### Out of Memory

**Symptom:** Process crashes with "out of memory" error.

**Cause:** Position store or dedup cache unbounded growth (unlikely with production filters).

**Solution:**
```bash
# Increase Node.js heap size
node --max-old-space-size=2048 src/index.ts
# or via PM2:
pm2 start npm --name polymarket-bot --max-memory-restart 1G -- start
```

---

## Backup & Recovery

### Backup SQLite State

```bash
# Before maintenance
cp polymarket.db polymarket.db.backup

# Restore if needed
mv polymarket.db.backup polymarket.db
pm2 restart polymarket-bot
```

### Automated Daily Backups

```bash
# Create cron job (runs daily at 2am)
crontab -e

# Add line:
0 2 * * * cp /home/ubuntu/polymarket-copy-trading/polymarket.db /home/ubuntu/backups/polymarket.db.$(date +\%Y\%m\%d)

# Verify cron job
crontab -l
```

### Recover from Backup

```bash
# Stop bot
pm2 stop polymarket-bot

# Restore backup
cp /home/ubuntu/backups/polymarket.db.20250522 /home/ubuntu/polymarket-copy-trading/polymarket.db

# Restart bot (will reconcile with live CLOB state)
pm2 restart polymarket-bot
```

---

## Security Hardening

### 1. Protect .env File

```bash
# Only owner can read
chmod 600 .env

# Prevent accidental commits
echo ".env" >> .gitignore
git rm --cached .env
git commit -m "Remove .env from tracking"
```

### 2. SSH Key Pair (For Server Access)

```bash
# Generate key pair
ssh-keygen -t ed25519 -C "polymarket-bot"

# Copy public key to server
ssh-copy-id -i ~/.ssh/polymarket-bot.pub ubuntu@your-server.com

# SSH without password
ssh -i ~/.ssh/polymarket-bot ubuntu@your-server.com
```

### 3. Firewall Configuration

```bash
# Allow only necessary ports
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 443/tcp     # Outbound HTTPS (bots need this)
sudo ufw enable
```

### 4. Monitor for Unauthorized Changes

```bash
# List files (check for unexpected changes)
ls -la /home/ubuntu/polymarket-copy-trading/

# Monitor logs for errors
pm2 logs | grep -i error

# Alert on failed orders (could indicate compromised wallet)
pm2 logs | grep ORDER_FAILED
```

### 5. Private Key Rotation (Quarterly)

```bash
# Generate new key via Polymarket docs
# Update PRIVATE_KEY in .env
# Restart bot
pm2 restart polymarket-bot
```

---

## Performance Tuning

### SQLite WAL Checkpoint

```bash
# Checkpoint every hour (auto-cleans WAL file)
crontab -e
# Add:
0 * * * * cd /home/ubuntu/polymarket-copy-trading && sqlite3 polymarket.db "PRAGMA wal_checkpoint(PASSIVE);"
```

### Node.js Heap Management

```bash
# Monitor memory usage
pm2 monit

# If consistently >80% of available RAM:
# - Increase heap: --max-old-space-size=2048
# - Or reduce dedup cache size (code change)
```

### Connection Pooling

By default, single ethers.js provider (no pooling). For high-frequency bots, consider:
- Multiple provider instances (load balance)
- Provider fallbacks (Infura, Alchemy, Polymarket RPC)
- (Not implemented in v1.0; consider for future)

---

## Maintenance Schedule

| Task | Frequency | Command |
|------|-----------|---------|
| Review logs for errors | Daily | `pm2 logs \| grep -i error` |
| Check bot uptime | Weekly | `pm2 status` |
| Backup SQLite | Daily | `cp polymarket.db backup/` |
| Rotate logs (PM2) | Automatic | (logrotate configured) |
| Update dependencies | Monthly | `npm outdated` |
| Security audit | Quarterly | (code + secrets review) |
| Private key rotation | Quarterly | (update PRIVATE_KEY in .env) |

---

## Support & Escalation

### Issue Levels

| Level | Example | Response Time | Action |
|-------|---------|----------------|--------|
| Critical | Bot crashed, orders lost | Immediate | RESTART, investigate |
| High | Drawdown halt triggered | 1 hour | Manual review |
| Medium | WS reconnecting | 4 hours | Monitor logs |
| Low | Metric snapshot logged | 24 hours | Analyze trends |

### Contact & Documentation

- **Logs:** `pm2 logs polymarket-bot`
- **Code:** GitHub repository (see README)
- **Issues:** File GitHub issue with redacted logs + env config
- **Security:** Report privately to maintainer

---

## Checklist: Pre-Production Deployment

- [ ] Node.js 20.10+ installed and verified
- [ ] npm install completed successfully
- [ ] npm test passes (>70% coverage)
- [ ] .env file created with all required vars
- [ ] TARGET_WALLETS validated (correct Polygon addresses)
- [ ] Wallet funded (USDC on Polygon)
- [ ] CLOB credentials tested (API key valid)
- [ ] Telegram/Slack webhooks tested (optional)
- [ ] Dry-run mode tested for 1+ hour (DRY_RUN=true)
- [ ] Live mode tested with small amounts ($10–$50)
- [ ] PM2 setup configured
- [ ] Backup strategy in place
- [ ] Monitoring alerts configured
- [ ] SSH key secured
- [ ] .env file permissions set (chmod 600)
- [ ] Logs monitored for errors

---

## Rollback Plan

If deployment fails:

```bash
# Stop bot
pm2 stop polymarket-bot

# Restore previous version
git checkout <previous-commit-hash>
npm install
npm test

# Restore SQLite backup
cp backups/polymarket.db.backup polymarket.db

# Restart bot
pm2 restart polymarket-bot

# Verify logs
pm2 logs polymarket-bot
```

---

## Questions?

See `README.md` for quick start or `docs/` directory for detailed docs.
