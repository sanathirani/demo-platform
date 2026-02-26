/**
 * Support/Resistance (S/R) Strategy
 *
 * Time Window: 9:45 AM - 2:30 PM
 * Max Score: 15 points
 *
 * Tracks key levels:
 * - Previous Day High (PDH)
 * - Previous Day Low (PDL)
 * - Today's Open
 * - Pivot Points (P, R1, R2, S1, S2)
 * - Round Numbers (100-point intervals)
 *
 * Detects breakouts and rejections at these levels.
 */

const BaseStrategy = require('../engine/baseStrategy');
const brokerService = require('../services/brokerService');
const { logger } = require('../utils/logger');
const { formatDateForKite, getPreviousTradingDay } = require('../utils/timeUtils');

class SRStrategy extends BaseStrategy {
  constructor() {
    super('S/R BREAKOUT', { start: '09:45', end: '14:30' }, 15);
    this.levels = null;
    this.breakoutDetected = null;
    this.signalSent = false;
  }

  /**
   * Calculate pivot points
   * @param {number} high - Previous day high
   * @param {number} low - Previous day low
   * @param {number} close - Previous day close
   * @returns {Object} Pivot points
   */
  calculatePivotPoints(high, low, close) {
    const pivot = (high + low + close) / 3;
    const r1 = (2 * pivot) - low;
    const r2 = pivot + (high - low);
    const r3 = high + 2 * (pivot - low);
    const s1 = (2 * pivot) - high;
    const s2 = pivot - (high - low);
    const s3 = low - 2 * (high - pivot);

    return { pivot, r1, r2, r3, s1, s2, s3 };
  }

  /**
   * Get nearest round number levels
   * @param {number} price - Current price
   * @param {number} interval - Round number interval (default 100)
   * @returns {Object} { nearestAbove, nearestBelow }
   */
  getNearestRoundNumbers(price, interval = 100) {
    const nearestBelow = Math.floor(price / interval) * interval;
    const nearestAbove = nearestBelow + interval;
    return { nearestAbove, nearestBelow };
  }

  /**
   * Initialize key levels for the day
   * @returns {Promise<Object>} Key levels
   */
  async initializeLevels() {
    if (this.levels) return this.levels;

    try {
      const instrumentToken = await brokerService.getNiftyInstrumentToken();
      const prevDay = getPreviousTradingDay();
      const today = formatDateForKite(new Date());

      // Get previous day OHLC
      const prevDayData = await brokerService.getHistoricalData(
        instrumentToken,
        'day',
        formatDateForKite(prevDay),
        formatDateForKite(prevDay)
      );

      if (!prevDayData || prevDayData.length === 0) {
        throw new Error('Previous day data not available');
      }

      const prevCandle = prevDayData[0];
      const pdh = prevCandle.high;
      const pdl = prevCandle.low;
      const pdc = prevCandle.close;

      // Calculate pivot points
      const pivots = this.calculatePivotPoints(pdh, pdl, pdc);

      // Get today's open
      const todayData = await brokerService.getHistoricalData(
        instrumentToken,
        '15minute',
        today,
        today
      );

      const todayOpen = todayData && todayData.length > 0 ? todayData[0].open : null;

      // Get round numbers around current price
      const currentPrice = todayData && todayData.length > 0
        ? todayData[todayData.length - 1].close
        : pdc;

      const roundNumbers = this.getNearestRoundNumbers(currentPrice, 100);

      this.levels = {
        pdh,
        pdl,
        pdc,
        todayOpen,
        ...pivots,
        roundAbove: roundNumbers.nearestAbove,
        roundBelow: roundNumbers.nearestBelow,
      };

      logger.info('S/R levels initialized', this.levels);
      return this.levels;
    } catch (error) {
      logger.error('Failed to initialize S/R levels', { error: error.message });
      return null;
    }
  }

  /**
   * Check if price is near a level
   * @param {number} price - Current price
   * @param {number} level - Level to check
   * @param {number} threshold - Threshold in points (default 10)
   * @returns {boolean}
   */
  isNearLevel(price, level, threshold = 10) {
    return Math.abs(price - level) <= threshold;
  }

