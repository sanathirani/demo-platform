/**
 * Open Range Breakout (ORB) Strategy
 *
 * Time Window: 9:30 AM - 10:30 AM
 * Max Score: 15 points
 *
 * Logic:
 * 1. Capture the first 15-minute candle (9:15-9:30) high and low
 * 2. Wait for a breakout above high or below low
 * 3. Signal on 15-minute candle CLOSE (not wick) outside the range
 * 4. Direction: CE for breakout above, PE for breakout below
 */

const BaseStrategy = require('../engine/baseStrategy');
const brokerService = require('../services/brokerService');
const { logger, logSignal } = require('../utils/logger');
const { formatDateForKite, getISTNow } = require('../utils/timeUtils');

class ORBStrategy extends BaseStrategy {
  constructor() {
    super('ORB BREAKOUT', { start: '09:30', end: '10:30' }, 15);
    this.orbRange = null;
    this.orbCaptured = false;
    this.signalSent = false;
  }

  /**
   * Capture the first 15-minute candle range (called at 9:30 AM)
   * @returns {Promise<Object>} ORB range { high, low, captured: boolean }
   */
  async captureORBRange() {
    try {
      const today = formatDateForKite(new Date());

      if (this.orbCaptured) {
        logger.info('ORB range already captured', this.orbRange);
        return this.orbRange;
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
      this.orbRange = {
        high: firstCandle.high,
        low: firstCandle.low,
        open: firstCandle.open,
        close: firstCandle.close,
        range: firstCandle.high - firstCandle.low,
        captured: true,
        captureTime: new Date(),
      };

      this.orbCaptured = true;
      logger.info('ORB range captured', this.orbRange);

      return this.orbRange;
    } catch (error) {
      logger.error('Failed to capture ORB range', { error: error.message });
      throw error;
    }
  }

  /**
   * Analyze market for ORB breakout
   * @param {Object} context - Market context
   * @returns {Promise<Object>} Analysis result
   */
  async analyze(context = {}) {
    this.checkDayReset();

    const reasons = [];
    let score = 0;
    let signal = null;

    try {
      // Check time window
      if (!this.isInTimeWindow()) {
        return {
          signal: null,
          score: 0,
          reasons: [this.createReason('Time Window', 'fail', 'Outside ORB time window (9:30-10:30)')],
        };
      }

      // Ensure ORB range is captured
      if (!this.orbCaptured || !this.orbRange) {
        await this.captureORBRange();
        if (!this.orbCaptured) {
          reasons.push(this.createReason('ORB Range', 'fail', 'ORB range not captured yet'));
          return { signal: null, score: 0, reasons };
        }
      }

      // Don't send multiple signals
      if (this.signalSent) {
        return {
          signal: null,
          score: 0,
          reasons: [this.createReason('Signal Limit', 'neutral', 'ORB signal already sent today')],
        };
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
        reasons.push(this.createReason('Data', 'fail', 'Need at least 2 candles for breakout check'));
        return { signal: null, score: 0, reasons };
      }

      // Get the latest completed candle
      const now = getISTNow();
      const minutes = now.getMinutes();

      // Use the last candle if we're past the first minute of a new 15-min period
      const latestCandle = minutes % 15 < 1 && historicalData.length > 1
        ? historicalData[historicalData.length - 2]
        : historicalData[historicalData.length - 1];

      // Skip the first candle (that's the ORB range itself)
      if (historicalData.indexOf(latestCandle) === 0) {
        reasons.push(this.createReason('Wait', 'neutral', 'Waiting for breakout candle'));
        return { signal: null, score: 0, reasons };
      }

      const currentPrice = latestCandle.close;

      // Add context about current position
      if (currentPrice > this.orbRange.low && currentPrice < this.orbRange.high) {
        reasons.push(this.createReason(
          'Price Position',
          'neutral',
          `Price within ORB range (${this.orbRange.low} - ${this.orbRange.high})`
        ));
        return {
          signal: null,
          score: 0,
          reasons,
          data: { orbRange: this.orbRange, currentPrice },
        };
      }

      // Check for breakout
      let breakoutDirection = null;

      if (latestCandle.close > this.orbRange.high) {
        breakoutDirection = 'BULLISH';
        signal = 'BUY_CE';
        reasons.push(this.createReason(
          'ORB Breakout',
          'pass',
          `Bullish breakout above ${this.orbRange.high} (close: ${latestCandle.close})`
        ));
        score += 10;
      } else if (latestCandle.close < this.orbRange.low) {
        breakoutDirection = 'BEARISH';
        signal = 'BUY_PE';
        reasons.push(this.createReason(
          'ORB Breakout',
          'pass',
          `Bearish breakout below ${this.orbRange.low} (close: ${latestCandle.close})`
        ));
        score += 10;
      }

      if (!breakoutDirection) {
        return {
          signal: null,
          score: 0,
          reasons: [this.createReason('Breakout', 'neutral', 'No confirmed breakout yet')],
          data: { orbRange: this.orbRange, currentPrice },
        };
      }

      // Check A-Day alignment (bonus points)
      if (context.adayStatus?.isADay) {
        const alignsWithADay = (context.adayStatus.direction === 'BULLISH' && breakoutDirection === 'BULLISH') ||
                              (context.adayStatus.direction === 'BEARISH' && breakoutDirection === 'BEARISH');
        if (alignsWithADay) {
          score += 3;
          reasons.push(this.createReason('A-Day Alignment', 'pass', `Breakout aligns with A-Day (${context.adayStatus.direction})`));
        } else {
          reasons.push(this.createReason('A-Day Alignment', 'neutral', `Breakout opposite to A-Day direction`));
        }
      }

      // Check volume confirmation
      if (context.volumeAnalysis?.isSpike) {
        score += 2;
        reasons.push(this.createReason('Volume', 'pass', `Volume spike ${context.volumeAnalysis.percentOfAvg}%`));
      }

      this.signalSent = true;

      const result = {
        signal,
        score,
        reasons,
        data: {
          orbHigh: this.orbRange.high,
          orbLow: this.orbRange.low,
          spotPrice: latestCandle.close,
          breakoutCandle: {
            open: latestCandle.open,
            high: latestCandle.high,
            low: latestCandle.low,
            close: latestCandle.close,
          },
          stopLoss: breakoutDirection === 'BULLISH' ? this.orbRange.low : this.orbRange.high,
        },
      };

      logSignal('ORB', result);
      this.logAnalysis(result);
      return result;
    } catch (error) {
      logger.error('ORB breakout check failed', { error: error.message });
      reasons.push(this.createReason('Error', 'fail', error.message));
      return { signal: null, score: 0, reasons };
    }
  }

  /**
   * Get current ORB range (for display/debugging)
   * @returns {Object|null} Current ORB range
   */
  getORBRange() {
    return this.orbRange;
  }

  /**
   * Check if ORB has been captured today
   * @returns {boolean}
   */
  isORBCaptured() {
    return this.orbCaptured;
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.orbRange = null;
    this.orbCaptured = false;
    this.signalSent = false;
    this.state = { orbRange: null, orbCaptured: false, signalSent: false };
  }

  /**
   * Legacy method: Reset ORB state (for compatibility)
   */
  resetORB() {
    this.reset();
  }

  /**
   * Get current state
   */
  getState() {
    return {
      ...super.getState(),
      orbRange: this.orbRange,
      orbCaptured: this.orbCaptured,
      signalSent: this.signalSent,
    };
  }

  /**
   * Legacy method: Check breakout (for compatibility)
   * @returns {Promise<Object|null>}
   */
  async checkBreakout() {
    const result = await this.analyze();
    if (result.signal) {
      return {
        strategy: this.name,
        direction: result.signal,
        signal: result.signal,
        spotPrice: result.data?.spotPrice,
        orbHigh: result.data?.orbHigh,
        orbLow: result.data?.orbLow,
        stopLoss: result.data?.stopLoss,
        breakoutCandle: result.data?.breakoutCandle,
        time: new Date(),
      };
    }
    return null;
  }

  /**
   * Mock check for testing (for compatibility)
   */
  checkBreakoutMock(mockOrbRange, mockLatestCandle) {
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
}

// Export singleton instance
const strategy = new ORBStrategy();

// Export with bound methods for compatibility
module.exports = {
  // Strategy instance methods
  analyze: (context) => strategy.analyze(context),
  getState: () => strategy.getState(),
  reset: () => strategy.reset(),
  isInTimeWindow: () => strategy.isInTimeWindow(),
  getTimeWindow: () => strategy.getTimeWindow(),

  // ORB-specific methods
  captureORBRange: () => strategy.captureORBRange(),
  getORBRange: () => strategy.getORBRange(),
  isORBCaptured: () => strategy.isORBCaptured(),

  // Legacy compatibility methods
  checkBreakout: () => strategy.checkBreakout(),
  resetORB: () => strategy.resetORB(),
  checkBreakoutMock: (a, b) => strategy.checkBreakoutMock(a, b),

  // Access to instance for engine registration
  _instance: strategy,
};
