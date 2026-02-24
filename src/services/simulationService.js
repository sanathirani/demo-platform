/**
 * Simulation Service
 *
 * Provides day simulation using real historical market data.
 * Allows testing A-Day detection and signal generation without waiting for market hours.
 *
 * Logic:
 * - If market closed/not started today → use previous trading day data
 * - If market open with data → use current day data
 */

const brokerService = require('./brokerService');
const { logger } = require('../utils/logger');
const {
  getISTNow,
  getCurrentTimeString,
  formatDateForKite,
  getPreviousTradingDay,
  getTradingDaysAgo,
  isTradingDay,
  isMarketOpen,
} = require('../utils/timeUtils');

// Import A-Day calculation helpers
const {
  calculateBodyRatio,
  calculateRange,
  getCandleDirection,
} = require('../filters/adayFilter');

// Import EMA calculation from pullback strategy
const { calculateEMA } = require('../strategies/pullbackStrategy');

/**
 * Determine which date to use for simulation
 * @returns {Promise<{date: Date, reason: string}>}
 */
async function getSimulationDate() {
  const now = getISTNow();
  const currentTime = getCurrentTimeString();
  const today = formatDateForKite(now);

  // If weekend or before market opens, use previous trading day
  if (!isTradingDay()) {
    return {
      date: getPreviousTradingDay(),
      reason: 'Weekend - using previous trading day',
    };
  }

  if (currentTime < '09:30') {
    return {
      date: getPreviousTradingDay(),
      reason: 'Before market open - using previous trading day',
    };
  }

  // Market is open or closed for the day, try to use today's data
  try {
    const instrumentToken = await brokerService.getNiftyInstrumentToken();
    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '15minute',
      today,
      today
    );

    if (historicalData && historicalData.length >= 1) {
      return {
        date: now,
        reason: "Using today's data",
      };
    }
  } catch (error) {
    logger.warn('Could not fetch today data for simulation', { error: error.message });
  }

  return {
    date: getPreviousTradingDay(),
    reason: "No data for today - using previous trading day",
  };
}

/**
 * Check A-Day status for a specific date
 * @param {number} instrumentToken - NIFTY instrument token
 * @param {Date} targetDate - Date to check (checks the day BEFORE this date)
 * @returns {Promise<Object>} A-Day analysis result
 */
async function checkADayForDate(instrumentToken, targetDate) {
  // Get the day before the target date
  const checkDate = new Date(targetDate);
  checkDate.setDate(checkDate.getDate() - 1);

  // Skip weekends
  while (checkDate.getDay() === 0 || checkDate.getDay() === 6) {
    checkDate.setDate(checkDate.getDate() - 1);
  }

  const checkDateStr = formatDateForKite(checkDate);

  // Fetch the candle for the check date
  const candleData = await brokerService.getHistoricalData(
    instrumentToken,
    'day',
    checkDateStr,
    checkDateStr
  );

  if (!candleData || candleData.length === 0) {
    throw new Error(`No data available for ${checkDateStr}`);
  }

  const candle = candleData[0];

  // Get 20-day average volume
  const volumeFromDate = getTradingDaysAgo(25);
  const volumeToDate = new Date(checkDate);
  volumeToDate.setDate(volumeToDate.getDate() - 1);

  const volumeData = await brokerService.getHistoricalData(
    instrumentToken,
    'day',
    formatDateForKite(volumeFromDate),
    formatDateForKite(volumeToDate)
  );

  const last20Days = volumeData.slice(-20);
  const avgVolume = last20Days.reduce((sum, c) => sum + c.volume, 0) / last20Days.length;

  // Calculate metrics
  const bodyRatio = calculateBodyRatio(candle);
  const range = calculateRange(candle);
  const direction = getCandleDirection(candle);
  const volumeRatio = candle.volume / avgVolume;

  // A-Day criteria
  const isBodyStrong = bodyRatio >= 0.6;
  const isRangeStrong = range >= 100;
  const isVolumeStrong = volumeRatio >= 1.0;

  const isADay = isBodyStrong && isRangeStrong && isVolumeStrong;

  return {
    isADay,
    direction: isADay ? direction : null,
    date: checkDateStr,
    data: {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      bodyRatio: (bodyRatio * 100).toFixed(1) + '%',
      range: range.toFixed(0) + ' pts',
      volumeRatio: (volumeRatio * 100).toFixed(0) + '%',
      avgVolume: Math.round(avgVolume),
    },
    criteria: {
      bodyRatio: { value: (bodyRatio * 100).toFixed(1) + '%', passed: isBodyStrong, threshold: '60%' },
      range: { value: range.toFixed(0) + ' pts', passed: isRangeStrong, threshold: '100 pts' },
      volume: { value: (volumeRatio * 100).toFixed(0) + '%', passed: isVolumeStrong, threshold: '100%' },
    },
  };
}