  /**
   * Detect breakout or rejection at levels
   * @param {Array} candles - Recent candles
   * @param {Object} levels - Key levels
   * @returns {Object|null} Breakout/rejection info
   */
  detectLevelInteraction(candles, levels) {
    if (!candles || candles.length < 3 || !levels) {
      return null;
    }

    const latestCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    const currentPrice = latestCandle.close;

    // Define key levels with names
    const keyLevels = [
      { name: 'PDH', level: levels.pdh, type: 'resistance' },
      { name: 'PDL', level: levels.pdl, type: 'support' },
      { name: 'R1', level: levels.r1, type: 'resistance' },
      { name: 'R2', level: levels.r2, type: 'resistance' },
      { name: 'S1', level: levels.s1, type: 'support' },
      { name: 'S2', level: levels.s2, type: 'support' },
      { name: 'Pivot', level: levels.pivot, type: 'pivot' },
      { name: 'Round Number', level: levels.roundAbove, type: 'resistance' },
      { name: 'Round Number', level: levels.roundBelow, type: 'support' },
    ].filter(l => l.level);

    // Check for breakouts
    for (const { name, level, type } of keyLevels) {
      // Bullish breakout (resistance break)
      if (type === 'resistance' && prevCandle.close < level && currentPrice > level) {
        // Confirm with close above level
        if (currentPrice > level + 5) {
          return {
            type: 'BREAKOUT',
            direction: 'BULLISH',
            levelName: name,
            levelPrice: level,
            breakoutPrice: currentPrice,
            strength: currentPrice - level,
          };
        }
      }

      // Bearish breakout (support break)
      if (type === 'support' && prevCandle.close > level && currentPrice < level) {
        if (currentPrice < level - 5) {
          return {
            type: 'BREAKOUT',
            direction: 'BEARISH',
            levelName: name,
            levelPrice: level,
            breakoutPrice: currentPrice,
            strength: level - currentPrice,
          };
        }
      }

      // Bullish rejection (support hold)
      if (type === 'support' && this.isNearLevel(latestCandle.low, level, 15)) {
        if (currentPrice > latestCandle.low + 20 && currentPrice > prevCandle.close) {
          return {
            type: 'REJECTION',
            direction: 'BULLISH',
            levelName: name,
            levelPrice: level,
            rejectionLow: latestCandle.low,
            bounce: currentPrice - latestCandle.low,
          };
        }
      }

      // Bearish rejection (resistance hold)
      if (type === 'resistance' && this.isNearLevel(latestCandle.high, level, 15)) {
        if (currentPrice < latestCandle.high - 20 && currentPrice < prevCandle.close) {
          return {
            type: 'REJECTION',
            direction: 'BEARISH',
            levelName: name,
            levelPrice: level,
            rejectionHigh: latestCandle.high,
            drop: latestCandle.high - currentPrice,
          };
        }
      }
    }

    return null;
  }

