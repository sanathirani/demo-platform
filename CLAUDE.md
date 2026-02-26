# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NIFTY A-Day Trading Alert System - an automated alert system that sends Telegram and Email notifications when NIFTY A-Day trading setups occur. This is an **alert-only system** - no auto-trading is performed.

### Key Features
- **Confidence Scoring**: Signals require 60+ confidence score (3-5 signals/day)
- **WHY Explanations**: Every signal includes detailed reasoning
- **Post-Market Report**: Daily analysis email at 3:45 PM
- **Telegram Bot**: Interactive commands for status, levels, OI

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
curl http://localhost:3000/levels    # Get S/R levels
curl http://localhost:3000/oi        # Get OI analysis
curl -X POST http://localhost:3000/post-market-report
```

## Architecture

### Core Flow
1. **Startup** (`src/index.js`): Express server starts, strategy engine initialized, Telegram bot launched
2. **Daily Init** (9:15 AM IST): Login to broker, check if previous day was A-Day
3. **ORB Capture** (9:30 AM): Capture first 15-min candle high/low, initialize S/R levels
4. **Signal Loop** (9:31 AM - 3:29 PM): Run strategy engine every minute, aggregate signals
5. **Post-Market** (3:45 PM): Generate and send comprehensive daily report
6. **End Day** (3:30 PM): Reset state, log summary

### Module Relationships

```
index.js (orchestrator)
    ├── engine/
    │   ├── baseStrategy.js       → Abstract strategy class
    │   ├── strategyEngine.js     → Runs strategies in parallel
    │   ├── signalAggregator.js   → Combines multi-strategy signals
    │   ├── confidenceScorer.js   → 100-point scoring system
    │   └── reasonBuilder.js      → WHY section formatting
    ├── strategies/
    │   ├── orbStrategy.js           → ORB breakout (9:30-10:30 AM)
    │   ├── pullbackStrategy.js      → Pullback continuation (10:15 AM-1:30 PM)
    │   ├── expiryMomentumStrategy.js → Expiry day momentum (11 AM-2 PM)
    │   ├── vwapStrategy.js          → VWAP crossovers (10 AM-2:30 PM)
    │   ├── srStrategy.js            → S/R breakouts (9:45 AM-2:30 PM)
    │   └── dayBehaviorStrategy.js   → A-Day alignment (10:15 AM-2 PM)
    ├── analyzers/
    │   ├── oiAnalyzer.js         → OI, Max Pain, PCR
    │   ├── volumeAnalyzer.js     → Volume vs average, spikes
    │   ├── trendAnalyzer.js      → EMA, trend direction
    │   └── reversalDetector.js   → Intraday reversals
    ├── services/
    │   ├── brokerService.js      → Broker API proxy
    │   ├── telegramService.js    → Telegram bot + commands
    │   ├── alertService.js       → Telegram + Email alerts
    │   └── optionChainService.js → Strike selection
    ├── reports/
    │   └── postMarketReport.js   → End-of-day analysis
    └── filters/
        ├── adayFilter.js         → A-Day detection
        └── safetyFilter.js       → Signal validation
```

### Signal Flow (New Engine)
```
Strategy Engine runs all active strategies in parallel
    → Each strategy returns { signal, score, reasons }
    → Signal Aggregator combines aligned signals
    → Confidence Scorer calculates 0-100 score
    → If score >= 60: safetyFilter.validateSignal()
    → optionChainService.selectStrike()
    → alertService.sendAlert() (Telegram + Email with WHY section)
```

### Confidence Scoring (100 points max)
| Factor | Max Score |
|--------|-----------|
| A-Day alignment | 20 |
| VWAP confirmation | 15 |
| S/R breakout | 15 |
| OI support | 15 |
| Volume spike | 15 |
| Day behavior | 10 |
| Option Greeks | 10 |

Signals with score < 60 are logged but not sent.

### Telegram Bot Commands
| Command | Action |
|---------|--------|
| `/status` | Market status + A-Day info |
| `/levels` | Today's S/R levels |
| `/oi` | Current OI snapshot |
| `/lock` | Lock trading |
| `/unlock` | Unlock trading |
| `/force` | Toggle force analyze mode |

### Configuration
All configuration via environment variables in `.env` (see `.env.example`):
- Broker API credentials (Kite or Angel)
- Telegram bot token + chat ID (primary alerts)
- Gmail App Password for email
- Trading parameters (premium range, max loss per trade)
- Confidence threshold (MIN_CONFIDENCE_SCORE, default 60)

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
