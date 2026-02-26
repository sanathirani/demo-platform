/**
 * Pullback Continuation Strategy
 *
 * Time Window: 10:15 AM - 1:30 PM
 * Max Score: 15 points
 *
 * Logic:
 * 1. Determine trend from the first hour (9:15-10:15)
 * 2. Wait for a pullback to 20 EMA or swing level
 * 3. Signal when price breaks above the pullback high (bullish) or below pullback low (bearish)
 * 4. Direction follows the first-hour trend
 */

const BaseStrategy = require('../engine/baseStrategy');
const brokerService = require('../services/brokerService');
const { logger, logSignal } = require('../utils/logger');
const { formatDateForKite, getISTNow, isWithinTimeWindow } = require('../utils/timeUtils');

class PullbackStrategy extends BaseStrategy {
  constructor() {
    super('PULLBACK CONTINUATION', { start: '10:15', end: '13:30' }, 15);
    this.firstHourTrend = null;
    this.trendDetermined = false;
    this.pullbackDetected = false;
    this.pullbackLevel = null;
    this.signalSent = false;
  }

  /**
   * Calculate EMA
   * @param {number[]} prices - Array of closing prices
   * @param {number} period - EMA period
   * @returns {number[]} EMA values
   */
  calculateEMA(prices, period) {
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
   * @param {Array} candles - 5-minute candles for the day
   * @returns {string} 'BULLISH', 'BEARISH', or 'NEUTRAL'
   */
  determineFirstHourTrendFromCandles(candles) {
    // First hour = 12 five-minute candles (9:15 to 10:15)
    const firstHourCandles = candles.slice(0, 12);

    if (firstHourCandles.length < 12) {
      return null;
    }

    const openPrice = firstHourCandles[0].open;
    const closePrice = firstHourCandles[firstHourCandles.length - 1].close;
    const highPrice = Math.max(...firstHourCandles.map(c => c.high));
    const lowPrice = Math.min(...firstHourCandles.map(c => c.low));

    const change = closePrice - openPrice;
    const range = highPrice - lowPrice;

    const trendThreshold = range * 0.3; // 30% of range

    if (change > trendThreshold) {
      return 'BULLISH';
    } else if (change < -trendThreshold) {
      return 'BEARISH';
    }
    return 'NEUTRAL';
  }

  /**
   * Analyze market for pullback setup
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
          reasons: [this.createReason('Time Window', 'fail', 'Outside pullback time window (10:15-1:30)')],
        };
      }

      // Don't send multiple signals
      if (this.signalSent) {
        return {
          signal: null,
          score: 0,
          reasons: [this.createReason('Signal Limit', 'neutral', 'Pullback signal already sent today')],
        };
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
        reasons.push(this.createReason('Data', 'fail', 'Insufficient data for pullback analysis'));
        return { signal: null, score: 0, reasons };
      }

      // Determine first hour trend if not done
      if (!this.trendDetermined) {
        this.firstHourTrend = this.determineFirstHourTrendFromCandles(historicalData);
        if (this.firstHourTrend) {
          this.trendDetermined = true;
          logger.info('First hour trend determined', { trend: this.firstHourTrend });
        }
      }

      if (!this.firstHourTrend || this.firstHourTrend === 'NEUTRAL') {
        reasons.push(this.createReason('Trend', 'neutral', 'First hour trend is neutral - no pullback setup'));
        return { signal: null, score: 0, reasons };
      }

      reasons.push(this.createReason('First Hour Trend', 'pass', `${this.firstHourTrend} trend established`));
      score += 5;

      // Calculate 20 EMA
      const closePrices = historicalData.map(c => c.close);
      const ema20 = this.calculateEMA(closePrices, 20);
      const currentEMA = ema20[ema20.length - 1];

      if (!currentEMA) {
        reasons.push(this.createReason('EMA', 'fail', 'Unable to calculate EMA'));
        return { signal: null, score, reasons };
      }

      // Get recent candles
      const recentCandles = historicalData.slice(-5);
      const latestCandle = recentCandles[recentCandles.length - 1];
      const currentPrice = latestCandle.close;

      // Check for pullback and bounce/breakdown
      if (this.firstHourTrend === 'BULLISH') {
        // Look for pullback to EMA and then bounce
        const pullbackToEMA = recentCandles.some(c => c.low <= currentEMA * 1.002);

        if (pullbackToEMA && !this.pullbackDetected) {
          const pullbackLow = Math.min(...recentCandles.map(c => c.low));
          this.pullbackLevel = {
            low: pullbackLow,
            ema: currentEMA,
          };
          this.pullbackDetected = true;
          logger.info('Bullish pullback detected', this.pullbackLevel);
        }

        if (this.pullbackDetected && this.pullbackLevel) {
          reasons.push(this.createReason('Pullback', 'pass', `Pullback to EMA detected (low: ${this.pullbackLevel.low.toFixed(0)})`));
          score += 3;

          const pullbackHigh = Math.max(...recentCandles.slice(0, -1).map(c => c.high));

          // Check for bullish continuation
          if (latestCandle.close > pullbackHigh && latestCandle.close > latestCandle.open) {
            signal = 'BUY_CE';
            reasons.push(this.createReason('Breakout', 'pass', `Bullish breakout above pullback high (${pullbackHigh.toFixed(0)})`));
            score += 5;
          } else {
            reasons.push(this.createReason('Breakout', 'neutral', 'Waiting for breakout confirmation'));
          }
        } else {
          reasons.push(this.createReason('Pullback', 'neutral', 'Waiting for pullback to EMA'));
        }

      } else if (this.firstHourTrend === 'BEARISH') {
        // Look for pullback to EMA and then breakdown
        const pullbackToEMA = recentCandles.some(c => c.high >= currentEMA * 0.998);

        if (pullbackToEMA && !this.pullbackDetected) {
          const pullbackHigh = Math.max(...recentCandles.map(c => c.high));
          this.pullbackLevel = {
            high: pullbackHigh,
            ema: currentEMA,
          };
          this.pullbackDetected = true;
          logger.info('Bearish pullback detected', this.pullbackLevel);
        }

        if (this.pullbackDetected && this.pullbackLevel) {
          reasons.push(this.createReason('Pullback', 'pass', `Pullback to EMA detected (high: ${this.pullbackLevel.high.toFixed(0)})`));
          score += 3;

          const pullbackLow = Math.min(...recentCandles.slice(0, -1).map(c => c.low));

          // Check for bearish continuation
          if (latestCandle.close < pullbackLow && latestCandle.close < latestCandle.open) {
            signal = 'BUY_PE';
            reasons.push(this.createReason('Breakdown', 'pass', `Bearish breakdown below pullback low (${pullbackLow.toFixed(0)})`));
            score += 5;
          } else {
            reasons.push(this.createReason('Breakdown', 'neutral', 'Waiting for breakdown confirmation'));
          }
        } else {
          reasons.push(this.createReason('Pullback', 'neutral', 'Waiting for pullback to EMA'));
        }
      }

      // Check A-Day alignment
      if (signal && context.adayStatus?.isADay) {
        const alignsWithADay = (context.adayStatus.direction === 'BULLISH' && signal === 'BUY_CE') ||
                              (context.adayStatus.direction === 'BEARISH' && signal === 'BUY_PE');
        if (alignsWithADay) {
          score += 2;
          reasons.push(this.createReason('A-Day Alignment', 'pass', `Aligns with A-Day (${context.adayStatus.direction})`));
        }
      }

      if (signal) {
        this.signalSent = true;
      }

      const result = {
        signal,
        score,
        reasons,
        data: {
          firstHourTrend: this.firstHourTrend,
          ema20: currentEMA,
          spotPrice: currentPrice,
          pullbackLevel: this.pullbackLevel,
          stopLoss: this.firstHourTrend === 'BULLISH'
            ? this.pullbackLevel?.low || Math.min(...recentCandles.map(c => c.low))
            : this.pullbackLevel?.high || Math.max(...recentCandles.map(c => c.high)),
        },
      };

      if (signal) {
        logSignal('PULLBACK', result);
        this.logAnalysis(result);
      }

      return result;
    } catch (error) {
      logger.error('Pullback check failed', { error: error.message });
      reasons.push(this.createReason('Error', 'fail', error.message));
      return { signal: null, score: 0, reasons };
    }
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.firstHourTrend = null;
    this.trendDetermined = false;
    this.pullbackDetected = false;
    this.pullbackLevel = null;
    this.signalSent = false;
    this.state = {
      firstHourTrend: null,
      trendDetermined: false,
      pullbackDetected: false,
      pullbackLevel: null,
      signalSent: false,
    };
  }

  /**
   * Get current state (for compatibility)
   */
  getState() {
    return {
      ...super.getState(),
      firstHourTrend: this.firstHourTrend,
      trendDetermined: this.trendDetermined,
      pullbackDetected: this.pullbackDetected,
      pullbackLevel: this.pullbackLevel,
    };
  }

  /**
   * Legacy method: check pullback (for compatibility)
   * @returns {Promise<Object|null>}
   */
  async checkPullback() {
    const result = await this.analyze();
    if (result.signal) {
      return {
        strategy: this.name,
        direction: result.signal,
        signal: result.signal,
        spotPrice: result.data?.spotPrice,
        trend: result.data?.firstHourTrend,
        ema20: result.data?.ema20,
        pullbackLow: result.data?.pullbackLevel?.low,
        pullbackHigh: result.data?.pullbackLevel?.high,
        stopLoss: result.data?.stopLoss,
        time: new Date(),
      };
    }
    return null;
  }

  /**
   * Legacy method: determine first hour trend (for compatibility)
   */
  async determineFirstHourTrend() {
    const instrumentToken = await brokerService.getNiftyInstrumentToken();
    const today = formatDateForKite(new Date());

    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '5minute',
      today,
      today
    );

    this.firstHourTrend = this.determineFirstHourTrendFromCandles(historicalData);
    if (this.firstHourTrend) {
      this.trendDetermined = true;
    }
    return this.firstHourTrend;
  }
}

// Export singleton instance
const strategy = new PullbackStrategy();

// Export with bound methods for compatibility
module.exports = {
  // Strategy instance methods
  analyze: (context) => strategy.analyze(context),
  getState: () => strategy.getState(),
  reset: () => strategy.reset(),
  isInTimeWindow: () => strategy.isInTimeWindow(),
  getTimeWindow: () => strategy.getTimeWindow(),

  // Legacy compatibility methods
  determineFirstHourTrend: () => strategy.determineFirstHourTrend(),
  checkPullback: () => strategy.checkPullback(),
  calculateEMA: (prices, period) => strategy.calculateEMA(prices, period),

  // Access to instance for engine registration
  _instance: strategy,
};
