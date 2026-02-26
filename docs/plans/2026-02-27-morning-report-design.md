# Morning Report Design

## Overview

A daily email sent at 7 AM IST (Mon-Fri) containing detailed analysis of the last 5 trading days to help prepare for the trading day ahead.

## Approach

**Live Data Fetch**: At 7 AM, fetch historical data for the last 5 trading days from the broker API, analyze each day, and generate the report.

## Data Per Day

For each of the 5 trading days:

### OHLC Data
- Open, High, Low, Close prices
- Change (points + percentage)
- Range (High - Low in points)

### Day Classification
- Day Type: A-Day (Bullish/Bearish), C-Day, Consolidation, Volatile
- Body Ratio: % of candle body vs total range
- Volume: Above/Below average

### Day Behavior
- Gap analysis: Where did it open relative to previous close? (Gap up/down/flat)
- Close position: Where did it close relative to day's range? (Upper/Middle/Lower third)
- Trend pattern: Trending/Choppy/Range-bound

### Key Levels
- PDH (Previous Day High)
- PDL (Previous Day Low)
- Pivot point
- R1 (Resistance 1)
- S1 (Support 1)

## Report Structure

```
Morning Briefing - {Date}

LAST 5 TRADING DAYS - DETAILED ANALYSIS

For each day:
┌─────────────────────────────────────────────────────────┐
│ {Date} ({Day}) - {DAY_TYPE}                             │
├─────────────────────────────────────────────────────────┤
│ Open: X  │ High: X  │ Low: X  │ Close: X                │
│ Change: X pts (X%)  │ Range: X pts                      │
│ Body Ratio: X%      │ Volume: Above/Below Avg           │
│                                                         │
│ Behavior:                                               │
│ • Gap analysis                                          │
│ • Close position analysis                               │
│ • Trend pattern                                         │
│                                                         │
│ Key Levels → PDH: X | PDL: X | Pivot: X                 │
└─────────────────────────────────────────────────────────┘

WEEKLY SUMMARY
• A-Days count (Bullish/Bearish breakdown)
• C-Days count
• Volatile Days count
• Net Change (% and pts)
• Avg Daily Range

TODAY'S SETUP
• Previous day type and direction
• System status (Active/Inactive)
• What to expect
• Key levels to watch
```

## Files to Create/Modify

1. **`src/reports/morningReport.js`** (new)
   - `generateMorningReport()` - Fetch and analyze last 5 trading days
   - `analyzeDayBehavior(candle, prevClose)` - Analyze single day behavior
   - `formatReportHTML(data)` - Format as HTML email
   - `sendMorningReport()` - Send via email

2. **`src/index.js`**
   - Add 7 AM cron job: `cron.schedule('0 7 * * 1-5', ...)`
   - Add HTTP endpoint: `POST /morning-report`

## Schedule

- **Time**: 7:00 AM IST
- **Days**: Monday to Friday
- **Delivery**: Email only (no Telegram - too verbose)
