/**
 * Morning Report Generator
 *
 * Generates daily 7 AM briefing with last 5 trading days analysis:
 * - OHLC data for each day
 * - Day type classification (A-Day/C-Day)
 * - Day behavior (gap, close position, trend)
 * - Key levels (PDH, PDL, Pivot, R1, S1)
 * - Weekly summary
 * - Today's setup
 */

const brokerService = require('../services/brokerService');
const alertService = require('../services/alertService');
const { logger } = require('../utils/logger');
const { formatDateForKite, getISTNow, formatTimeForAlert, getLastNTradingDays } = require('../utils/timeUtils');

/**
 * Classify day type based on price action
 * @param {Object} candle - Day candle with OHLC
 * @returns {Object} { type, direction }
 */
function classifyDayType(candle) {
  if (!candle || !candle.open) return { type: 'UNKNOWN', direction: null };

  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = range > 0 ? body / range : 0;

  if (bodyRatio >= 0.6 && range >= 100) {
    const direction = candle.close > candle.open ? 'BULLISH' : 'BEARISH';
    return { type: 'A-DAY', direction };
  } else if (bodyRatio < 0.3 && range < 80) {
    return { type: 'CONSOLIDATION', direction: null };
  } else if (range > 150) {
    return { type: 'VOLATILE', direction: null };
  } else {
    return { type: 'C-DAY', direction: null };
  }
}

/**
 * Analyze day behavior
 * @param {Object} candle - Day candle
 * @param {number} prevClose - Previous day's close
 * @returns {Object} Behavior analysis
 */
function analyzeDayBehavior(candle, prevClose) {
  if (!candle || !candle.open) return null;

  const range = candle.high - candle.low;
  const gap = candle.open - prevClose;
  const closePosition = range > 0 ? (candle.close - candle.low) / range : 0.5;

  // Gap analysis
  let gapAnalysis;
  if (gap > 30) {
    gapAnalysis = `Gap UP (+${gap.toFixed(0)} pts)`;
  } else if (gap < -30) {
    gapAnalysis = `Gap DOWN (${gap.toFixed(0)} pts)`;
  } else {
    gapAnalysis = `Flat open (${gap >= 0 ? '+' : ''}${gap.toFixed(0)} pts)`;
  }

  // Close position analysis
  let closeAnalysis;
  if (closePosition >= 0.7) {
    closeAnalysis = 'Closed near day HIGH (upper 30%)';
  } else if (closePosition <= 0.3) {
    closeAnalysis = 'Closed near day LOW (lower 30%)';
  } else {
    closeAnalysis = 'Closed in middle of range';
  }

  // Trend pattern (based on body ratio and direction)
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = range > 0 ? body / range : 0;
  let trendPattern;
  if (bodyRatio >= 0.6) {
    trendPattern = 'Strong trending day, minimal pullbacks';
  } else if (bodyRatio >= 0.4) {
    trendPattern = 'Moderate trend with some choppiness';
  } else {
    trendPattern = 'Choppy/range-bound action';
  }

  return {
    gap,
    gapAnalysis,
    closePosition,
    closeAnalysis,
    trendPattern,
  };
}

/**
 * Calculate key levels from candle
 * @param {Object} candle - Day candle
 * @returns {Object} Key levels
 */
function calculateLevels(candle) {
  if (!candle) return null;

  const { high, low, close } = candle;
  const pivot = (high + low + close) / 3;

  return {
    pdh: Math.round(high),
    pdl: Math.round(low),
    pivot: Math.round(pivot),
    r1: Math.round((2 * pivot) - low),
    s1: Math.round((2 * pivot) - high),
  };
}

/**
 * Analyze a single trading day
 * @param {Object} candle - Day candle
 * @param {number} prevClose - Previous day's close
 * @param {number} avgVolume - 20-day average volume
 * @returns {Object} Day analysis
 */
function analyzeSingleDay(candle, prevClose, avgVolume) {
  const dayType = classifyDayType(candle);
  const behavior = analyzeDayBehavior(candle, prevClose);
  const levels = calculateLevels(candle);

  const range = candle.high - candle.low;
  const change = candle.close - prevClose;
  const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = range > 0 ? (body / range) * 100 : 0;
  const volumeStatus = candle.volume > avgVolume ? 'Above Avg' : 'Below Avg';

  return {
    date: candle.date,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    range: Math.round(range),
    change: Math.round(change),
    changePercent: changePercent.toFixed(2),
    bodyRatio: Math.round(bodyRatio),
    volumeStatus,
    dayType: dayType.type,
    dayDirection: dayType.direction,
    behavior,
    levels,
  };
}

/**
 * Generate morning report data
 * @returns {Promise<Object>} Report data
 */