/**
 * Simulate ORB strategy with historical 15-min candles
 * @param {Array} candles15min - 15-minute candles for the day
 * @param {string} adayDirection - 'BULLISH' or 'BEARISH' (from A-Day check)
 * @returns {Array} Array of signals
 */
function simulateORB(candles15min, adayDirection) {
  const signals = [];

  if (!candles15min || candles15min.length < 2) {
    return signals;
  }

  // First candle (9:15-9:30) = ORB range
  const orbCandle = candles15min[0];
  const orbHigh = orbCandle.high;
  const orbLow = orbCandle.low;

  // Check each subsequent candle for breakout (9:30-10:30 window)
  for (let i = 1; i < candles15min.length; i++) {
    const candle = candles15min[i];
    const candleTime = new Date(candle.date);
    const hours = candleTime.getHours();
    const minutes = candleTime.getMinutes();

    // Only check 9:30-10:30 window
    // 9:30 candle starts at 9:30, 10:15 candle ends at 10:30
    const isInWindow =
      (hours === 9 && minutes >= 30) ||
      (hours === 10 && minutes <= 15);

    if (!isInWindow) {
      continue;
    }

    // Check for breakout on CLOSE
    if (candle.close > orbHigh) {
      signals.push({
        time: formatTime(candleTime),
        strategy: 'ORB BREAKOUT',
        direction: 'BUY_CE',
        spotPrice: candle.close,
        orbHigh,
        orbLow,
        stopLoss: orbLow,
        breakoutCandle: {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        },
      });
      break; // Only one signal per strategy
    }

    if (candle.close < orbLow) {
      signals.push({
        time: formatTime(candleTime),
        strategy: 'ORB BREAKOUT',
        direction: 'BUY_PE',
        spotPrice: candle.close,
        orbHigh,
        orbLow,
        stopLoss: orbHigh,
        breakoutCandle: {
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        },
      });
      break;
    }
  }

  return signals;
}

/**
 * Simulate Pullback strategy with historical 5-min candles
 * @param {Array} candles5min - 5-minute candles for the day
 * @param {string} adayDirection - 'BULLISH' or 'BEARISH'
 * @returns {Array} Array of signals
 */
