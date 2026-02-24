const brokerService = require('../services/brokerService');
const { logger, logADayCheck } = require('../utils/logger');
const {
  formatDateForKite,
  getPreviousTradingDay,
  getTradingDaysAgo,
} = require('../utils/timeUtils');

// Cache for today's A-Day status
let todayADayStatus = null;
let lastCheckDate = null;

/**
 * A-Day Detection Criteria:
 * 1. Body ratio > 60% (body size / total range)
 * 2. Volume > 20-day average volume
 * 3. Range > 100 points
 *
 * A-Day = Trending day with strong conviction
 * C-Day = Choppy/consolidation day
 */

/**
 * Calculate body ratio (body size / total range)
 * @param {Object} candle - OHLCV candle
 * @returns {number} Body ratio (0-1)
 */
function calculateBodyRatio(candle) {
  const { open, high, low, close } = candle;
  const range = high - low;
  if (range === 0) return 0;

  const body = Math.abs(close - open);
  return body / range;
}

/**
 * Calculate candle range (high - low)
 * @param {Object} candle - OHLCV candle
 * @returns {number} Range in points
 */
function calculateRange(candle) {
  return candle.high - candle.low;
}

/**
 * Determine if a candle is bullish or bearish
 * @param {Object} candle - OHLCV candle
 * @returns {string} 'BULLISH' or 'BEARISH'
 */
function getCandleDirection(candle) {
  return candle.close >= candle.open ? 'BULLISH' : 'BEARISH';
}

/**
 * Fetch 20-day average volume
 * @param {number} instrumentToken - NIFTY instrument token
 * @returns {Promise<number>} Average volume
 */
async function get20DayAvgVolume(instrumentToken) {
  try {
    const toDate = getPreviousTradingDay();
    const fromDate = getTradingDaysAgo(25); // Fetch extra days to ensure 20 trading days

    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      'day',
      formatDateForKite(fromDate),
      formatDateForKite(toDate)
    );

    if (historicalData.length < 20) {
      logger.warn('Less than 20 days of data available', { days: historicalData.length });
    }

    // Get last 20 days
    const last20Days = historicalData.slice(-20);
    const totalVolume = last20Days.reduce((sum, candle) => sum + candle.volume, 0);
    const avgVolume = totalVolume / last20Days.length;

    return avgVolume;
  } catch (error) {
    logger.error('Failed to fetch 20-day avg volume', { error: error.message });
    throw error;
  }
}

/**
 * Fetch previous day's OHLCV data
 * @param {number} instrumentToken - NIFTY instrument token
 * @returns {Promise<Object>} Previous day's candle
 */
async function getPreviousDayCandle(instrumentToken) {
  try {
    const prevDay = getPreviousTradingDay();
    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      'day',
      formatDateForKite(prevDay),
      formatDateForKite(prevDay)
    );

    if (historicalData.length === 0) {
      throw new Error('No data for previous trading day');
    }

    return historicalData[0];
  } catch (error) {
    logger.error('Failed to fetch previous day candle', { error: error.message });
    throw error;
  }
}

/**
 * Check if previous day was an A-Day
 * @returns {Promise<Object>} { isADay: boolean, reason: string, data: Object }
 */
