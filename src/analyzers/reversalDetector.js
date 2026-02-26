/**
 * Reversal Detector
 *
 * Detects intraday reversals by tracking:
 * - Swing highs and lows
 * - Reversal magnitude (points)
 * - Reversal timestamps
 */

const brokerService = require('../services/brokerService');
const { logger } = require('../utils/logger');
const { formatDateForKite, getISTNow, formatTimeForAlert } = require('../utils/timeUtils');

// Track reversals for the day
let dailyReversals = [];
let lastReversalDate = null;

// Minimum reversal magnitude to track (in points)
const MIN_REVERSAL_MAGNITUDE = 30;

/**
 * Detect reversals from price data
 * @param {Array} candles - Array of OHLCV candles
 * @param {number} minMagnitude - Minimum points for a reversal
 * @returns {Array} Array of detected reversals
 */
function detectReversals(candles, minMagnitude = MIN_REVERSAL_MAGNITUDE) {
  if (!candles || candles.length < 5) {
    return [];
  }

  const reversals = [];
  let currentTrend = null; // 'UP' or 'DOWN'
  let trendStart = null;
  let extremePrice = null;
  let extremeIndex = null;

  for (let i = 1; i < candles.length; i++) {
    const prevCandle = candles[i - 1];
    const currCandle = candles[i];

    // Determine candle direction
    const candleDirection = currCandle.close > currCandle.open ? 'UP' : 'DOWN';

    // Initialize trend if not set
    if (currentTrend === null) {
      currentTrend = candleDirection;
      trendStart = i;
      extremePrice = candleDirection === 'UP' ? currCandle.high : currCandle.low;
      extremeIndex = i;
      continue;
    }

    // Update extreme within current trend
    if (currentTrend === 'UP' && currCandle.high > extremePrice) {
      extremePrice = currCandle.high;
      extremeIndex = i;
    } else if (currentTrend === 'DOWN' && currCandle.low < extremePrice) {
      extremePrice = currCandle.low;
      extremeIndex = i;
    }

    // Check for reversal
    let isReversal = false;
    let reversalMagnitude = 0;

    if (currentTrend === 'UP') {
      // Check for bearish reversal
      if (currCandle.close < extremePrice - minMagnitude) {
        isReversal = true;
        reversalMagnitude = extremePrice - currCandle.close;
      }
    } else {
      // Check for bullish reversal
      if (currCandle.close > extremePrice + minMagnitude) {
        isReversal = true;
        reversalMagnitude = currCandle.close - extremePrice;
      }
    }

    if (isReversal) {
      reversals.push({
        type: currentTrend === 'UP' ? 'BEARISH_REVERSAL' : 'BULLISH_REVERSAL',
        fromPrice: extremePrice,
        toPrice: currCandle.close,
        magnitude: Math.round(reversalMagnitude),
        timestamp: currCandle.date || new Date(),
        candleIndex: i,
      });

      // Reset trend
      currentTrend = currentTrend === 'UP' ? 'DOWN' : 'UP';
      trendStart = i;
      extremePrice = currentTrend === 'UP' ? currCandle.high : currCandle.low;
      extremeIndex = i;
    }
  }

  return reversals;
}

/**
 * Analyze current market for reversals
 * @returns {Promise<Object>} Reversal analysis
 */
async function analyze() {
  try {
    const today = formatDateForKite(new Date());

    // Reset if new day
    if (lastReversalDate !== today) {
      dailyReversals = [];
      lastReversalDate = today;
    }

    const instrumentToken = await brokerService.getNiftyInstrumentToken();

    // Get 5-minute candles for today
    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '5minute',
      today,
      today
    );

    if (!historicalData || historicalData.length < 5) {
      return {
        reversals: [],
        hasRecentReversal: false,
        error: 'Insufficient data',
      };
    }

    // Detect all reversals
    const reversals = detectReversals(historicalData);

    // Store for daily tracking
    dailyReversals = reversals;

    // Check for recent reversal (last 6 candles = 30 minutes)
    const recentReversals = reversals.filter(r => r.candleIndex >= historicalData.length - 6);

    // Get the most significant reversal
    const significantReversal = reversals.length > 0
      ? reversals.reduce((max, r) => (r.magnitude > max.magnitude ? r : max), reversals[0])
      : null;

    // Current price info
    const latestCandle = historicalData[historicalData.length - 1];
    const dayHigh = Math.max(...historicalData.map(c => c.high));
    const dayLow = Math.min(...historicalData.map(c => c.low));

    // Check if we're near day extreme (potential reversal zone)
    const currentPrice = latestCandle.close;
    const nearDayHigh = (dayHigh - currentPrice) < 20;
    const nearDayLow = (currentPrice - dayLow) < 20;

    return {
      reversals,
      reversalCount: reversals.length,
      hasRecentReversal: recentReversals.length > 0,
      recentReversals,
      significantReversal,
      dayHigh,
      dayLow,
      currentPrice,
      nearDayHigh,
      nearDayLow,
      potentialReversalZone: nearDayHigh ? 'NEAR_HIGH' : nearDayLow ? 'NEAR_LOW' : null,
    };
  } catch (error) {
    logger.error('Reversal detection failed', { error: error.message });
    return {
      reversals: [],
      hasRecentReversal: false,
      error: error.message,
    };
  }
}

/**
 * Get daily reversal summary
 * @returns {Object} Summary of day's reversals
 */
function getDailySummary() {
  const bullish = dailyReversals.filter(r => r.type === 'BULLISH_REVERSAL');
  const bearish = dailyReversals.filter(r => r.type === 'BEARISH_REVERSAL');

  const totalMagnitude = dailyReversals.reduce((sum, r) => sum + r.magnitude, 0);

  return {
    total: dailyReversals.length,
    bullish: bullish.length,
    bearish: bearish.length,
    totalMagnitude,
    averageMagnitude: dailyReversals.length > 0 ? Math.round(totalMagnitude / dailyReversals.length) : 0,
    reversals: dailyReversals.map(r => ({
      type: r.type,
      magnitude: r.magnitude,
      time: formatTimeForAlert(new Date(r.timestamp)),
    })),
  };
}

/**
 * Check if current setup suggests reversal
 * @param {Object} trendAnalysis - From trendAnalyzer
 * @param {Object} volumeAnalysis - From volumeAnalyzer
 * @returns {Object} Reversal probability assessment
 */
function assessReversalProbability(trendAnalysis, volumeAnalysis) {
  const factors = [];
  let probability = 0;

  // Weak trend suggests possible reversal
  if (trendAnalysis && trendAnalysis.strength === 'WEAK') {
    factors.push('Weak trend');
    probability += 20;
  }

  // Volume spike can indicate reversal
  if (volumeAnalysis && volumeAnalysis.isSpike) {
    factors.push('Volume spike');
    probability += 15;
  }

  // Near day extreme
  const analysis = getDailySummary();
  if (analysis.total >= 2) {
    factors.push('Multiple reversals today');
    probability += 10;
  }

  return {
    probability: Math.min(100, probability),
    factors,
    isHighProbability: probability >= 30,
  };
}

/**
 * Clear daily data
 */
function clearDailyData() {
  dailyReversals = [];
  lastReversalDate = null;
}

module.exports = {
  analyze,
  detectReversals,
  getDailySummary,
  assessReversalProbability,
  clearDailyData,
};