function simulatePullback(candles5min, adayDirection) {
  const signals = [];

  if (!candles5min || candles5min.length < 20) {
    return signals;
  }

  // First hour = 12 five-minute candles (9:15 to 10:15)
  const firstHourCandles = candles5min.slice(0, 12);

  if (firstHourCandles.length < 12) {
    return signals;
  }

  // Determine first hour trend
  const openPrice = firstHourCandles[0].open;
  const closePrice = firstHourCandles[11].close;
  const highPrice = Math.max(...firstHourCandles.map(c => c.high));
  const lowPrice = Math.min(...firstHourCandles.map(c => c.low));
  const range = highPrice - lowPrice;
  const change = closePrice - openPrice;
  const trendThreshold = range * 0.3;

  let trend;
  if (change > trendThreshold) {
    trend = 'BULLISH';
  } else if (change < -trendThreshold) {
    trend = 'BEARISH';
  } else {
    trend = 'NEUTRAL';
  }

  // Skip if neutral trend
  if (trend === 'NEUTRAL') {
    return signals;
  }

  // Calculate 20 EMA
  const closePrices = candles5min.map(c => c.close);
  const ema20 = calculateEMA(closePrices, 20);

  // Check for pullback in 10:15-13:30 window (candle index 12 onwards)
  let pullbackDetected = false;
  let pullbackLevel = null;

  for (let i = 12; i < candles5min.length; i++) {
    const candle = candles5min[i];
    const candleTime = new Date(candle.date);
    const hours = candleTime.getHours();
    const minutes = candleTime.getMinutes();

    // Only check 10:15-13:30 window
    const isInWindow =
      (hours === 10 && minutes >= 15) ||
      (hours >= 11 && hours <= 12) ||
      (hours === 13 && minutes <= 30);

    if (!isInWindow) {
      continue;
    }

    const currentEMA = ema20[i];
    if (!currentEMA) continue;

    // Get recent 5 candles
    const startIdx = Math.max(0, i - 4);
    const recentCandles = candles5min.slice(startIdx, i + 1);

    if (trend === 'BULLISH') {
      // Look for pullback to EMA
      const pullbackToEMA = recentCandles.some(c => c.low <= currentEMA * 1.002);

      if (pullbackToEMA && !pullbackDetected) {
        pullbackLevel = {
          low: Math.min(...recentCandles.map(c => c.low)),
          ema: currentEMA,
        };
        pullbackDetected = true;
      }

      // Check for bounce
      if (pullbackDetected && pullbackLevel) {
        const pullbackHigh = Math.max(...recentCandles.slice(0, -1).map(c => c.high));
        if (candle.close > pullbackHigh && candle.close > candle.open) {
          signals.push({
            time: formatTime(candleTime),
            strategy: 'PULLBACK CONTINUATION',
            direction: 'BUY_CE',
            spotPrice: candle.close,
            trend,
            ema20: currentEMA.toFixed(2),
            pullbackLow: pullbackLevel.low,
            stopLoss: pullbackLevel.low,
          });
          break;
        }
      }
    } else if (trend === 'BEARISH') {
      // Look for pullback to EMA
      const pullbackToEMA = recentCandles.some(c => c.high >= currentEMA * 0.998);

      if (pullbackToEMA && !pullbackDetected) {
        pullbackLevel = {
          high: Math.max(...recentCandles.map(c => c.high)),
          ema: currentEMA,
        };
        pullbackDetected = true;
      }

      // Check for breakdown
      if (pullbackDetected && pullbackLevel) {
        const pullbackLow = Math.min(...recentCandles.slice(0, -1).map(c => c.low));
        if (candle.close < pullbackLow && candle.close < candle.open) {
          signals.push({
            time: formatTime(candleTime),
            strategy: 'PULLBACK CONTINUATION',
            direction: 'BUY_PE',
            spotPrice: candle.close,
            trend,
            ema20: currentEMA.toFixed(2),
            pullbackHigh: pullbackLevel.high,
            stopLoss: pullbackLevel.high,
          });
          break;
        }
      }
    }
  }

  return signals;
}

/**
 * Simulate Expiry Momentum strategy with historical 5-min candles
 * @param {Array} candles5min - 5-minute candles for the day
 * @param {number} baselineVolume - Baseline volume from previous days
 * @param {boolean} isThursday - Whether the simulation date is Thursday
 * @returns {Array} Array of signals
 */
function simulateExpiryMomentum(candles5min, baselineVolume, isThursday) {
  const signals = [];

  // Only run on Thursdays (expiry days)
  if (!isThursday) {
    return signals;
  }

  if (!candles5min || candles5min.length < 10 || !baselineVolume) {
    return signals;
  }

  // Check each candle in 11:00-14:00 window
  for (let i = 2; i < candles5min.length; i++) {
    const candle = candles5min[i];
    const candleTime = new Date(candle.date);
    const hours = candleTime.getHours();

    // Only check 11:00-14:00 window
    if (hours < 11 || hours >= 14) {
      continue;
    }

    // Look at last 3 candles for momentum
    const recentCandles = candles5min.slice(i - 2, i + 1);
    if (recentCandles.length < 3) continue;

    // Calculate volume spike
    const recentAvgVolume = recentCandles.reduce((sum, c) => sum + c.volume, 0) / 3;
    const volumeRatio = recentAvgVolume / baselineVolume;

    // Check for volume spike (1.5x baseline)
    if (volumeRatio < 1.5) {
      continue;
    }

    // Check for directional move
    const allBullish = recentCandles.every(c => c.close > c.open);
    const allBearish = recentCandles.every(c => c.close < c.open);

    if (!allBullish && !allBearish) {
      continue;
    }

    // Calculate total move
    const moveStart = recentCandles[0].open;
    const moveEnd = candle.close;
    const totalMove = Math.abs(moveEnd - moveStart);

    // Minimum move threshold (50 points)
    if (totalMove < 50) {
      continue;
    }

    if (allBullish) {
      signals.push({
        time: formatTime(candleTime),
        strategy: 'EXPIRY MOMENTUM',
        direction: 'BUY_CE',
        spotPrice: candle.close,
        volumeSpike: (volumeRatio * 100).toFixed(0) + '%',
        movePoints: totalMove.toFixed(0),
        stopLoss: Math.min(...recentCandles.map(c => c.low)),
        isExpiry: true,
      });
      break;
    } else if (allBearish) {
      signals.push({
        time: formatTime(candleTime),
        strategy: 'EXPIRY MOMENTUM',
        direction: 'BUY_PE',
        spotPrice: candle.close,
        volumeSpike: (volumeRatio * 100).toFixed(0) + '%',
        movePoints: totalMove.toFixed(0),
        stopLoss: Math.max(...recentCandles.map(c => c.high)),
        isExpiry: true,
      });
      break;
    }
  }

  return signals;
}

