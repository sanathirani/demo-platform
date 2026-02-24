/**
 * Pre-Expiry Momentum Strategy
 *
 * Time Window: 11:00 AM - 2:00 PM
 * Days: Thursday (weekly expiry) or day before monthly expiry
 *
 * Logic:
 * 1. Only active on expiry days
 * 2. Look for strong directional move with volume spike (1.5x average)
 * 3. Signal with ATM option
 * 4. Quick momentum play leveraging expiry-day volatility
 */

const brokerService = require('../services/brokerService');
const { logger, logSignal } = require('../utils/logger');
const {
  isWithinTimeWindow,
  isExpiryDay,
  formatDateForKite,
  getTradingDaysAgo,
} = require('../utils/timeUtils');

// Strategy state
let volumeBaseline = null;
let lastCheckDate = null;
let signalSent = false;

/**
 * Calculate average volume from recent 5-minute candles
 * @param {Array} candles - Array of candles
 * @returns {number} Average volume
 */
function calculateAvgVolume(candles) {
  if (!candles || candles.length === 0) return 0;
  const totalVolume = candles.reduce((sum, c) => sum + c.volume, 0);
  return totalVolume / candles.length;
}

/**
 * Initialize volume baseline for the day
 * @returns {Promise<number>} Baseline volume
 */
async function initVolumeBaseline() {
  try {
    const today = formatDateForKite(new Date());

    if (lastCheckDate !== today) {
      volumeBaseline = null;
      signalSent = false;
      lastCheckDate = today;
    }

    if (volumeBaseline) {
      return volumeBaseline;
    }

    const instrumentToken = await brokerService.getNiftyInstrumentToken();

    // Get previous 5 days of 5-minute data for baseline
    const fromDate = getTradingDaysAgo(5);
    const toDate = getTradingDaysAgo(1);

    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '5minute',
      formatDateForKite(fromDate),
      formatDateForKite(toDate)
    );

    // Calculate average volume per 5-minute candle
    volumeBaseline = calculateAvgVolume(historicalData);

    logger.info('Volume baseline initialized', {
      baseline: volumeBaseline,
      candleCount: historicalData.length,
    });

    return volumeBaseline;
  } catch (error) {
    logger.error('Failed to initialize volume baseline', { error: error.message });
    return 0;
  }
}

/**
 * Check for expiry momentum setup
 * @returns {Promise<Object|null>} Signal object or null
 */