async function generateMorningReport() {
  try {
    const now = getISTNow();
    logger.info('Generating morning report');

    // Get last 5 trading days
    const tradingDays = getLastNTradingDays(5);
    const instrumentToken = await brokerService.getNiftyInstrumentToken();

    // Fetch day candles for date range (oldest to newest for proper prev close)
    const oldestDate = formatDateForKite(tradingDays[tradingDays.length - 1]);
    const newestDate = formatDateForKite(tradingDays[0]);

    // Need one extra day before oldest for prev close calculation
    const extraDay = new Date(tradingDays[tradingDays.length - 1]);
    extraDay.setDate(extraDay.getDate() - 1);
    while (extraDay.getDay() === 0 || extraDay.getDay() === 6) {
      extraDay.setDate(extraDay.getDate() - 1);
    }
    const startDate = formatDateForKite(extraDay);

    const dayCandles = await brokerService.getHistoricalData(
      instrumentToken,
      'day',
      startDate,
      newestDate
    );

    if (!dayCandles || dayCandles.length < 2) {
      throw new Error('Insufficient historical data');
    }

    // Calculate 20-day average volume (use available data)
    const avgVolume = dayCandles.reduce((sum, c) => sum + (c.volume || 0), 0) / dayCandles.length;

    // Analyze each of the 5 days
    const daysAnalysis = [];
    for (let i = 1; i < dayCandles.length && daysAnalysis.length < 5; i++) {
      const candle = dayCandles[i];
      const prevClose = dayCandles[i - 1].close;
      const analysis = analyzeSingleDay(candle, prevClose, avgVolume);
      daysAnalysis.push(analysis);
    }

    // Reverse so most recent is first
    daysAnalysis.reverse();

    // Calculate weekly summary
    const weeklySummary = calculateWeeklySummary(daysAnalysis);

    // Today's setup (based on most recent day)
    const todaySetup = generateTodaySetup(daysAnalysis[0]);

    const report = {
      generatedAt: formatTimeForAlert(now),
      reportDate: formatDateForKite(now),
      days: daysAnalysis,
      weeklySummary,
      todaySetup,
    };

    logger.info('Morning report generated', {
      days: daysAnalysis.length,
      aDays: weeklySummary.aDayCount,
    });

    return report;
  } catch (error) {
    logger.error('Failed to generate morning report', { error: error.message });
    throw error;
  }
}

/**
 * Calculate weekly summary from days analysis
 * @param {Array} days - Array of day analyses
 * @returns {Object} Weekly summary
 */
function calculateWeeklySummary(days) {
  const aDays = days.filter(d => d.dayType === 'A-DAY');
  const cDays = days.filter(d => d.dayType === 'C-DAY');
  const volatileDays = days.filter(d => d.dayType === 'VOLATILE');
  const consolidationDays = days.filter(d => d.dayType === 'CONSOLIDATION');

  const netChange = days.reduce((sum, d) => sum + d.change, 0);
  const netChangePercent = days.reduce((sum, d) => sum + parseFloat(d.changePercent), 0);
  const avgRange = days.reduce((sum, d) => sum + d.range, 0) / days.length;

  return {
    aDayCount: aDays.length,
    aDayBullish: aDays.filter(d => d.dayDirection === 'BULLISH').length,
    aDayBearish: aDays.filter(d => d.dayDirection === 'BEARISH').length,
    cDayCount: cDays.length,
    volatileCount: volatileDays.length,
    consolidationCount: consolidationDays.length,
    netChange: Math.round(netChange),
    netChangePercent: netChangePercent.toFixed(2),
    avgRange: Math.round(avgRange),
  };
}

/**
 * Generate today's setup from previous day
 * @param {Object} prevDay - Previous day analysis
 * @returns {Object} Today's setup
 */
function generateTodaySetup(prevDay) {
  if (!prevDay) return null;

  const isActive = prevDay.dayType === 'A-DAY';
  let expectation;
  let watchLevels;

  if (isActive) {
    const direction = prevDay.dayDirection === 'BULLISH' ? 'bullish' : 'bearish';
    expectation = `Follow-through in ${direction} direction expected`;
    watchLevels = prevDay.dayDirection === 'BULLISH'
      ? `PDH ${prevDay.levels.pdh} for breakout, PDL ${prevDay.levels.pdl} for support`
      : `PDL ${prevDay.levels.pdl} for breakdown, PDH ${prevDay.levels.pdh} for resistance`;
  } else {
    expectation = 'No A-Day setup - system will be inactive unless force-analyze enabled';
    watchLevels = `Range: ${prevDay.levels.pdl} - ${prevDay.levels.pdh}`;
  }

  return {
    prevDayType: prevDay.dayType,
    prevDayDirection: prevDay.dayDirection,
    systemActive: isActive,
    expectation,
    watchLevels,
    keyLevels: prevDay.levels,
  };
}

module.exports = {
  classifyDayType,
  analyzeDayBehavior,
  calculateLevels,
  analyzeSingleDay,
  generateMorningReport,
  calculateWeeklySummary,
  generateTodaySetup,
};