  /**
   * Analyze market for S/R signals
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
          reasons: [this.createReason('Time Window', 'fail', 'Outside S/R strategy time window')],
        };
      }

      // Don't send multiple signals
      if (this.signalSent) {
        return {
          signal: null,
          score: 0,
          reasons: [this.createReason('Signal Limit', 'neutral', 'S/R signal already sent today')],
        };
      }

      // Initialize levels
      const levels = await this.initializeLevels();
      if (!levels) {
        reasons.push(this.createReason('Levels', 'fail', 'Unable to initialize S/R levels'));
        return { signal: null, score: 0, reasons };
      }

      const instrumentToken = await brokerService.getNiftyInstrumentToken();
      const today = formatDateForKite(new Date());

      // Get today's candles
      const historicalData = await brokerService.getHistoricalData(
        instrumentToken,
        '5minute',
        today,
        today
      );

      if (!historicalData || historicalData.length < 5) {
        reasons.push(this.createReason('Data', 'fail', 'Insufficient data for S/R analysis'));
        return { signal: null, score: 0, reasons };
      }

      const latestCandle = historicalData[historicalData.length - 1];
      const currentPrice = latestCandle.close;

      // Detect level interaction
      const interaction = this.detectLevelInteraction(historicalData.slice(-5), levels);

      if (!interaction) {
        // Check proximity to key levels for context
        const nearPDH = this.isNearLevel(currentPrice, levels.pdh, 20);
        const nearPDL = this.isNearLevel(currentPrice, levels.pdl, 20);
        const nearPivot = this.isNearLevel(currentPrice, levels.pivot, 20);

        if (nearPDH || nearPDL || nearPivot) {
          reasons.push(this.createReason(
            'Level Proximity',
            'neutral',
            `Price near ${nearPDH ? 'PDH' : nearPDL ? 'PDL' : 'Pivot'} - watching for breakout`
          ));
          score = 3;
        } else {
          reasons.push(this.createReason('S/R Levels', 'neutral', 'No significant level interaction'));
        }

        return {
          signal: null,
          score,
          reasons,
          data: { levels, currentPrice },
        };
      }

      // We have a level interaction
      this.breakoutDetected = interaction;

      if (interaction.type === 'BREAKOUT') {
        reasons.push(this.createReason(
          `${interaction.levelName} Breakout`,
          'pass',
          `${interaction.direction} breakout of ${interaction.levelName} (${interaction.levelPrice})`
        ));
        score += 10;
      } else {
        reasons.push(this.createReason(
          `${interaction.levelName} Rejection`,
          'pass',
          `${interaction.direction} rejection at ${interaction.levelName} (${interaction.levelPrice})`
        ));
        score += 8;
      }

      // Check A-Day alignment
      if (context.adayStatus?.isADay) {
        const alignsWithADay = (context.adayStatus.direction === 'BULLISH' && interaction.direction === 'BULLISH') ||
                              (context.adayStatus.direction === 'BEARISH' && interaction.direction === 'BEARISH');
        if (alignsWithADay) {
          reasons.push(this.createReason('A-Day Alignment', 'pass', `Aligns with A-Day (${context.adayStatus.direction})`));
          score += 3;
        } else {
          reasons.push(this.createReason('A-Day Alignment', 'neutral', `Opposite to A-Day direction`));
        }
      }

      // Check trend confirmation
      if (context.trendAnalysis?.direction) {
        const alignsWithTrend = (context.trendAnalysis.direction.includes('BULLISH') && interaction.direction === 'BULLISH') ||
                                (context.trendAnalysis.direction.includes('BEARISH') && interaction.direction === 'BEARISH');
        if (alignsWithTrend) {
          reasons.push(this.createReason('Trend Confirmation', 'pass', `Aligns with ${context.trendAnalysis.direction} trend`));
          score += 2;
        }
      }

      // Generate signal if score is sufficient
      if (score >= 10) {
        signal = interaction.direction === 'BULLISH' ? 'BUY_CE' : 'BUY_PE';
        this.signalSent = true;

        logger.info('S/R signal generated', {
          direction: signal,
          interaction,
          score,
        });
      }

      const recentCandles = historicalData.slice(-5);
      const result = {
        signal,
        score,
        reasons,
        data: {
          levels,
          currentPrice,
          spotPrice: currentPrice,
          interaction,
          stopLoss: interaction.direction === 'BULLISH'
            ? Math.min(...recentCandles.map(c => c.low))
            : Math.max(...recentCandles.map(c => c.high)),
        },
      };

      this.logAnalysis(result);
      return result;
    } catch (error) {
      logger.error('S/R strategy analysis failed', { error: error.message });
      reasons.push(this.createReason('Error', 'fail', error.message));
      return { signal: null, score: 0, reasons };
    }
  }

  /**
   * Get current key levels
   * @returns {Object|null}
   */
  getLevels() {
    return this.levels;
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.levels = null;
    this.breakoutDetected = null;
    this.signalSent = false;
    this.state = { levels: null, breakoutDetected: null, signalSent: false };
  }

  /**
   * Get current state
   */
  getState() {
    return {
      ...super.getState(),
      levels: this.levels,
      breakoutDetected: this.breakoutDetected,
      signalSent: this.signalSent,
    };
  }
}

module.exports = new SRStrategy();