/**
 * Format time from Date object
 * @param {Date} date
 * @returns {string} Time in HH:mm format
 */
function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Run full day simulation with historical data
 * @param {Date} targetDate - Date to simulate (optional, auto-detected if not provided)
 * @param {boolean} forceAnalyze - If true, run strategies even if not an A-Day (for verification)
 * @returns {Promise<Object>} Full simulation result
 */
async function simulateDay(targetDate = null, forceAnalyze = false) {
  try {
    // Determine simulation date if not provided
    let simDate, dateReason;
    if (targetDate) {
      simDate = targetDate;
      dateReason = 'User specified date';
    } else {
      const dateResult = await getSimulationDate();
      simDate = dateResult.date;
      dateReason = dateResult.reason;
    }

    const simDateStr = formatDateForKite(simDate);
    logger.info('Running day simulation', { date: simDateStr, reason: dateReason });

    // Get instrument token
    const instrumentToken = await brokerService.getNiftyInstrumentToken();

    // Check if simulation date is Thursday
    const isThursday = simDate.getDay() === 4;

    // Run A-Day check (checks day before simulation date)
    const adayCheck = await checkADayForDate(instrumentToken, simDate);

    // If not an A-Day, we still simulate but note it
    const adayDirection = adayCheck.isADay ? adayCheck.direction : null;

    // Fetch candle data for the simulation day
    const [candles15min, candles5min] = await Promise.all([
      brokerService.getHistoricalData(instrumentToken, '15minute', simDateStr, simDateStr),
      brokerService.getHistoricalData(instrumentToken, '5minute', simDateStr, simDateStr),
    ]);

    // Get volume baseline for expiry momentum
    let volumeBaseline = 0;
    try {
      const fromDate = getTradingDaysAgo(5);
      const toDate = new Date(simDate);
      toDate.setDate(toDate.getDate() - 1);
      while (toDate.getDay() === 0 || toDate.getDay() === 6) {
        toDate.setDate(toDate.getDate() - 1);
      }

      const volumeData = await brokerService.getHistoricalData(
        instrumentToken,
        '5minute',
        formatDateForKite(fromDate),
        formatDateForKite(toDate)
      );
      volumeBaseline = volumeData.reduce((sum, c) => sum + c.volume, 0) / volumeData.length;
    } catch (e) {
      logger.warn('Could not calculate volume baseline', { error: e.message });
    }

    // Simulate each strategy
    const allSignals = [];

    // ORB Strategy (run if A-Day OR forceAnalyze)
    if (adayCheck.isADay || forceAnalyze) {
      const orbSignals = simulateORB(candles15min, adayDirection || 'NEUTRAL');
      allSignals.push(...orbSignals);
    }

    // Pullback Strategy (run if A-Day OR forceAnalyze)
    if (adayCheck.isADay || forceAnalyze) {
      const pullbackSignals = simulatePullback(candles5min, adayDirection || 'NEUTRAL');
      allSignals.push(...pullbackSignals);
    }

    // Expiry Momentum (only on Thursdays)
    if (isThursday) {
      const expirySignals = simulateExpiryMomentum(candles5min, volumeBaseline, isThursday);
      allSignals.push(...expirySignals);
    }

    // Build market status
    let marketStatus;
    if (!isTradingDay()) {
      marketStatus = 'weekend';
    } else if (!isMarketOpen()) {
      const currentTime = getCurrentTimeString();
      marketStatus = currentTime < '09:15' ? 'pre-market' : 'closed';
    } else {
      marketStatus = 'open';
    }

    // Build summary
    const summary = {
      totalSignals: allSignals.length,
      ceSignals: allSignals.filter(s => s.direction === 'BUY_CE').length,
      peSignals: allSignals.filter(s => s.direction === 'BUY_PE').length,
      strategies: {
        orb: allSignals.filter(s => s.strategy === 'ORB BREAKOUT').length,
        pullback: allSignals.filter(s => s.strategy === 'PULLBACK CONTINUATION').length,
        expiry: allSignals.filter(s => s.strategy === 'EXPIRY MOMENTUM').length,
      },
    };

    // Get ORB range info
    const orbRange = candles15min.length > 0 ? {
      high: candles15min[0].high,
      low: candles15min[0].low,
      range: candles15min[0].high - candles15min[0].low,
    } : null;

    return {
      simulationDate: simDateStr,
      dateReason,
      marketStatus,
      isThursday,
      forceAnalyze,
      adayCheck: {
        checkedDate: adayCheck.date,
        isADay: adayCheck.isADay,
        direction: adayCheck.direction,
        criteria: adayCheck.criteria,
        data: adayCheck.data,
      },
      orbRange,
      candleCount: {
        '15min': candles15min.length,
        '5min': candles5min.length,
      },
      volumeBaseline: Math.round(volumeBaseline),
      signals: allSignals,
      summary,
    };
  } catch (error) {
    logger.error('Day simulation failed', { error: error.message });
    throw error;
  }
}

