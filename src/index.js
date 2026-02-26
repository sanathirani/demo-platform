/**
 * NIFTY A-Day Trading Alert System
 *
 * Main entry point - orchestrates all services, strategies, and scheduling
 * Enhanced with new strategy engine, confidence scoring, and Telegram integration
 */

const express = require('express');
const cron = require('node-cron');

const { config, validateConfig } = require('./config/config');
const { logger } = require('./utils/logger');
const { isTradingDay, isMarketOpen, formatTimeForAlert, getISTNow, formatDateForKite } = require('./utils/timeUtils');

// Services
const brokerService = require('./services/brokerService');
const alertService = require('./services/alertService');
const optionChainService = require('./services/optionChainService');
const telegramService = require('./services/telegramService');

// Strategy Engine
const strategyEngine = require('./engine/strategyEngine');
const { aggregateSignals, validateAggregatedSignal } = require('./engine/signalAggregator');
const { calculateConfidence } = require('./engine/confidenceScorer');

// Analyzers
const volumeAnalyzer = require('./analyzers/volumeAnalyzer');
const trendAnalyzer = require('./analyzers/trendAnalyzer');
const oiAnalyzer = require('./analyzers/oiAnalyzer');
const reversalDetector = require('./analyzers/reversalDetector');

// Strategies (new engine-based)
const orbStrategy = require('./strategies/orbStrategy');
const pullbackStrategy = require('./strategies/pullbackStrategy');
const expiryMomentumStrategy = require('./strategies/expiryMomentumStrategy');
const vwapStrategy = require('./strategies/vwapStrategy');
const srStrategy = require('./strategies/srStrategy');
const dayBehaviorStrategy = require('./strategies/dayBehaviorStrategy');

// Filters
const adayFilter = require('./filters/adayFilter');
const safetyFilter = require('./filters/safetyFilter');

// Reports
const postMarketReport = require('./reports/postMarketReport');
const morningReport = require('./reports/morningReport');

// Simulation
const simulationService = require('./services/simulationService');

// Application state
let isRunning = false;
let todayIsADay = false;
let adayDirection = null;
let adayStatus = null;
let forceAnalyzeMode = false; // When true, run strategies even on C-Days

// Express app
const app = express();
app.use(express.json());

// ============================================
// Strategy Engine Setup
// ============================================

function initializeStrategyEngine() {
  // Register all strategies (use _instance for migrated strategies with wrapper exports)
  strategyEngine.registerStrategy('ORB', orbStrategy._instance);
  strategyEngine.registerStrategy('PULLBACK', pullbackStrategy._instance);
  strategyEngine.registerStrategy('EXPIRY', expiryMomentumStrategy._instance);
  strategyEngine.registerStrategy('VWAP', vwapStrategy);
  strategyEngine.registerStrategy('SR', srStrategy);
  strategyEngine.registerStrategy('DAY_BEHAVIOR', dayBehaviorStrategy);

  // Register analyzers
  strategyEngine.registerAnalyzer('volume', volumeAnalyzer);
  strategyEngine.registerAnalyzer('trend', trendAnalyzer);
  strategyEngine.registerAnalyzer('oi', oiAnalyzer);
  strategyEngine.registerAnalyzer('reversal', reversalDetector);

  logger.info('Strategy engine initialized with all strategies and analyzers');
}

// ============================================
// Telegram Bot Setup
// ============================================

async function initializeTelegram() {
  const handlers = {
    getStatus: () => ({
      isRunning,
      isMarketOpen: isMarketOpen(),
      isTradingDay: isTradingDay(),
      todayIsADay,
      adayDirection,
      forceAnalyzeMode,
      safetyState: safetyFilter.getDailySummary(),
    }),
    getLevels: () => srStrategy.getLevels(),
    getOI: () => oiAnalyzer.analyze(),
    lockTrading: () => safetyFilter.lockTrading(),
    unlockTrading: () => safetyFilter.unlockTrading(),
    toggleForceAnalyze: () => {
      forceAnalyzeMode = !forceAnalyzeMode;
      logger.info(`Force analyze mode ${forceAnalyzeMode ? 'ENABLED' : 'DISABLED'}`);
      return forceAnalyzeMode;
    },
  };

  await telegramService.initialize(handlers);
}

