/**
 * Open Range Breakout (ORB) Strategy
 *
 * Time Window: 9:30 AM - 10:30 AM
 *
 * Logic:
 * 1. Capture the first 15-minute candle (9:15-9:30) high and low
 * 2. Wait for a breakout above high or below low
 * 3. Signal on 15-minute candle CLOSE (not wick) outside the range
 * 4. Direction: CE for breakout above, PE for breakout below
 */

const brokerService = require('../services/brokerService');
const { logger, logSignal } = require('../utils/logger');
const { isWithinTimeWindow, formatDateForKite, getISTNow } = require('../utils/timeUtils');

// ORB state for the day
let orbRange = null;
let orbCaptured = false;
let lastCheckDate = null;

/**
 * Capture the first 15-minute candle range (called at 9:30 AM)
 * @returns {Promise<Object>} ORB range { high, low, captured: boolean }
 */
async function captureORBRange() {
  try {
    const today = formatDateForKite(new Date());

    // Reset if new day
    if (lastCheckDate !== today) {
      orbRange = null;
      orbCaptured = false;
      lastCheckDate = today;
    }

    if (orbCaptured) {
      logger.info('ORB range already captured', orbRange);
      return orbRange;
    }

    // Get NIFTY instrument token
    const instrumentToken = await brokerService.getNiftyInstrumentToken();

    // Fetch 15-minute candle data for today
    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '15minute',
      today,
      today
    );

    // First candle should be 9:15-9:30
    if (historicalData.length === 0) {
      logger.warn('No 15-min candle data available yet');
      return { high: 0, low: 0, captured: false };
    }

    const firstCandle = historicalData[0];
    orbRange = {
      high: firstCandle.high,
      low: firstCandle.low,
      open: firstCandle.open,
      close: firstCandle.close,
      range: firstCandle.high - firstCandle.low,
      captured: true,
      captureTime: new Date(),
    };

    orbCaptured = true;
    logger.info('ORB range captured', orbRange);

    return orbRange;
  } catch (error) {
    logger.error('Failed to capture ORB range', { error: error.message });
    throw error;
  }
}

/**
 * Check for ORB breakout
 * @returns {Promise<Object|null>} Signal object or null
 */
async function checkBreakout() {
  try {
    // Verify we're in the ORB time window (9:30-10:30)
    if (!isWithinTimeWindow('09:30', '10:30')) {
      return null;
    }

    // Ensure ORB range is captured
    if (!orbCaptured || !orbRange) {
      logger.warn('ORB range not captured yet');
      return null;
    }

    // Get NIFTY instrument token
    const instrumentToken = await brokerService.getNiftyInstrumentToken();
    const today = formatDateForKite(new Date());

    // Fetch latest 15-minute candles
    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '15minute',
      today,
      today
    );

    if (historicalData.length < 2) {
      // Need at least 2 candles (first for ORB, second for breakout)
      return null;
    }

    // Get the latest completed candle (not the current forming one)
    // The last candle might be forming, so check the second-to-last if close to candle end
    const now = getISTNow();
    const minutes = now.getMinutes();

    // Use the last candle if we're past the first minute of a new 15-min period
    // Otherwise use second-to-last (the completed one)
    const latestCandle = minutes % 15 < 1 && historicalData.length > 1
      ? historicalData[historicalData.length - 2]
      : historicalData[historicalData.length - 1];

    // Skip the first candle (that's the ORB range itself)
    if (historicalData.indexOf(latestCandle) === 0) {
      return null;
    }

    // Check for breakout on CLOSE (not wick)
    // Bullish breakout: candle CLOSES above ORB high
    // Bearish breakout: candle CLOSES below ORB low

    let signal = null;

    if (latestCandle.close > orbRange.high) {
      // Bullish breakout - BUY CE
      signal = {
        strategy: 'ORB BREAKOUT',
        direction: 'BUY_CE',
        signal: 'BUY_CE',
        spotPrice: latestCandle.close,
        orbHigh: orbRange.high,
        orbLow: orbRange.low,
        stopLoss: orbRange.low, // SL at ORB low
        breakoutCandle: {
          open: latestCandle.open,
          high: latestCandle.high,
          low: latestCandle.low,
          close: latestCandle.close,
        },
        time: new Date(),
      };

      logger.info('ORB Bullish breakout detected', signal);
      logSignal('ORB', signal);

    } else if (latestCandle.close < orbRange.low) {
      // Bearish breakout - BUY PE
      signal = {
        strategy: 'ORB BREAKOUT',
        direction: 'BUY_PE',
        signal: 'BUY_PE',
        spotPrice: latestCandle.close,
        orbHigh: orbRange.high,
        orbLow: orbRange.low,
        stopLoss: orbRange.high, // SL at ORB high
        breakoutCandle: {
          open: latestCandle.open,
          high: latestCandle.high,
          low: latestCandle.low,
          close: latestCandle.close,
        },
        time: new Date(),
      };

      logger.info('ORB Bearish breakout detected', signal);
      logSignal('ORB', signal);
    }

    return signal;
  } catch (error) {
    logger.error('ORB breakout check failed', { error: error.message });
    return null;
  }
}

/**
 * Get current ORB range (for display/debugging)
 * @returns {Object|null} Current ORB range
 */
function getORBRange() {
  return orbRange;
}

/**
 * Check if ORB has been captured today
 * @returns {boolean}
 */
function isORBCaptured() {
  return orbCaptured;
}

/**
 * Reset ORB state (for new day or testing)
 */
function resetORB() {
  orbRange = null;
  orbCaptured = false;
  lastCheckDate = null;
}

/**
 * Check ORB with mock data (for testing)
 * @param {Object} mockOrbRange - Mock ORB range
 * @param {Object} mockLatestCandle - Mock latest candle
 * @returns {Object|null} Signal or null
 */
function checkBreakoutMock(mockOrbRange, mockLatestCandle) {
  if (mockLatestCandle.close > mockOrbRange.high) {
    return {
      strategy: 'ORB BREAKOUT',
      direction: 'BUY_CE',
      signal: 'BUY_CE',
      spotPrice: mockLatestCandle.close,
      orbHigh: mockOrbRange.high,
      orbLow: mockOrbRange.low,
      stopLoss: mockOrbRange.low,
      time: new Date(),
    };
  } else if (mockLatestCandle.close < mockOrbRange.low) {
    return {
      strategy: 'ORB BREAKOUT',
      direction: 'BUY_PE',
      signal: 'BUY_PE',
      spotPrice: mockLatestCandle.close,
      orbHigh: mockOrbRange.high,
      orbLow: mockOrbRange.low,
      stopLoss: mockOrbRange.high,
      time: new Date(),
    };
  }
  return null;
}

module.exports = {
  captureORBRange,
  checkBreakout,
  getORBRange,
  isORBCaptured,
  resetORB,
  checkBreakoutMock,
};