/**
 * Generate HTML verification report for email
 * @param {Object} simResult - Result from simulateDay()
 * @returns {string} HTML email body
 */
function generateVerificationReport(simResult) {
  const { simulationDate, adayCheck, orbRange, signals, summary, isThursday, forceAnalyze } = simResult;

  // A-Day status color
  const adayColor = adayCheck.isADay ? '#28a745' : '#dc3545';
  const adayText = adayCheck.isADay ? 'A-DAY' : 'C-DAY';

  // Build criteria rows
  const criteriaRows = Object.entries(adayCheck.criteria).map(([key, val]) => {
    const passIcon = val.passed ? '✅' : '❌';
    const rowColor = val.passed ? '#d4edda' : '#f8d7da';
    return `
      <tr style="background: ${rowColor};">
        <td style="padding: 10px; border: 1px solid #ddd;">${key.toUpperCase()}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${val.value}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${val.threshold}</td>
        <td style="padding: 10px; border: 1px solid #ddd;">${passIcon}</td>
      </tr>
    `;
  }).join('');

  // Build signals section
  let signalsHtml = '';
  if (signals.length === 0) {
    signalsHtml = `
      <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; color: #666;">
        <p style="font-size: 18px;">No signals generated</p>
        <p>${adayCheck.isADay ? 'A-Day detected but no breakouts occurred' : 'Previous day was C-Day - system was inactive'}</p>
      </div>
    `;
  } else {
    const signalRows = signals.map((sig, idx) => {
      const dirColor = sig.direction === 'BUY_CE' ? '#28a745' : '#dc3545';
      const dirIcon = sig.direction === 'BUY_CE' ? '📈' : '📉';

      // Build reason based on strategy
      let reason = '';
      if (sig.strategy === 'ORB BREAKOUT') {
        if (sig.direction === 'BUY_CE') {
          reason = `Price closed at ${sig.spotPrice} above ORB High (${sig.orbHigh}). Bullish breakout confirmed.`;
        } else {
          reason = `Price closed at ${sig.spotPrice} below ORB Low (${sig.orbLow}). Bearish breakout confirmed.`;
        }
      } else if (sig.strategy === 'PULLBACK CONTINUATION') {
        if (sig.direction === 'BUY_CE') {
          reason = `First hour trend: ${sig.trend}. Price pulled back to EMA (${sig.ema20}) and bounced. Continuation pattern.`;
        } else {
          reason = `First hour trend: ${sig.trend}. Price pulled back to EMA (${sig.ema20}) and broke down. Continuation pattern.`;
        }
      } else if (sig.strategy === 'EXPIRY MOMENTUM') {
        reason = `Expiry day momentum. Volume spike: ${sig.volumeSpike}. Move: ${sig.movePoints} points in 15 mins.`;
      }

      return `
        <div style="background: #fff; border-left: 4px solid ${dirColor}; padding: 15px; margin: 15px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <span style="font-size: 20px; font-weight: bold;">${dirIcon} Signal #${idx + 1}</span>
            <span style="background: ${dirColor}; color: white; padding: 5px 15px; border-radius: 20px; font-weight: bold;">
              ${sig.direction}
            </span>
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #666;">Time:</td>
              <td style="padding: 8px 0; font-weight: bold;">${sig.time}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666;">Strategy:</td>
              <td style="padding: 8px 0; font-weight: bold;">${sig.strategy}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666;">Spot Price:</td>
              <td style="padding: 8px 0; font-weight: bold;">${sig.spotPrice}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #666;">Stop Loss:</td>
              <td style="padding: 8px 0; font-weight: bold;">${sig.stopLoss}</td>
            </tr>
          </table>
          <div style="background: #f8f9fa; padding: 10px; margin-top: 10px; border-radius: 4px;">
            <strong>Why this signal?</strong><br/>
            ${reason}
          </div>
        </div>
      `;
    }).join('');

    signalsHtml = signalRows;
  }

  // Force analyze warning banner
  const forceAnalyzeBanner = forceAnalyze ? `
    <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0;">
      <strong>🔬 FORCE ANALYZE MODE</strong><br/>
      Strategies run despite C-Day status for analysis purposes.<br/>
      <strong>In production, this day would have been INACTIVE.</strong>
    </div>
  ` : '';

  // Build ORB range section
  const orbHtml = orbRange ? `
    <div style="background: #e7f3ff; padding: 15px; border-radius: 8px; margin: 15px 0;">
      <h4 style="margin: 0 0 10px 0;">📊 ORB Range (9:15-9:30)</h4>
      <table style="width: 100%;">
        <tr>
          <td>High: <strong>${orbRange.high}</strong></td>
          <td>Low: <strong>${orbRange.low}</strong></td>
          <td>Range: <strong>${orbRange.range} pts</strong></td>
        </tr>
      </table>
    </div>
  ` : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; background: #f5f5f5; padding: 20px;">

  <!-- Header -->
  <div style="background: linear-gradient(135deg, #1a73e8, #4285f4); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="margin: 0; font-size: 24px;">📋 Daily Verification Report</h1>
    <p style="margin: 10px 0 0 0; opacity: 0.9;">A-Day Trading System</p>
  </div>

  <!-- Main Content -->
  <div style="background: white; padding: 25px; border-radius: 0 0 12px 12px;">

    <!-- Force Analyze Banner -->
    ${forceAnalyzeBanner}

    <!-- Date & Status -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
      <div>
        <span style="color: #666;">Simulation Date:</span>
        <span style="font-size: 20px; font-weight: bold; margin-left: 10px;">${simulationDate}</span>
        ${isThursday ? '<span style="background: #ffc107; color: #333; padding: 3px 8px; border-radius: 4px; margin-left: 10px; font-size: 12px;">EXPIRY DAY</span>' : ''}
      </div>
      <div style="background: ${adayColor}; color: white; padding: 8px 20px; border-radius: 25px; font-weight: bold;">
        ${adayText} (${adayCheck.direction || 'N/A'})
      </div>
    </div>

    <!-- Previous Day Analysis -->
    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
      <h3 style="margin: 0 0 15px 0;">🔍 Previous Day Analysis (${adayCheck.checkedDate})</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #e9ecef;">
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Criteria</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Value</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Threshold</th>
            <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${criteriaRows}
        </tbody>
      </table>
      <div style="margin-top: 15px; padding: 10px; background: #fff; border-radius: 4px;">
        <strong>OHLC:</strong> O: ${adayCheck.data.open} | H: ${adayCheck.data.high} | L: ${adayCheck.data.low} | C: ${adayCheck.data.close}
      </div>
    </div>

    <!-- ORB Range -->
    ${orbHtml}

    <!-- Signals Section -->
    <h3 style="margin: 25px 0 15px 0;">🚨 Signals Generated</h3>
    ${signalsHtml}

    <!-- Summary -->
    <div style="background: #e8f5e9; padding: 20px; border-radius: 8px; margin-top: 20px;">
      <h3 style="margin: 0 0 15px 0;">📊 Summary</h3>
      <table style="width: 100%;">
        <tr>
          <td>Total Signals:</td>
          <td style="font-weight: bold;">${summary.totalSignals}</td>
          <td>CE Signals:</td>
          <td style="font-weight: bold; color: #28a745;">${summary.ceSignals}</td>
          <td>PE Signals:</td>
          <td style="font-weight: bold; color: #dc3545;">${summary.peSignals}</td>
        </tr>
      </table>
      <div style="margin-top: 10px; font-size: 14px; color: #666;">
        ORB: ${summary.strategies.orb} | Pullback: ${summary.strategies.pullback} | Expiry: ${summary.strategies.expiry}
      </div>
    </div>

  </div>

  <!-- Footer -->
  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    Auto-generated by A-Day Trading Alert System<br/>
    This is a verification report - not a real-time alert
  </div>

</body>
</html>
  `;
}

/**
 * Generate plain text verification report (for WhatsApp)
 * @param {Object} simResult - Result from simulateDay()
 * @returns {string} Plain text report
 */
function generateVerificationText(simResult) {
  const { simulationDate, adayCheck, signals, summary, isThursday, forceAnalyze } = simResult;

  let text = `📋 DAILY VERIFICATION REPORT\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (forceAnalyze) {
    text += `🔬 FORCE ANALYZE MODE\n`;
    text += `In production, this day would be INACTIVE (C-Day)\n\n`;
  }

  text += `📅 Date: ${simulationDate}${isThursday ? ' (Expiry)' : ''}\n`;
  text += `📊 Previous Day (${adayCheck.checkedDate}): ${adayCheck.isADay ? 'A-DAY' : 'C-DAY'} ${adayCheck.direction || ''}\n\n`;

  text += `🔍 A-Day Criteria:\n`;
  for (const [key, val] of Object.entries(adayCheck.criteria)) {
    const icon = val.passed ? '✅' : '❌';
    text += `  ${icon} ${key}: ${val.value} (threshold: ${val.threshold})\n`;
  }

  text += `\n🚨 SIGNALS: ${signals.length}\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;

  if (signals.length === 0) {
    text += adayCheck.isADay
      ? 'No breakouts occurred despite A-Day\n'
      : 'System inactive - previous day was C-Day\n';
  } else {
    signals.forEach((sig, idx) => {
      const icon = sig.direction === 'BUY_CE' ? '📈' : '📉';
      text += `\n${icon} Signal #${idx + 1}\n`;
      text += `  Time: ${sig.time}\n`;
      text += `  Direction: ${sig.direction}\n`;
      text += `  Strategy: ${sig.strategy}\n`;
      text += `  Spot: ${sig.spotPrice}\n`;
      text += `  SL: ${sig.stopLoss}\n`;

      // Reason
      if (sig.strategy === 'ORB BREAKOUT') {
        text += sig.direction === 'BUY_CE'
          ? `  Why: Close ${sig.spotPrice} > ORB High ${sig.orbHigh}\n`
          : `  Why: Close ${sig.spotPrice} < ORB Low ${sig.orbLow}\n`;
      } else if (sig.strategy === 'PULLBACK CONTINUATION') {
        text += `  Why: ${sig.trend} trend, pullback to EMA ${sig.ema20}\n`;
      } else if (sig.strategy === 'EXPIRY MOMENTUM') {
        text += `  Why: Volume ${sig.volumeSpike}, Move ${sig.movePoints}pts\n`;
      }
    });
  }

  text += `\n📊 Summary: ${summary.ceSignals} CE | ${summary.peSignals} PE\n`;
  text += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `A-Day Alert System Verification`;

  return text;
}

module.exports = {
  getSimulationDate,
  simulateDay,
  simulateORB,
  simulatePullback,
  simulateExpiryMomentum,
  checkADayForDate,
  generateVerificationReport,
  generateVerificationText,
};
