/**
 * Pre-Expiry Momentum Strategy
 *
 * Time Window: 11:00 AM - 2:00 PM
 * Days: Thursday (weekly expiry) or day before monthly expiry
 * Max Score: 15 points
 *
 * Logic:
 * 1. Only active on expiry days
 * 2. Look for strong directional move with volume spike (1.5x average)
 * 3. Signal with ATM option
 * 4. Quick momentum play leveraging expiry-day volatility
 */

const BaseStrategy = require('../engine/baseStrategy');
const brokerService = require('../services/brokerService');
const { logger, logSignal } = require('../utils/logger');
const {
  isWithinTimeWindow,
  isExpiryDay,
  formatDateForKite,
  getTradingDaysAgo,
} = require('../utils/timeUtils');

class ExpiryMomentumStrategy extends BaseStrategy {
  constructor() {
    super('EXPIRY MOMENTUM', { start: '11:00', end: '14:00' }, 15);
    this.volumeBaseline = null;
    this.signalSent = false;
  }

  /**
   * Calculate average volume from candles
   * @param {Array} candles - Array of candles
   * @returns {number} Average volume
   */
  calculateAvgVolume(candles) {
    if (!candles || candles.length === 0) return 0;
    const totalVolume = candles.reduce((sum, c) => sum + (c.volume || 0), 0);
    return totalVolume / candles.length;
  }

  /**
   * Initialize volume baseline for the day
   * @returns {Promise<number>} Baseline volume
   */
  async initVolumeBaseline() {
    if (this.volumeBaseline) {
      return this.volumeBaseline;
    }

    try {
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
      this.volumeBaseline = this.calculateAvgVolume(historicalData);

      logger.info('Expiry strategy volume baseline initialized', {
        baseline: this.volumeBaseline,
        candleCount: historicalData.length,
      });

      return this.volumeBaseline;
    } catch (error) {
      logger.error('Failed to initialize volume baseline', { error: error.message });
      return 0;
    }
  }

  /**
   * Analyze market for expiry momentum setup
   * @param {Object} context - Market context
   * @returns {Promise<Object>} Analysis result
   */
  async analyze(context = {}) {
    this.checkDayReset();

    const reasons = [];
    let score = 0;
    let signal = null;

    try {
      // Only run on expiry days
      if (!isExpiryDay()) {
        return {
          signal: null,
          score: 0,
          reasons: [this.createReason('Expiry Day', 'fail', 'Not an expiry day (Thursday)')],
        };
      }

      reasons.push(this.createReason('Expiry Day', 'pass', 'Thursday weekly expiry'));
      score += 3;

      // Check time window
      if (!this.isInTimeWindow()) {
        return {
          signal: null,
          score: 3,
          reasons: [
            ...reasons,
            this.createReason('Time Window', 'fail', 'Outside expiry momentum window (11:00-2:00)'),
          ],
        };
      }

      // Don't send multiple signals
      if (this.signalSent) {
        return {
          signal: null,
          score: 0,
          reasons: [this.createReason('Signal Limit', 'neutral', 'Expiry momentum signal already sent today')],
        };
      }

      // Initialize baseline if needed
      if (!this.volumeBaseline) {
        await this.initVolumeBaseline();
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
        reasons.push(this.createReason('Data', 'fail', 'Insufficient data for momentum analysis'));
        return { signal: null, score, reasons };
      }

      // Look at last 3 candles for momentum
      const recentCandles = historicalData.slice(-3);
      const latestCandle = recentCandles[recentCandles.length - 1];

      // Calculate recent volume spike
      const recentAvgVolume = this.calculateAvgVolume(recentCandles);
      const volumeRatio = this.volumeBaseline > 0 ? recentAvgVolume / this.volumeBaseline : 0;

      // Check for volume spike (1.5x baseline)
      if (volumeRatio >= 1.5) {
        reasons.push(this.createReason('Volume Spike', 'pass', `${(volumeRatio * 100).toFixed(0)}% of baseline`));
        score += 4;
      } else if (volumeRatio >= 1.0) {
        reasons.push(this.createReason('Volume', 'neutral', `Volume at ${(volumeRatio * 100).toFixed(0)}% of baseline`));
        score += 1;
      } else {
        reasons.push(this.createReason('Volume', 'fail', `Low volume ${(volumeRatio * 100).toFixed(0)}%`));
        return {
          signal: null,
          score,
          reasons,
          data: { volumeRatio, isExpiry: true },
        };
      }

      // Check for directional move
      // Strong move = all 3 candles in same direction with good body ratio
      const allBullish = recentCandles.every(c => c.close > c.open);
      const allBearish = recentCandles.every(c => c.close < c.open);

      if (!allBullish && !allBearish) {
        reasons.push(this.createReason('Direction', 'fail', 'Mixed candle direction - no clear momentum'));
        return { signal: null, score, reasons, data: { volumeRatio, isExpiry: true } };
      }

      const moveDirection = allBullish ? 'BULLISH' : 'BEARISH';
      reasons.push(this.createReason('Direction', 'pass', `Strong ${moveDirection} momentum (3 consecutive candles)`));
      score += 4;

      // Calculate total move
      const moveStart = recentCandles[0].open;
      const moveEnd = latestCandle.close;
      const totalMove = Math.abs(moveEnd - moveStart);

      // Minimum move threshold (50 points in 15 minutes)
      if (totalMove < 50) {
        reasons.push(this.createReason('Move Size', 'fail', `Move only ${totalMove.toFixed(0)} points (need 50+)`));
        return { signal: null, score, reasons, data: { volumeRatio, totalMove, isExpiry: true } };
      }

      reasons.push(this.createReason('Move Size', 'pass', `${totalMove.toFixed(0)} point move`));
      score += 4;

      // Check A-Day alignment
      if (context.adayStatus?.isADay) {
        const alignsWithADay = (context.adayStatus.direction === 'BULLISH' && allBullish) ||
                              (context.adayStatus.direction === 'BEARISH' && allBearish);
        if (alignsWithADay) {
          reasons.push(this.createReason('A-Day Alignment', 'pass', `Aligns with A-Day (${context.adayStatus.direction})`));
        } else {
          reasons.push(this.createReason('A-Day Alignment', 'neutral', `Opposite to A-Day direction`));
        }
      }

      // Generate signal
      signal = allBullish ? 'BUY_CE' : 'BUY_PE';
      this.signalSent = true;

      const result = {
        signal,
        score,
        reasons,
        data: {
          spotPrice: latestCandle.close,
          volumeSpike: `${(volumeRatio * 100).toFixed(0)}%`,
          movePoints: totalMove.toFixed(0),
          stopLoss: allBullish
            ? Math.min(...recentCandles.map(c => c.low))
            : Math.max(...recentCandles.map(c => c.high)),
          isExpiry: true,
        },
      };

      logSignal('EXPIRY_MOMENTUM', result);
      this.logAnalysis(result);
      return result;
    } catch (error) {
      logger.error('Expiry momentum check failed', { error: error.message });
      reasons.push(this.createReason('Error', 'fail', error.message));
      return { signal: null, score: 0, reasons };
    }
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.volumeBaseline = null;
    this.signalSent = false;
    this.state = { volumeBaseline: null, signalSent: false, isExpiry: isExpiryDay() };
  }