// ============================================
// HTTP Endpoints
// ============================================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    isRunning,
    isMarketOpen: isMarketOpen(),
    isTradingDay: isTradingDay(),
    todayIsADay,
    adayDirection,
    forceAnalyzeMode,
    safetyState: safetyFilter.getDailySummary(),
    engineStatus: strategyEngine.getStatus(),
  });
});

/**
 * Get current system state
 */
app.get('/state', (req, res) => {
  res.json({
    isRunning,
    todayIsADay,
    adayDirection,
    forceAnalyzeMode,
    orb: orbStrategy.getState(),
    pullback: pullbackStrategy.getState(),
    expiry: expiryMomentumStrategy.getState(),
    vwap: vwapStrategy.getState(),
    sr: srStrategy.getState(),
    dayBehavior: dayBehaviorStrategy.getState(),
    safety: safetyFilter.getState(),
    engineStatus: strategyEngine.getStatus(),
  });
});

/**
 * Manual test alert endpoint
 */
app.post('/test-alert', async (req, res) => {
  try {
    logger.info('Manual test alert triggered');
    const result = await alertService.sendTestAlert();
    res.json({
      success: true,
      message: 'Test alert sent',
      result,
    });
  } catch (error) {
    logger.error('Test alert failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Manual A-Day check endpoint
 */
app.get('/aday-check', async (req, res) => {
  try {
    if (!brokerService.isAuthenticated()) {
      await brokerService.login();
    }
    const result = await adayFilter.checkADay();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Manual signal check endpoint (using new engine)
 */
app.post('/check-signals', async (req, res) => {
  try {
    const signal = await runStrategyEngine();
    res.json({ signal });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Lock/unlock trading
 */
app.post('/lock', (req, res) => {
  safetyFilter.lockTrading();
  res.json({ message: 'Trading locked', state: safetyFilter.getDailySummary() });
});

app.post('/unlock', (req, res) => {
  safetyFilter.unlockTrading();
  res.json({ message: 'Trading unlocked', state: safetyFilter.getDailySummary() });
});

/**
 * Force Analyze Mode endpoints
 */
app.get('/force-analyze', (req, res) => {
  res.json({
    forceAnalyzeMode,
    todayIsADay,
    message: forceAnalyzeMode
      ? 'Force analyze is ON - signals will be sent even on C-Days'
      : 'Force analyze is OFF - signals only sent on A-Days',
  });
});

app.post('/force-analyze/on', (req, res) => {
  forceAnalyzeMode = true;
  logger.info('Force analyze mode ENABLED - will send signals even on C-Days');
  res.json({
    message: 'Force analyze mode enabled',
    forceAnalyzeMode: true,
    warning: 'Signals will now be sent even when previous day was C-Day',
  });
});

app.post('/force-analyze/off', (req, res) => {
  forceAnalyzeMode = false;
  logger.info('Force analyze mode DISABLED - normal A-Day gating restored');
  res.json({
    message: 'Force analyze mode disabled',
    forceAnalyzeMode: false,
  });
});

/**
 * Manual market update endpoint
 */
app.post('/market-update', async (req, res) => {
  try {
    if (!brokerService.isAuthenticated()) {
      await brokerService.login();
    }
    await sendMarketUpdate();
    res.json({
      success: true,
      message: 'Market update email sent',
    });
  } catch (error) {
    logger.error('Manual market update failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Manual post-market report endpoint
 */
app.post('/post-market-report', async (req, res) => {
  try {
    if (!brokerService.isAuthenticated()) {
      await brokerService.login();
    }
    const report = await postMarketReport.sendReport(adayStatus);
    res.json({
      success: true,
      message: 'Post-market report sent',
      report,
    });
  } catch (error) {
    logger.error('Post-market report failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Manual morning report endpoint
 */
app.post('/morning-report', async (req, res) => {
  try {
    if (!brokerService.isAuthenticated()) {
      await brokerService.login();
    }
    const report = await morningReport.sendMorningReport();
    res.json({
      success: true,
      message: 'Morning report sent',
      report,
    });
  } catch (error) {
    logger.error('Morning report failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get S/R levels endpoint
 */
app.get('/levels', async (req, res) => {
  try {
    if (!brokerService.isAuthenticated()) {
      await brokerService.login();
    }
    const levels = await srStrategy.initializeLevels();
    res.json(levels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get OI analysis endpoint
 */
app.get('/oi', async (req, res) => {
  try {
    if (!brokerService.isAuthenticated()) {
      await brokerService.login();
    }
    const oi = await oiAnalyzer.analyze();
    res.json(oi);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Verify day with real data endpoint
 */
app.get('/verify-day', async (req, res) => {
  try {
    if (!brokerService.isAuthenticated()) {
      await brokerService.login();
    }

    let targetDate = null;
    if (req.query.date) {
      targetDate = new Date(req.query.date + 'T00:00:00+05:30');
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Use YYYY-MM-DD',
        });
      }
    }

    const forceAnalyze = req.query.forceAnalyze === 'true';
    const simResult = await simulationService.simulateDay(targetDate, forceAnalyze);
    const htmlReport = simulationService.generateVerificationReport(simResult);
    const textReport = simulationService.generateVerificationText(simResult);

    const emailSubject = `Verification Report: ${simResult.simulationDate} - ${simResult.adayCheck.isADay ? 'A-DAY' : 'C-DAY'} (${simResult.summary.totalSignals} signals)`;
    await alertService.sendEmail(emailSubject, htmlReport);

    if (req.query.telegram === 'true' && telegramService.isReady()) {
      await telegramService.sendMessage(textReport);
    }

    logger.info('Verification report sent', {
      date: simResult.simulationDate,
      signals: simResult.summary.totalSignals,
    });

    res.json({
      success: true,
      message: 'Verification report sent via email',
      ...simResult,
    });
  } catch (error) {
    logger.error('Day verification failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Simulate day endpoint
 */
app.get('/simulate-day', async (req, res) => {
  try {
    if (!brokerService.isAuthenticated()) {
      await brokerService.login();
    }

    let targetDate = null;
    if (req.query.date) {
      targetDate = new Date(req.query.date + 'T00:00:00+05:30');
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Use YYYY-MM-DD',
        });
      }
    }

    const forceAnalyze = req.query.forceAnalyze === 'true';
    const result = await simulationService.simulateDay(targetDate, forceAnalyze);
    res.json(result);
  } catch (error) {
    logger.error('Day simulation failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// Core Functions
// ============================================

/**
 * Start of day initialization (9:15 AM)
 */
async function startDay() {
  logger.info('========== STARTING DAY ==========');

  if (!isTradingDay()) {
    logger.info('Not a trading day, skipping');
    return;
  }

  try {
    // Reset all state
    safetyFilter.resetDailyState();
    strategyEngine.resetAll();
    postMarketReport.reset();
    volumeAnalyzer.clearCache();
    oiAnalyzer.clearCache();
    reversalDetector.clearDailyData();

    // Login to broker
    await brokerService.login();
    logger.info('Broker login successful');

    // Check if today follows an A-Day
    const adayResult = await adayFilter.checkADay();
    todayIsADay = adayResult.isADay;
    adayDirection = adayResult.direction;
    adayStatus = adayResult;

    logger.info('A-Day check completed', {
      isADay: todayIsADay,
      direction: adayDirection,
      reason: adayResult.reason,
    });

    // Send notification
    if (todayIsADay) {
      const message = `*A-DAY DETECTED*

Previous day was an A-Day (${adayDirection})

${adayResult.reason}

System is active and monitoring for setups.

Time: ${formatTimeForAlert(new Date())}`;

      try {
        if (telegramService.isReady()) {
          await telegramService.sendMessage(message);
        }
        await alertService.sendEmail(`A-DAY DETECTED: ${adayDirection}`, `<h1>A-Day Detected</h1><p>${adayResult.reason}</p>`);
      } catch (e) {
        logger.warn('Failed to send A-Day notification', { error: e.message });
      }
    }

    isRunning = true;
    logger.info('Day started successfully', { isADay: todayIsADay });

  } catch (error) {
    logger.error('Failed to start day', { error: error.message });
  }
}

/**
 * Capture ORB range (9:30 AM)
 */
async function captureORB() {
  if (!isRunning) {
    return;
  }

  try {
    const orbRange = await orbStrategy.captureORBRange();
    logger.info('ORB range captured', orbRange);

    // Also initialize S/R levels
    await srStrategy.initializeLevels();
    logger.info('S/R levels initialized');

  } catch (error) {
    logger.error('Failed to capture ORB', { error: error.message });
  }
}

/**
 * Run the strategy engine and aggregate signals
 * @returns {Promise<Object|null>} Aggregated signal or null
 */
async function runStrategyEngine() {
  if (!isRunning) {
    return null;
  }

  // Skip if not A-Day and force analyze is off
  if (!todayIsADay && !forceAnalyzeMode) {
    logger.debug('C-Day and force analyze off - skipping strategy engine');
    return null;
  }

  try {
    // Build context
    const context = {
      adayStatus: {
        isADay: todayIsADay,
        direction: adayDirection,
        data: adayStatus?.data,
      },
    };

    // Run all active strategies through the engine
    const strategyResults = await strategyEngine.runStrategies(context);

    if (strategyResults.length === 0) {
      return null;
    }

    // Run analyzers for additional context
    const [oiAnalysis, volumeAnalysis] = await Promise.all([
      oiAnalyzer.analyze().catch(() => ({})),
      volumeAnalyzer.analyze().catch(() => ({})),
    ]);

    // Aggregate signals
    const aggregatedSignal = aggregateSignals({
      strategyResults,
      adayStatus: context.adayStatus,
      oiAnalysis,
      volumeAnalysis,
    });

    return aggregatedSignal;
  } catch (error) {
    logger.error('Strategy engine failed', { error: error.message });
    return null;
  }
}

/**
 * Process and send aggregated signal
 * @param {Object} signal - Aggregated signal
 */
async function processAggregatedSignal(signal) {
  if (!signal) return;

  // Validate with safety filter
  const validation = safetyFilter.validateSignal({
    direction: signal.direction,
    strategy: signal.primaryStrategy,
  });

  if (!validation.isValid) {
    logger.info('Signal filtered by safety check', { reason: validation.reason });
    return;
  }

  try {
    // Select strike for the signal
    const strikeData = await optionChainService.selectStrike(signal.direction);

    // Enhance signal with strike data
    const enrichedSignal = {
      ...signal,
      strike: `${strikeData.strike} ${signal.direction === 'BUY_CE' ? 'CE' : 'PE'}`,
      premium: strikeData.premium,
      spotPrice: strikeData.spotPrice,
      stopLoss: signal.strategyData?.[0]?.data?.stopLoss || strikeData.spotPrice * (signal.direction === 'BUY_CE' ? 0.99 : 1.01),
      isCDaySignal: !todayIsADay,
      time: new Date(),
    };

    // Send alert
    await alertService.sendAlert(enrichedSignal);

    // Mark signal as sent
    safetyFilter.markSignalSent(signal.direction);

    // Track for post-market report
    postMarketReport.addSignal(enrichedSignal);

    logger.info('Signal processed and alert sent', {
      strategy: signal.primaryStrategy,
      direction: signal.direction,
      confidence: signal.confidenceScore,
      strike: enrichedSignal.strike,
    });

  } catch (error) {
    logger.error('Failed to process signal', {
      strategy: signal.primaryStrategy,
      error: error.message,
    });
  }
}

/**
 * Main signal check loop (every minute)
 */
async function checkSignals() {
  if (!isRunning || !isMarketOpen()) {
    return;
  }

  try {
    const signal = await runStrategyEngine();

    if (signal) {
      logger.info('Signal generated', {
        direction: signal.direction,
        confidence: signal.confidenceScore,
        strategies: signal.contributingStrategies,
      });
      await processAggregatedSignal(signal);
    }
  } catch (error) {
    logger.error('Signal check failed', { error: error.message });
  }
}

/**
 * Generate 15-minute market update email
 */
async function sendMarketUpdate() {
  if (!isMarketOpen()) {
    logger.info('Market update skipped - market is closed');
    return;
  }

  try {
    const instrumentToken = await brokerService.getNiftyInstrumentToken();
    const now = getISTNow();
    const todayStr = formatDateForKite(now);

    // Fetch current candle data
    const [candles15min, candles5min] = await Promise.all([
      brokerService.getHistoricalData(instrumentToken, '15minute', todayStr, todayStr),
      brokerService.getHistoricalData(instrumentToken, '5minute', todayStr, todayStr),
    ]);

    if (!candles15min || candles15min.length === 0) {
      logger.warn('No candle data for market update');
      return;
    }

    // Current price info
    const latestCandle = candles15min[candles15min.length - 1];
    const spotPrice = latestCandle.close;
    const dayOpen = candles15min[0].open;
    const dayHigh = Math.max(...candles15min.map(c => c.high));
    const dayLow = Math.min(...candles15min.map(c => c.low));
    const dayChange = spotPrice - dayOpen;
    const dayChangePercent = ((dayChange / dayOpen) * 100).toFixed(2);

    // ORB data
    const orbData = orbStrategy.getORBRange();

    // Get trend analysis
    const trendData = await trendAnalyzer.analyze();

    // Generate suggestions
    const suggestions = [];

    if (orbData && orbData.high && orbData.low) {
      if (spotPrice > orbData.high) {
        suggestions.push(`Price above ORB High (${orbData.high}) - Bullish bias`);
      } else if (spotPrice < orbData.low) {
        suggestions.push(`Price below ORB Low (${orbData.low}) - Bearish bias`);
      } else {
        suggestions.push(`Price within ORB range (${orbData.low} - ${orbData.high}) - Wait for breakout`);
      }
    }

    if (trendData.direction === 'BULLISH') {
      suggestions.push(`${trendData.strength} bullish trend - Look for CE opportunities on dips`);
    } else if (trendData.direction === 'BEARISH') {
      suggestions.push(`${trendData.strength} bearish trend - Look for PE opportunities on pullbacks`);
    } else {
      suggestions.push(`Sideways/choppy - Avoid trading or use tight stops`);
    }

    if (todayIsADay) {
      suggestions.push(`A-Day Follow-through (${adayDirection}) - Higher probability setups`);
    } else if (forceAnalyzeMode) {
      suggestions.push(`C-Day with Force Analyze ON - Trade with extra caution`);
    } else {
      suggestions.push(`C-Day - System normally inactive`);
    }

    const safetyState = safetyFilter.getDailySummary();
    if (safetyState.signalsSent.BUY_CE || safetyState.signalsSent.BUY_PE) {
      suggestions.push(`Signals sent today: CE=${safetyState.signalsSent.BUY_CE}, PE=${safetyState.signalsSent.BUY_PE}`);
    }

    const updateTime = formatTimeForAlert(now);

    // Build HTML email
    const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto; background: #f5f5f5; }
    .header { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: white; padding: 20px; }
    .price-box { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 15px 0; text-align: center; }
    .price { font-size: 36px; font-weight: bold; color: #333; }
    .change { font-size: 18px; color: ${dayChange >= 0 ? '#28a745' : '#dc3545'}; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin: 15px 0; }
    .stat-box { background: #f8f9fa; padding: 15px; border-radius: 8px; text-align: center; }
    .stat-label { font-size: 12px; color: #666; text-transform: uppercase; }
    .stat-value { font-size: 20px; font-weight: bold; color: #333; margin-top: 5px; }
    .trend-box { padding: 15px; border-radius: 8px; margin: 15px 0; background: ${trendData.direction?.includes('BULLISH') ? '#d4edda' : trendData.direction?.includes('BEARISH') ? '#f8d7da' : '#e2e3e5'}; }
    .suggestions { background: #e7f3ff; border-left: 4px solid #1a73e8; padding: 15px; margin: 15px 0; }
    .suggestion-item { padding: 8px 0; border-bottom: 1px solid #cce5ff; }
    .suggestion-item:last-child { border-bottom: none; }
    .footer { text-align: center; padding: 15px; color: #999; font-size: 12px; }
    .aday-status { background: ${todayIsADay ? '#d4edda' : '#fff3cd'}; padding: 10px 15px; border-radius: 20px; display: inline-block; margin: 10px 0; }
  </style>
</head>
<body>
  <div class="header">
    <h2 style="margin: 0;">NIFTY Market Update</h2>
    <p style="margin: 10px 0 0 0; opacity: 0.9;">${updateTime}</p>
  </div>

  <div class="content">
    <div style="text-align: center;">
      <div class="aday-status">
        ${todayIsADay ? `A-Day (${adayDirection})` : forceAnalyzeMode ? 'C-Day (Force Analyze ON)' : 'C-Day'}
      </div>
    </div>

    <div class="price-box">
      <div class="price">${spotPrice.toFixed(2)}</div>
      <div class="change">${dayChange >= 0 ? '▲' : '▼'} ${Math.abs(dayChange).toFixed(2)} (${dayChangePercent}%)</div>
    </div>

    <div class="grid">
      <div class="stat-box">
        <div class="stat-label">Day High</div>
        <div class="stat-value">${dayHigh.toFixed(2)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Day Low</div>
        <div class="stat-value">${dayLow.toFixed(2)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Day Range</div>
        <div class="stat-value">${(dayHigh - dayLow).toFixed(0)} pts</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Day Open</div>
        <div class="stat-value">${dayOpen.toFixed(2)}</div>
      </div>
    </div>

    ${orbData && orbData.high ? `
    <div class="grid">
      <div class="stat-box" style="border-left: 3px solid #28a745;">
        <div class="stat-label">ORB High</div>
        <div class="stat-value">${orbData.high}</div>
      </div>
      <div class="stat-box" style="border-left: 3px solid #dc3545;">
        <div class="stat-label">ORB Low</div>
        <div class="stat-value">${orbData.low}</div>
      </div>
    </div>
    ` : ''}

    <div class="trend-box">
      <strong>Trend:</strong> ${trendData.direction || 'NEUTRAL'} (${trendData.strength || 'Unknown'})
    </div>

    <div class="suggestions">
      <strong>Suggestions:</strong>
      ${suggestions.map(s => `<div class="suggestion-item">${s}</div>`).join('')}
    </div>
  </div>

  <div class="footer">
    A-Day Trading Alert System • Auto-generated every 15 minutes
  </div>
</body>
</html>`;

    const subject = `NIFTY ${spotPrice.toFixed(0)} | ${dayChange >= 0 ? '▲' : '▼'}${Math.abs(dayChange).toFixed(0)} | ${trendData.direction || 'NEUTRAL'} | ${updateTime}`;

    await alertService.sendEmail(subject, htmlBody);
    logger.info('Market update email sent', { spotPrice, trend: trendData.direction, time: updateTime });

  } catch (error) {
    logger.error('Failed to send market update', { error: error.message });
  }
}

/**
 * Send post-market report (3:45 PM)
 */
async function sendPostMarketReportWrapper() {
  try {
    await postMarketReport.sendReport(adayStatus);
    logger.info('Post-market report sent');
  } catch (error) {
    logger.error('Failed to send post-market report', { error: error.message });
  }
}

/**
 * End of day cleanup (3:30 PM)
 */
function endDay() {
  logger.info('========== ENDING DAY ==========');

  const summary = safetyFilter.getDailySummary();
  logger.info('Daily summary', summary);

  isRunning = false;
  todayIsADay = false;
  adayDirection = null;
  adayStatus = null;

  logger.info('Day ended, system idle until tomorrow');
}

// ============================================
// Cron Scheduling
// ============================================

// 9:15 AM - Start day (login, A-Day check)
cron.schedule('15 9 * * 1-5', () => {
  logger.info('Cron: 9:15 AM - Starting day');
  startDay();
}, {
  timezone: 'Asia/Kolkata',
});

// 9:30 AM - Capture ORB range
cron.schedule('30 9 * * 1-5', () => {
  logger.info('Cron: 9:30 AM - Capturing ORB');
  captureORB();
}, {
  timezone: 'Asia/Kolkata',
});

// Every minute from 9:31 AM to 3:29 PM - Check signals
cron.schedule('31-59 9 * * 1-5', () => {
  checkSignals();
}, {
  timezone: 'Asia/Kolkata',
});

cron.schedule('* 10-14 * * 1-5', () => {
  checkSignals();
}, {
  timezone: 'Asia/Kolkata',
});

cron.schedule('0-29 15 * * 1-5', () => {
  checkSignals();
}, {
  timezone: 'Asia/Kolkata',
});

// Every 15 minutes from 9:45 AM to 3:15 PM - Market update email
cron.schedule('45 9 * * 1-5', () => {
  logger.info('Cron: 9:45 AM - Sending market update');
  sendMarketUpdate();
}, {
  timezone: 'Asia/Kolkata',
});

cron.schedule('0,15,30,45 10-14 * * 1-5', () => {
  logger.info('Cron: Sending market update');
  sendMarketUpdate();
}, {
  timezone: 'Asia/Kolkata',
});

cron.schedule('0,15 15 * * 1-5', () => {
  logger.info('Cron: Sending market update');
  sendMarketUpdate();
}, {
  timezone: 'Asia/Kolkata',
});

// 3:30 PM - End day
cron.schedule('30 15 * * 1-5', () => {
  logger.info('Cron: 3:30 PM - Ending day');
  endDay();
}, {
  timezone: 'Asia/Kolkata',
});

// 3:45 PM - Post-market report
cron.schedule('45 15 * * 1-5', () => {
  logger.info('Cron: 3:45 PM - Sending post-market report');
  sendPostMarketReportWrapper();
}, {
  timezone: 'Asia/Kolkata',
});

// 7:00 AM - Morning report (5-day analysis)
cron.schedule('0 7 * * 1-5', () => {
  logger.info('Cron: 7:00 AM - Sending morning report');
  morningReport.sendMorningReport().catch(err => {
    logger.error('Morning report cron failed', { error: err.message });
  });
}, {
  timezone: 'Asia/Kolkata',
});

// ============================================
// Startup
// ============================================

async function main() {
  // Validate configuration
  const configValidation = validateConfig();
  if (!configValidation.isValid) {
    logger.error('Invalid configuration', { missingKeys: configValidation.missingKeys });
    logger.warn('Copy .env.example to .env and fill in your credentials');
  }

  // Initialize strategy engine
  initializeStrategyEngine();

  // Initialize Telegram bot
  await initializeTelegram();

  // Start Express server
  const port = config.server.port;
  app.listen(port, () => {
    logger.info(`A-Day Alert System started on port ${port}`);
    logger.info('Endpoints:');
    logger.info(`  GET  /health            - Health check`);
    logger.info(`  GET  /state             - System state`);
    logger.info(`  POST /test-alert        - Send test alert`);
    logger.info(`  GET  /aday-check        - Manual A-Day check`);
    logger.info(`  POST /check-signals     - Manual signal check`);
    logger.info(`  POST /lock              - Lock trading`);
    logger.info(`  POST /unlock            - Unlock trading`);
    logger.info(`  GET  /force-analyze     - Check force analyze mode`);
    logger.info(`  POST /force-analyze/on  - Enable (signals on C-Days)`);
    logger.info(`  POST /force-analyze/off - Disable force analyze`);
    logger.info(`  POST /market-update     - Send market update email now`);
    logger.info(`  POST /post-market-report - Send post-market report`);
    logger.info(`  POST /morning-report    - Send morning report`);
    logger.info(`  GET  /levels            - Get S/R levels`);
    logger.info(`  GET  /oi                - Get OI analysis`);
    logger.info(`  GET  /simulate-day      - Simulate with historical data`);
    logger.info(`  GET  /verify-day        - Verify day & send report`);
    logger.info('');
    logger.info('Cron Schedule (IST):');
    logger.info('  9:15 AM      - Start day (login + A-Day check)');
    logger.info('  9:30 AM      - Capture ORB range');
    logger.info('  9:31-3:29 PM - Check signals every minute');
    logger.info('  Every 15 min - Market update email (9:45 AM - 3:15 PM)');
    logger.info('  3:30 PM      - End day');
    logger.info('  3:45 PM      - Post-market report');
    logger.info('  7:00 AM      - Morning report (5-day analysis)');
    logger.info('');
    logger.info('Strategies registered:');
    for (const [name] of strategyEngine.getAllStrategies()) {
      logger.info(`  - ${name}`);
    }
  });

  // If market is currently open and we're in a trading window, start manually
  if (isTradingDay() && isMarketOpen()) {
    logger.info('Market is currently open, starting day...');
    await startDay();

    // If past 9:30, capture ORB
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    if (hours > 9 || (hours === 9 && minutes >= 30)) {
      await captureORB();
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  telegramService.stop();
  endDay();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  telegramService.stop();
  endDay();
  process.exit(0);
});

// Start the application
main().catch(error => {
  logger.error('Failed to start application', { error: error.message });
  process.exit(1);
});

module.exports = { app };
