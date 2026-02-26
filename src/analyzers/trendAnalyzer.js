/**
 * Trend Analyzer
 *
 * Analyzes market trend using:
 * - EMA (20-period)
 * - Price position relative to EMA
 * - Trend strength measurement
 */

const brokerService = require('../services/brokerService');
const { logger } = require('../utils/logger');
const { formatDateForKite, getISTNow } = require('../utils/timeUtils');

/**
 * Calculate EMA (Exponential Moving Average)
 * @param {number[]} prices - Array of closing prices
 * @param {number} period - EMA period
 * @returns {number[]} Array of EMA values
 */
function calculateEMA(prices, period) {
  const ema = [];
  const multiplier = 2 / (period + 1);

  if (prices.length < period) {
    return [];
  }

  // First EMA is SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  ema[period - 1] = sum / period;

  // Calculate rest of EMA
  for (let i = period; i < prices.length; i++) {
    ema[i] = (prices[i] - ema[i - 1]) * multiplier + ema[i - 1];
  }

  return ema;
}

/**
 * Calculate SMA (Simple Moving Average)
 * @param {number[]} prices - Array of prices
 * @param {number} period - SMA period
 * @returns {number|null} SMA value or null
 */
function calculateSMA(prices, period) {
  if (prices.length < period) return null;

  const relevantPrices = prices.slice(-period);
  const sum = relevantPrices.reduce((a, b) => a + b, 0);
  return sum / period;
}

/**
 * Determine trend direction and strength
 * @param {Array} candles - Array of OHLCV candles
 * @param {number} emaPeriod - EMA period to use (default 20)
 * @returns {Object} Trend analysis
 */
function determineTrend(candles, emaPeriod = 20) {
  if (!candles || candles.length < emaPeriod) {
    return {
      direction: 'NEUTRAL',
      strength: 'WEAK',
      ema: null,
      error: 'Insufficient data',
    };
  }

  const closePrices = candles.map(c => c.close);
  const emaValues = calculateEMA(closePrices, emaPeriod);
  const currentEMA = emaValues[emaValues.length - 1];
  const currentPrice = closePrices[closePrices.length - 1];

  if (!currentEMA) {
    return {
      direction: 'NEUTRAL',
      strength: 'WEAK',
      ema: null,
    };
  }

  // Calculate price position relative to EMA
  const priceVsEMA = ((currentPrice - currentEMA) / currentEMA) * 100;

  // Calculate EMA slope (change over last 5 candles)
  const recentEMAs = emaValues.slice(-5).filter(e => e !== undefined);
  let emaSlope = 0;
  if (recentEMAs.length >= 2) {
    emaSlope = ((recentEMAs[recentEMAs.length - 1] - recentEMAs[0]) / recentEMAs[0]) * 100;
  }

  // Determine direction
  let direction = 'NEUTRAL';
  if (currentPrice > currentEMA && emaSlope > 0) {
    direction = 'BULLISH';
  } else if (currentPrice < currentEMA && emaSlope < 0) {
    direction = 'BEARISH';
  } else if (currentPrice > currentEMA) {
    direction = 'BULLISH_WEAK';
  } else if (currentPrice < currentEMA) {
    direction = 'BEARISH_WEAK';
  }

  // Determine strength
  let strength = 'WEAK';
  const absDistance = Math.abs(priceVsEMA);
  const absSlope = Math.abs(emaSlope);

  if (absDistance > 0.5 && absSlope > 0.1) {
    strength = 'STRONG';
  } else if (absDistance > 0.2 || absSlope > 0.05) {
    strength = 'MODERATE';
  }

  return {
    direction,
    strength,
    ema: currentEMA,
    currentPrice,
    priceVsEMA: priceVsEMA.toFixed(2),
    emaSlope: emaSlope.toFixed(3),
    isPriceAboveEMA: currentPrice > currentEMA,
  };
}

/**
 * Analyze current market trend
 * @returns {Promise<Object>} Trend analysis results
 */
async function analyze() {
  try {
    const instrumentToken = await brokerService.getNiftyInstrumentToken();
    const today = formatDateForKite(new Date());

    // Get 5-minute candles for today
    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '5minute',
      today,
      today
    );

    if (!historicalData || historicalData.length < 20) {
      return {
        direction: 'NEUTRAL',
        strength: 'WEAK',
        error: 'Insufficient data for trend analysis',
      };
    }

    // Calculate trend using 20 EMA
    const trendAnalysis = determineTrend(historicalData, 20);

    // Add first hour analysis
    const firstHourCandles = historicalData.slice(0, 12);
    let firstHourTrend = 'NEUTRAL';

    if (firstHourCandles.length >= 12) {
      const firstHourOpen = firstHourCandles[0].open;
      const firstHourClose = firstHourCandles[11].close;
      const firstHourHigh = Math.max(...firstHourCandles.map(c => c.high));
      const firstHourLow = Math.min(...firstHourCandles.map(c => c.low));
      const firstHourRange = firstHourHigh - firstHourLow;
      const firstHourChange = firstHourClose - firstHourOpen;

      if (firstHourRange > 0) {
        const changeRatio = Math.abs(firstHourChange) / firstHourRange;
        if (firstHourChange > 0 && changeRatio > 0.3) {
          firstHourTrend = 'BULLISH';
        } else if (firstHourChange < 0 && changeRatio > 0.3) {
          firstHourTrend = 'BEARISH';
        }
      }
    }

    return {
      ...trendAnalysis,
      firstHourTrend,
      candleCount: historicalData.length,
    };
  } catch (error) {
    logger.error('Trend analysis failed', { error: error.message });
    return {
      direction: 'NEUTRAL',
      strength: 'WEAK',
      error: error.message,
    };
  }
}

/**
 * Check if price is crossing EMA
 * @param {Array} candles - Recent candles (at least 3)
 * @param {number} ema - Current EMA value
 * @returns {Object} Crossover info
 */
function checkEMACrossover(candles, ema) {
  if (!candles || candles.length < 3 || !ema) {
    return { hasCrossover: false, direction: null };
  }

  const prevCandle = candles[candles.length - 2];
  const currCandle = candles[candles.length - 1];

  // Bullish crossover: previous close below EMA, current close above
  if (prevCandle.close < ema && currCandle.close > ema) {
    return {
      hasCrossover: true,
      direction: 'BULLISH',
      crossoverPrice: ema,
    };
  }

  // Bearish crossover: previous close above EMA, current close below
  if (prevCandle.close > ema && currCandle.close < ema) {
    return {
      hasCrossover: true,
      direction: 'BEARISH',
      crossoverPrice: ema,
    };
  }

  return { hasCrossover: false, direction: null };
}

module.exports = {
  analyze,
  calculateEMA,
  calculateSMA,
  determineTrend,
  checkEMACrossover,
};