async function checkMomentum() {
  try {
    // Only run on expiry days
    if (!isExpiryDay()) {
      return null;
    }

    // Verify we're in the expiry momentum time window (11:00-2:00)
    if (!isWithinTimeWindow('11:00', '14:00')) {
      return null;
    }

    // Don't send multiple signals
    if (signalSent) {
      return null;
    }

    // Initialize baseline if needed
    if (!volumeBaseline) {
      await initVolumeBaseline();
    }

    const instrumentToken = await brokerService.getNiftyInstrumentToken();
    const today = formatDateForKite(new Date());

    // Fetch today's 5-minute candles
    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '5minute',
      today,
      today
    );

    if (historicalData.length < 10) {
      return null;
    }

    // Look at last 3 candles for momentum
    const recentCandles = historicalData.slice(-3);
    const latestCandle = recentCandles[recentCandles.length - 1];

    // Calculate recent volume spike
    const recentAvgVolume = calculateAvgVolume(recentCandles);
    const volumeRatio = volumeBaseline > 0 ? recentAvgVolume / volumeBaseline : 0;

    // Check for volume spike (1.5x baseline)
    const hasVolumeSpike = volumeRatio >= 1.5;

    if (!hasVolumeSpike) {
      return null;
    }

    // Check for directional move
    // Strong move = all 3 candles in same direction with good body ratio
    const allBullish = recentCandles.every(c => c.close > c.open);
    const allBearish = recentCandles.every(c => c.close < c.open);

    if (!allBullish && !allBearish) {
      return null;
    }

    // Calculate total move
    const moveStart = recentCandles[0].open;
    const moveEnd = latestCandle.close;
    const totalMove = Math.abs(moveEnd - moveStart);

    // Minimum move threshold (50 points in 15 minutes)
    if (totalMove < 50) {
      return null;
    }

    let signal = null;

    if (allBullish) {
      signal = {
        strategy: 'EXPIRY MOMENTUM',
        direction: 'BUY_CE',
        signal: 'BUY_CE',
        spotPrice: latestCandle.close,
        volumeSpike: `${(volumeRatio * 100).toFixed(0)}%`,
        movePoints: totalMove.toFixed(0),
        stopLoss: Math.min(...recentCandles.map(c => c.low)),
        time: new Date(),
        isExpiry: true,
      };

      logger.info('Expiry bullish momentum signal', signal);
      logSignal('EXPIRY_MOMENTUM', signal);
      signalSent = true;

    } else if (allBearish) {
      signal = {
        strategy: 'EXPIRY MOMENTUM',
        direction: 'BUY_PE',
        signal: 'BUY_PE',
        spotPrice: latestCandle.close,
        volumeSpike: `${(volumeRatio * 100).toFixed(0)}%`,
        movePoints: totalMove.toFixed(0),
        stopLoss: Math.max(...recentCandles.map(c => c.high)),
        time: new Date(),
        isExpiry: true,
      };

      logger.info('Expiry bearish momentum signal', signal);
      logSignal('EXPIRY_MOMENTUM', signal);
      signalSent = true;
    }

    return signal;
  } catch (error) {
    logger.error('Expiry momentum check failed', { error: error.message });
    return null;
  }
}

/**
 * Get current strategy state
 * @returns {Object} Current state
 */
function getState() {
  return {
    volumeBaseline,
    signalSent,
    isExpiry: isExpiryDay(),
  };
}

/**
 * Reset strategy state
 */
function reset() {
  volumeBaseline = null;
  signalSent = false;
  lastCheckDate = null;
}

/**
 * Check momentum with mock data (for testing)
 * @param {Array} mockCandles - Mock recent candles
 * @param {number} mockBaseline - Mock volume baseline
 * @returns {Object|null} Signal or null
 */
function checkMomentumMock(mockCandles, mockBaseline) {
  if (mockCandles.length < 3) return null;

  const recentCandles = mockCandles.slice(-3);
  const latestCandle = recentCandles[recentCandles.length - 1];

  const recentAvgVolume = calculateAvgVolume(recentCandles);
  const volumeRatio = mockBaseline > 0 ? recentAvgVolume / mockBaseline : 0;

  if (volumeRatio < 1.5) return null;

  const allBullish = recentCandles.every(c => c.close > c.open);
  const allBearish = recentCandles.every(c => c.close < c.open);

  if (!allBullish && !allBearish) return null;

  const moveStart = recentCandles[0].open;
  const moveEnd = latestCandle.close;
  const totalMove = Math.abs(moveEnd - moveStart);

  if (totalMove < 50) return null;

  if (allBullish) {
    return {
      strategy: 'EXPIRY MOMENTUM',
      direction: 'BUY_CE',
      signal: 'BUY_CE',
      spotPrice: latestCandle.close,
      volumeSpike: `${(volumeRatio * 100).toFixed(0)}%`,
      movePoints: totalMove.toFixed(0),
      stopLoss: Math.min(...recentCandles.map(c => c.low)),
      time: new Date(),
    };
  } else {
    return {
      strategy: 'EXPIRY MOMENTUM',
      direction: 'BUY_PE',
      signal: 'BUY_PE',
      spotPrice: latestCandle.close,
      volumeSpike: `${(volumeRatio * 100).toFixed(0)}%`,
      movePoints: totalMove.toFixed(0),
      stopLoss: Math.max(...recentCandles.map(c => c.high)),
      time: new Date(),
    };
  }
}

module.exports = {
  initVolumeBaseline,
  checkMomentum,
  getState,
  reset,
  checkMomentumMock,
};