  /**
   * Get current state (for compatibility)
   */
  getState() {
    return {
      ...super.getState(),
      volumeBaseline: this.volumeBaseline,
      signalSent: this.signalSent,
      isExpiry: isExpiryDay(),
    };
  }

  /**
   * Legacy method: check momentum (for compatibility)
   * @returns {Promise<Object|null>}
   */
  async checkMomentum() {
    const result = await this.analyze();
    if (result.signal) {
      return {
        strategy: this.name,
        direction: result.signal,
        signal: result.signal,
        spotPrice: result.data?.spotPrice,
        volumeSpike: result.data?.volumeSpike,
        movePoints: result.data?.movePoints,
        stopLoss: result.data?.stopLoss,
        time: new Date(),
        isExpiry: true,
      };
    }
    return null;
  }

  /**
   * Legacy method: init volume baseline (for compatibility)
   */
  async initVolumeBaselineLegacy() {
    return this.initVolumeBaseline();
  }

  /**
   * Mock check for testing (for compatibility)
   */
  checkMomentumMock(mockCandles, mockBaseline) {
    if (mockCandles.length < 3) return null;

    const recentCandles = mockCandles.slice(-3);
    const latestCandle = recentCandles[recentCandles.length - 1];

    const recentAvgVolume = this.calculateAvgVolume(recentCandles);
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
}

// Export singleton instance
const strategy = new ExpiryMomentumStrategy();

// Export with bound methods for compatibility
module.exports = {
  // Strategy instance methods
  analyze: (context) => strategy.analyze(context),
  getState: () => strategy.getState(),
  reset: () => strategy.reset(),
  isInTimeWindow: () => strategy.isInTimeWindow(),
  getTimeWindow: () => strategy.getTimeWindow(),

  // Expiry-specific methods
  initVolumeBaseline: () => strategy.initVolumeBaseline(),

  // Legacy compatibility methods
  checkMomentum: () => strategy.checkMomentum(),
  checkMomentumMock: (a, b) => strategy.checkMomentumMock(a, b),

  // Access to instance for engine registration
  _instance: strategy,
};
