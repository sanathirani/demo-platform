/**
 * VWAP (Volume Weighted Average Price) Strategy
 *
 * Time Window: 10:00 AM - 2:30 PM
 * Max Score: 15 points
 *
 * Logic:
 * 1. Calculate VWAP from intraday data
 * 2. Detect crossovers with volume confirmation
 * 3. Signal on confirmed crossover with strong volume
 */

const BaseStrategy = require('../engine/baseStrategy');
const brokerService = require('../services/brokerService');
const { logger } = require('../utils/logger');
const { formatDateForKite } = require('../utils/timeUtils');

class VWAPStrategy extends BaseStrategy {
  constructor() {
    super('VWAP CROSSOVER', { start: '10:00', end: '14:30' }, 15);
    this.vwap = null;
    this.lastCrossover = null;
    this.signalSent = false;
  }

  /**
   * Calculate VWAP from candle data
   * @param {Array} candles - Array of OHLCV candles with volume
   * @returns {number} VWAP value
   */
  calculateVWAP(candles) {
    if (!candles || candles.length === 0) return null;

    let cumulativeTPV = 0; // Typical Price * Volume
    let cumulativeVolume = 0;

    for (const candle of candles) {
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      const volume = candle.volume || 0;

      cumulativeTPV += typicalPrice * volume;
      cumulativeVolume += volume;
    }

    if (cumulativeVolume === 0) return null;

    return cumulativeTPV / cumulativeVolume;
  }

  /**
   * Detect VWAP crossover
   * @param {Array} candles - Recent candles (at least 3)
   * @param {number} vwap - Current VWAP
   * @returns {Object} Crossover info
   */
  detectCrossover(candles, vwap) {
    if (!candles || candles.length < 3 || !vwap) {
      return { hasCrossover: false };
    }

    const prevCandle = candles[candles.length - 2];
    const currCandle = candles[candles.length - 1];

    // Bullish crossover: previous close below VWAP, current close above
    if (prevCandle.close < vwap && currCandle.close > vwap) {
      return {
        hasCrossover: true,
        direction: 'BULLISH',
        crossoverPrice: vwap,
        strength: ((currCandle.close - vwap) / vwap) * 100,
      };
    }

    // Bearish crossover: previous close above VWAP, current close below
    if (prevCandle.close > vwap && currCandle.close < vwap) {
      return {
        hasCrossover: true,
        direction: 'BEARISH',
        crossoverPrice: vwap,
        strength: ((vwap - currCandle.close) / vwap) * 100,
      };
    }

    return {
      hasCrossover: false,
      pricePosition: currCandle.close > vwap ? 'ABOVE' : 'BELOW',
      distanceFromVWAP: ((currCandle.close - vwap) / vwap) * 100,
    };
  }

