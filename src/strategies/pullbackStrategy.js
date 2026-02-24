/**
 * Pullback Continuation Strategy
 *
 * Time Window: 10:15 AM - 1:30 PM
 *
 * Logic:
 * 1. Determine trend from the first hour (9:15-10:15)
 * 2. Wait for a pullback to 20 EMA or swing level
 * 3. Signal when price breaks above the pullback high (bullish) or below pullback low (bearish)
 * 4. Direction follows the first-hour trend
 */

const brokerService = require('../services/brokerService');
const { logger, logSignal } = require('../utils/logger');
const { isWithinTimeWindow, formatDateForKite, getISTNow } = require('../utils/timeUtils');

// Strategy state
let firstHourTrend = null;
let trendDetermined = false;
let lastCheckDate = null;
let pullbackDetected = false;
let pullbackLevel = null;

/**
 * Calculate EMA
 * @param {number[]} prices - Array of closing prices
 * @param {number} period - EMA period
 * @returns {number[]} EMA values
 */
function calculateEMA(prices, period) {
  const ema = [];
  const multiplier = 2 / (period + 1);

  // First EMA is SMA
  let sum = 0;
  for (let i = 0; i < period && i < prices.length; i++) {
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
 * Determine the first-hour trend (9:15-10:15)
 * @returns {Promise<string>} 'BULLISH', 'BEARISH', or 'NEUTRAL'
 */
async function determineFirstHourTrend() {
  try {
    const today = formatDateForKite(new Date());

    // Reset if new day
    if (lastCheckDate !== today) {
      firstHourTrend = null;
      trendDetermined = false;
      pullbackDetected = false;
      pullbackLevel = null;
      lastCheckDate = today;
    }

    if (trendDetermined) {
      return firstHourTrend;
    }

    // Only determine trend after 10:15 AM
    if (!isWithinTimeWindow('10:15', '15:30')) {
      return null;
    }

    const instrumentToken = await brokerService.getNiftyInstrumentToken();

    // Fetch 5-minute candles for today
    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '5minute',
      today,
      today
    );

    // First hour = 12 five-minute candles (9:15 to 10:15)
    const firstHourCandles = historicalData.slice(0, 12);

    if (firstHourCandles.length < 12) {
      logger.warn('Not enough candles for first hour trend', { count: firstHourCandles.length });
      return null;
    }

    const openPrice = firstHourCandles[0].open;
    const closePrice = firstHourCandles[firstHourCandles.length - 1].close;
    const highPrice = Math.max(...firstHourCandles.map(c => c.high));
    const lowPrice = Math.min(...firstHourCandles.map(c => c.low));

    const change = closePrice - openPrice;
    const range = highPrice - lowPrice;

    // Trend determination:
    // - Strong trend: move > 50% of range in one direction
    // - Bullish: close > open by significant amount
    // - Bearish: close < open by significant amount

    const trendThreshold = range * 0.3; // 30% of range

    if (change > trendThreshold) {
      firstHourTrend = 'BULLISH';
    } else if (change < -trendThreshold) {
      firstHourTrend = 'BEARISH';
    } else {
      firstHourTrend = 'NEUTRAL';
    }

    trendDetermined = true;

    logger.info('First hour trend determined', {
      trend: firstHourTrend,
      open: openPrice,
      close: closePrice,
      change,
      range,
    });

    return firstHourTrend;
  } catch (error) {
    logger.error('Failed to determine first hour trend', { error: error.message });
    return null;
  }
}

/**
 * Check for pullback setup
 * @returns {Promise<Object|null>} Signal object or null
 */
async function checkPullback() {
  try {
    // Verify we're in the pullback time window (10:15-1:30)
    if (!isWithinTimeWindow('10:15', '13:30')) {
      return null;
    }

    // Ensure trend is determined
    if (!trendDetermined || !firstHourTrend) {
      await determineFirstHourTrend();
      if (!firstHourTrend || firstHourTrend === 'NEUTRAL') {
        return null;
      }
    }

    // Skip if trend is neutral
    if (firstHourTrend === 'NEUTRAL') {
      return null;
    }

    const instrumentToken = await brokerService.getNiftyInstrumentToken();
    const today = formatDateForKite(new Date());

    // Fetch 5-minute candles
    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '5minute',
      today,
      today
    );

    if (historicalData.length < 15) {
      return null;
    }

    // Calculate 20 EMA
    const closePrices = historicalData.map(c => c.close);
    const ema20 = calculateEMA(closePrices, 20);

    // Get recent candles (last 5)
    const recentCandles = historicalData.slice(-5);
    const latestCandle = recentCandles[recentCandles.length - 1];
    const currentEMA = ema20[ema20.length - 1];

    if (!currentEMA) {
      return null;
    }

    let signal = null;

    if (firstHourTrend === 'BULLISH') {
      // Look for pullback to EMA and then bounce
      // Pullback: price touches or goes below EMA
      // Bounce: price closes above recent pullback high

      // Check if there was a pullback to EMA in recent candles
      const pullbackToEMA = recentCandles.some(c => c.low <= currentEMA * 1.002); // Within 0.2% of EMA

      if (pullbackToEMA && !pullbackDetected) {
        // Find the pullback low
        const pullbackLow = Math.min(...recentCandles.map(c => c.low));
        pullbackLevel = {
          low: pullbackLow,
          ema: currentEMA,
        };
        pullbackDetected = true;
        logger.info('Bullish pullback detected', pullbackLevel);
      }

      // Check for bounce - close above pullback high with strong candle
      if (pullbackDetected && pullbackLevel) {
        const pullbackHigh = Math.max(...recentCandles.slice(0, -1).map(c => c.high));

        if (latestCandle.close > pullbackHigh && latestCandle.close > latestCandle.open) {
          signal = {
            strategy: 'PULLBACK CONTINUATION',
            direction: 'BUY_CE',
            signal: 'BUY_CE',
            spotPrice: latestCandle.close,
            trend: firstHourTrend,
            ema20: currentEMA,
            pullbackLow: pullbackLevel.low,
            stopLoss: pullbackLevel.low,
            time: new Date(),
          };

          logger.info('Bullish pullback breakout signal', signal);
          logSignal('PULLBACK', signal);
        }
      }
    } else if (firstHourTrend === 'BEARISH') {
      // Look for pullback to EMA and then continuation down
      // Pullback: price touches or goes above EMA
      // Breakdown: price closes below recent pullback low

      const pullbackToEMA = recentCandles.some(c => c.high >= currentEMA * 0.998);

      if (pullbackToEMA && !pullbackDetected) {
        const pullbackHigh = Math.max(...recentCandles.map(c => c.high));
        pullbackLevel = {
          high: pullbackHigh,
          ema: currentEMA,
        };
        pullbackDetected = true;
        logger.info('Bearish pullback detected', pullbackLevel);
      }

      if (pullbackDetected && pullbackLevel) {
        const pullbackLow = Math.min(...recentCandles.slice(0, -1).map(c => c.low));

        if (latestCandle.close < pullbackLow && latestCandle.close < latestCandle.open) {
          signal = {
            strategy: 'PULLBACK CONTINUATION',
            direction: 'BUY_PE',
            signal: 'BUY_PE',
            spotPrice: latestCandle.close,
            trend: firstHourTrend,
            ema20: currentEMA,
            pullbackHigh: pullbackLevel.high,
            stopLoss: pullbackLevel.high,
            time: new Date(),
          };

          logger.info('Bearish pullback breakdown signal', signal);
          logSignal('PULLBACK', signal);
        }
      }
    }

    return signal;
  } catch (error) {
    logger.error('Pullback check failed', { error: error.message });
    return null;
  }
}

/**
 * Get current strategy state
 * @returns {Object} Current state
 */
function getState() {
  return {
    firstHourTrend,
    trendDetermined,
    pullbackDetected,
    pullbackLevel,
  };
}

/**
 * Reset strategy state
 */
function reset() {
  firstHourTrend = null;
  trendDetermined = false;
  pullbackDetected = false;
  pullbackLevel = null;
  lastCheckDate = null;
}

module.exports = {
  determineFirstHourTrend,
  checkPullback,
  getState,
  reset,
  calculateEMA,
};