async function checkADay() {
  try {
    // Check cache - only check once per day
    const today = formatDateForKite(new Date());
    if (lastCheckDate === today && todayADayStatus !== null) {
      logger.info('Using cached A-Day status', todayADayStatus);
      return todayADayStatus;
    }

    // Get NIFTY instrument token
    const instrumentToken = await brokerService.getNiftyInstrumentToken();

    // Get previous day's candle and 20-day average volume in parallel
    const [prevCandle, avgVolume] = await Promise.all([
      getPreviousDayCandle(instrumentToken),
      get20DayAvgVolume(instrumentToken),
    ]);

    // Calculate metrics
    const bodyRatio = calculateBodyRatio(prevCandle);
    const range = calculateRange(prevCandle);
    const direction = getCandleDirection(prevCandle);
    const volumeRatio = prevCandle.volume / avgVolume;

    // A-Day criteria
    const bodyRatioThreshold = 0.6; // 60%
    const rangeThreshold = 100; // 100 points
    const volumeThreshold = 1.0; // Above average

    const isBodyStrong = bodyRatio >= bodyRatioThreshold;
    const isRangeStrong = range >= rangeThreshold;
    const isVolumeStrong = volumeRatio >= volumeThreshold;

    const isADay = isBodyStrong && isRangeStrong && isVolumeStrong;

    // Build reason string
    const reasons = [];
    if (isBodyStrong) {
      reasons.push(`Body ratio ${(bodyRatio * 100).toFixed(1)}% > 60%`);
    } else {
      reasons.push(`Body ratio ${(bodyRatio * 100).toFixed(1)}% < 60%`);
    }
    if (isRangeStrong) {
      reasons.push(`Range ${range.toFixed(0)}pts > 100pts`);
    } else {
      reasons.push(`Range ${range.toFixed(0)}pts < 100pts`);
    }
    if (isVolumeStrong) {
      reasons.push(`Volume ${(volumeRatio * 100).toFixed(0)}% of avg`);
    } else {
      reasons.push(`Volume ${(volumeRatio * 100).toFixed(0)}% below avg`);
    }

    const data = {
      date: formatDateForKite(getPreviousTradingDay()),
      open: prevCandle.open,
      high: prevCandle.high,
      low: prevCandle.low,
      close: prevCandle.close,
      volume: prevCandle.volume,
      bodyRatio: (bodyRatio * 100).toFixed(1) + '%',
      range: range.toFixed(0) + 'pts',
      volumeRatio: (volumeRatio * 100).toFixed(0) + '%',
      direction,
      avgVolume: Math.round(avgVolume),
    };

    const result = {
      isADay,
      reason: isADay
        ? `A-DAY (${direction}): ${reasons.join(', ')}`
        : `C-DAY: ${reasons.join(', ')}`,
      direction: isADay ? direction : null,
      data,
    };

    // Cache result
    todayADayStatus = result;
    lastCheckDate = today;

    // Log result
    logADayCheck(isADay, result.reason, data);

    return result;
  } catch (error) {
    logger.error('A-Day check failed', { error: error.message });
    throw error;
  }
}

/**
 * Get cached A-Day status (or check if not cached)
 * @returns {Promise<Object>} A-Day status
 */
async function getADayStatus() {
  const today = formatDateForKite(new Date());
  if (lastCheckDate === today && todayADayStatus !== null) {
    return todayADayStatus;
  }
  return checkADay();
}

/**
 * Clear cached A-Day status (used for testing or manual refresh)
 */
function clearCache() {
  todayADayStatus = null;
  lastCheckDate = null;
}

/**
 * Mock A-Day check for testing (when market is closed)
 * @param {Object} mockCandle - Mock candle data
 * @param {number} mockAvgVolume - Mock average volume
 * @returns {Object} A-Day check result
 */
function checkADayMock(mockCandle, mockAvgVolume) {
  const bodyRatio = calculateBodyRatio(mockCandle);
  const range = calculateRange(mockCandle);
  const direction = getCandleDirection(mockCandle);
  const volumeRatio = mockCandle.volume / mockAvgVolume;

  const isBodyStrong = bodyRatio >= 0.6;
  const isRangeStrong = range >= 100;
  const isVolumeStrong = volumeRatio >= 1.0;

  const isADay = isBodyStrong && isRangeStrong && isVolumeStrong;

  return {
    isADay,
    reason: isADay ? `A-DAY (${direction})` : 'C-DAY',
    direction: isADay ? direction : null,
    data: {
      bodyRatio: (bodyRatio * 100).toFixed(1) + '%',
      range: range.toFixed(0) + 'pts',
      volumeRatio: (volumeRatio * 100).toFixed(0) + '%',
      direction,
    },
  };
}

module.exports = {
  checkADay,
  getADayStatus,
  clearCache,
  checkADayMock,
  calculateBodyRatio,
  calculateRange,
  getCandleDirection,
};