  /**
   * Analyze market for VWAP signals
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
          reasons: [this.createReason('Time Window', 'fail', 'Outside VWAP strategy time window')],
        };
      }

      // Don't send multiple signals
      if (this.signalSent) {
        return {
          signal: null,
          score: 0,
          reasons: [this.createReason('Signal Limit', 'neutral', 'VWAP signal already sent today')],
        };
      }

      const instrumentToken = await brokerService.getNiftyInstrumentToken();
      const today = formatDateForKite(new Date());

      // Get 5-minute candles for VWAP calculation
      const historicalData = await brokerService.getHistoricalData(
        instrumentToken,
        '5minute',
        today,
        today
      );

      if (!historicalData || historicalData.length < 10) {
        reasons.push(this.createReason('Data', 'fail', 'Insufficient data for VWAP calculation'));
        return { signal: null, score: 0, reasons };
      }

      // Calculate VWAP
      this.vwap = this.calculateVWAP(historicalData);

      if (!this.vwap) {
        reasons.push(this.createReason('VWAP', 'fail', 'Unable to calculate VWAP'));
        return { signal: null, score: 0, reasons };
      }

      const latestCandle = historicalData[historicalData.length - 1];
      const currentPrice = latestCandle.close;

      // Detect crossover
      const crossover = this.detectCrossover(historicalData.slice(-5), this.vwap);

      if (!crossover.hasCrossover) {
        // Check price position relative to VWAP for context
        const pricePosition = currentPrice > this.vwap ? 'above' : 'below';
        const distance = Math.abs(((currentPrice - this.vwap) / this.vwap) * 100).toFixed(2);

        reasons.push(this.createReason(
          'VWAP Position',
          'neutral',
          `Price ${pricePosition} VWAP by ${distance}%, no crossover`
        ));

        // Small score for being in right position with A-Day
        if (context.adayStatus?.isADay) {
          const alignsWithADay = (context.adayStatus.direction === 'BULLISH' && currentPrice > this.vwap) ||
                                (context.adayStatus.direction === 'BEARISH' && currentPrice < this.vwap);
          if (alignsWithADay) {
            score = 5;
            reasons.push(this.createReason('A-Day Alignment', 'pass', 'Price position aligns with A-Day direction'));
          }
        }

        return { signal: null, score, reasons, data: { vwap: this.vwap, currentPrice } };
      }

      // We have a crossover - now validate with volume
      reasons.push(this.createReason(
        'VWAP Crossover',
        'pass',
        `${crossover.direction} crossover detected at ${this.vwap.toFixed(2)}`
      ));
      score += 8;

      // Check volume confirmation
      const recentCandles = historicalData.slice(-3);
      const avgVolume = historicalData.slice(0, -3).reduce((sum, c) => sum + (c.volume || 0), 0) /
                        Math.max(1, historicalData.length - 3);
      const recentAvgVolume = recentCandles.reduce((sum, c) => sum + (c.volume || 0), 0) / 3;
      const volumeRatio = recentAvgVolume / avgVolume;

      if (volumeRatio >= 1.5) {
        reasons.push(this.createReason('Volume Confirmation', 'pass', `Volume spike ${(volumeRatio * 100).toFixed(0)}%`));
        score += 5;
      } else if (volumeRatio >= 1.0) {
        reasons.push(this.createReason('Volume', 'neutral', `Volume at ${(volumeRatio * 100).toFixed(0)}% of average`));
        score += 2;
      } else {
        reasons.push(this.createReason('Volume', 'fail', `Low volume ${(volumeRatio * 100).toFixed(0)}%`));
      }

      // Check A-Day alignment
      if (context.adayStatus?.isADay) {
        const alignsWithADay = (context.adayStatus.direction === 'BULLISH' && crossover.direction === 'BULLISH') ||
                              (context.adayStatus.direction === 'BEARISH' && crossover.direction === 'BEARISH');
        if (alignsWithADay) {
          reasons.push(this.createReason('A-Day Alignment', 'pass', `Crossover aligns with A-Day (${context.adayStatus.direction})`));
        } else {
          reasons.push(this.createReason('A-Day Alignment', 'neutral', `Crossover opposite to A-Day direction`));
        }
      }

      // Generate signal if score is sufficient
      if (score >= 10) {
        signal = crossover.direction === 'BULLISH' ? 'BUY_CE' : 'BUY_PE';
        this.lastCrossover = crossover;
        this.signalSent = true;

        logger.info('VWAP crossover signal generated', {
          direction: signal,
          vwap: this.vwap,
          currentPrice,
          score,
        });
      }

      const result = {
        signal,
        score,
        reasons,
        data: {
          vwap: this.vwap,
          currentPrice,
          spotPrice: currentPrice,
          crossover,
          stopLoss: crossover.direction === 'BULLISH'
            ? Math.min(...recentCandles.map(c => c.low))
            : Math.max(...recentCandles.map(c => c.high)),
        },
      };

      this.logAnalysis(result);
      return result;
    } catch (error) {
      logger.error('VWAP strategy analysis failed', { error: error.message });
      reasons.push(this.createReason('Error', 'fail', error.message));
      return { signal: null, score: 0, reasons };
    }
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.vwap = null;
    this.lastCrossover = null;
    this.signalSent = false;
    this.state = { vwap: null, lastCrossover: null, signalSent: false };
  }

  /**
   * Get current state
   */
  getState() {
    return {
      ...super.getState(),
      vwap: this.vwap,
      lastCrossover: this.lastCrossover,
      signalSent: this.signalSent,
    };
  }
}

module.exports = new VWAPStrategy();
