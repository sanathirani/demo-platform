# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NIFTY A-Day Trading Alert System - an automated alert system that sends WhatsApp, Email, and SMS notifications when NIFTY A-Day trading setups occur. This is an **alert-only system** - no auto-trading is performed.

### A-Day Concept
An A-Day (Accumulation Day) is a trending day with strong conviction. The system detects when the previous day was an A-Day and monitors for follow-through setups on the current day.

**A-Day Criteria (all must be true):**
- Body ratio > 60% (candle body / total range)
- Volume > 20-day average
- Range > 100 points

## Commands

```bash
# Start production server
npm start

# Development with auto-reload
npm run dev

# Test endpoints manually
curl http://localhost:3000/health
curl http://localhost:3000/state
curl -X POST http://localhost:3000/test-alert
```

## Architecture

### Core Flow
1. **Startup** (`src/index.js`): Express server starts, cron jobs scheduled for IST market hours
2. **Daily Init** (9:15 AM IST): Login to Kite API, check if previous day was A-Day
3. **ORB Capture** (9:30 AM): Capture first 15-min candle high/low for breakout detection
4. **Signal Loop** (9:31 AM - 3:29 PM): Check all strategies every minute
5. **End Day** (3:30 PM): Reset state, log summary

### Module Relationships

```
index.js (orchestrator)
    ├── services/
    │   ├── kiteService.js    → Zerodha Kite Connect API wrapper
    │   ├── alertService.js   → Twilio (WhatsApp/SMS) + Nodemailer (Email)
    │   └── optionChainService.js → Strike selection (premium Rs 80-150)
    ├── filters/
    │   ├── adayFilter.js     → A-Day detection logic (caches per day)
    │   └── safetyFilter.js   → Prevents duplicates, tracks losses, time validation
    └── strategies/
        ├── orbStrategy.js           → ORB breakout (9:30-10:30 AM)
        ├── pullbackStrategy.js      → Pullback continuation (10:15 AM-1:30 PM)
        └── expiryMomentumStrategy.js → Expiry day momentum (11 AM-2 PM, Thursdays)
```

### Signal Flow
```
Strategy generates signal → safetyFilter.validateSignal() → optionChainService.selectStrike() → alertService.sendAlert()
```

### State Management
- **Application state**: Global variables in `index.js` (`isRunning`, `todayIsADay`, `adayDirection`)
- **A-Day cache**: `adayFilter.js` caches status per day to avoid repeated API calls
- **ORB state**: `orbStrategy.js` maintains daily ORB range
- **Safety state**: `safetyFilter.js` tracks signals sent, losses, lock status

### Configuration
All configuration via environment variables in `.env` (see `.env.example`):
- Kite API credentials (requires daily login - access token expires each day)
- Twilio credentials for WhatsApp/SMS
- Gmail App Password for email
- Trading parameters (premium range, max loss per trade)

### Time Handling
All times are IST (Asia/Kolkata). The `timeUtils.js` module handles:
- Trading day detection (Mon-Fri, excludes market holidays)
- Time window validation for strategies
- Weekly expiry calculation (Thursdays)

### Logging
Winston logger writes to `logs/` directory:
- `combined.log` - all logs
- `error.log` - errors only
- `signals.log` - trading signals
