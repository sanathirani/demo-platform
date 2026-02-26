/**
 * Day Behavior Strategy
 *
 * Time Window: 10:15 AM - 2:00 PM
 * Max Score: 10 points
 *
 * Logic:
 * 1. Compare today's action to A-Day direction
 * 2. Track gap analysis, range expansion, momentum
 * 3. Signal when current behavior strongly aligns with A-Day
 */

const BaseStrategy = require('../engine/baseStrategy');
const brokerService = require('../services/brokerService');
const { logger } = require('../utils/logger');
const { formatDateForKite, getPreviousTradingDay } = require('../utils/timeUtils');

class DayBehaviorStrategy extends BaseStrategy {
  constructor() {
    super('DAY BEHAVIOR', { start: '10:15', end: '14:00' }, 10);
    this.dayMetrics = null;
    this.signalSent = false;
  }

  /**
   * Calculate day behavior metrics
   * @param {Array} todayCandles - Today's candles
   * @param {Object} prevDayData - Previous day OHLC
   * @returns {Object} Day behavior metrics
   */
  calculateDayMetrics(todayCandles, prevDayData) {
    if (!todayCandles || todayCandles.length === 0 || !prevDayData) {
      return null;
    }

    const todayOpen = todayCandles[0].open;
    const prevClose = prevDayData.close;
    const prevHigh = prevDayData.high;
    const prevLow = prevDayData.low;
    const prevRange = prevHigh - prevLow;

    // Current price
    const latestCandle = todayCandles[todayCandles.length - 1];
    const currentPrice = latestCandle.close;

    // Today's range so far
    const todayHigh = Math.max(...todayCandles.map(c => c.high));
    const todayLow = Math.min(...todayCandles.map(c => c.low));
    const todayRange = todayHigh - todayLow;

    // Gap analysis
    const gap = todayOpen - prevClose;
    const gapPercent = (gap / prevClose) * 100;
    const gapType = gap > 20 ? 'GAP_UP' : gap < -20 ? 'GAP_DOWN' : 'NO_GAP';

    // Gap fill status
    let gapFilled = false;
    if (gapType === 'GAP_UP' && todayLow <= prevClose) {
      gapFilled = true;
    } else if (gapType === 'GAP_DOWN' && todayHigh >= prevClose) {
      gapFilled = true;
    }

    // Range expansion
    const rangeRatio = todayRange / prevRange;
    const rangeExpanding = rangeRatio > 0.7;

    // Day direction (from open)
    const dayChange = currentPrice - todayOpen;
    const dayChangePercent = (dayChange / todayOpen) * 100;
    const dayDirection = dayChange > 20 ? 'BULLISH' : dayChange < -20 ? 'BEARISH' : 'NEUTRAL';

    // Momentum (last few candles)
    const recentCandles = todayCandles.slice(-6);
    const recentMomentum = this.calculateMomentum(recentCandles);

    // Above/below previous day levels
    const abovePDH = currentPrice > prevHigh;
    const belowPDL = currentPrice < prevLow;
    const inPrevRange = currentPrice >= prevLow && currentPrice <= prevHigh;

    return {
      todayOpen,
      currentPrice,
      prevClose,
      prevHigh,
      prevLow,
      prevRange,
      todayHigh,
      todayLow,
      todayRange,
      gap,
      gapPercent,
      gapType,
      gapFilled,
      rangeRatio,
      rangeExpanding,
      dayChange,
      dayChangePercent,
      dayDirection,
      recentMomentum,
      abovePDH,
      belowPDL,
      inPrevRange,
    };
  }

  /**
   * Calculate recent momentum
   * @param {Array} candles - Recent candles
   * @returns {Object} Momentum metrics
   */
  calculateMomentum(candles) {
    if (!candles || candles.length < 3) {
      return { direction: 'NEUTRAL', strength: 0 };
    }

    const closes = candles.map(c => c.close);
    const firstClose = closes[0];
    const lastClose = closes[closes.length - 1];
    const change = lastClose - firstClose;

    // Count bullish vs bearish candles
    let bullishCount = 0;
    let bearishCount = 0;
    for (const candle of candles) {
      if (candle.close > candle.open) bullishCount++;
      else if (candle.close < candle.open) bearishCount++;
    }

    // Determine momentum
    let direction = 'NEUTRAL';
    let strength = 0;

    if (bullishCount >= candles.length * 0.7) {
      direction = 'BULLISH';
      strength = (bullishCount / candles.length) * 100;
    } else if (bearishCount >= candles.length * 0.7) {
      direction = 'BEARISH';
      strength = (bearishCount / candles.length) * 100;
    }

    return {
      direction,
      strength,
      change,
      bullishCandles: bullishCount,
      bearishCandles: bearishCount,
    };
  }

  /**
   * Analyze market behavior vs A-Day direction
   * @param {Object} context - Market context including adayStatus
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
          reasons: [this.createReason('Time Window', 'fail', 'Outside day behavior time window')],
        };
      }

      // Don't send multiple signals
      if (this.signalSent) {
        return {
          signal: null,
          score: 0,
          reasons: [this.createReason('Signal Limit', 'neutral', 'Day behavior signal already sent today')],
        };
      }

      // Need A-Day status for this strategy
      if (!context.adayStatus || !context.adayStatus.isADay) {
        reasons.push(this.createReason('A-Day Status', 'neutral', 'Not an A-Day follow-through day'));
        return { signal: null, score: 0, reasons };
      }

      const adayDirection = context.adayStatus.direction;

      const instrumentToken = await brokerService.getNiftyInstrumentToken();
      const today = formatDateForKite(new Date());
      const prevDay = getPreviousTradingDay();

      // Get today's and previous day's data
      const [todayData, prevDayData] = await Promise.all([
        brokerService.getHistoricalData(instrumentToken, '5minute', today, today),
        brokerService.getHistoricalData(instrumentToken, 'day', formatDateForKite(prevDay), formatDateForKite(prevDay)),
      ]);

      if (!todayData || todayData.length < 12 || !prevDayData || prevDayData.length === 0) {
        reasons.push(this.createReason('Data', 'fail', 'Insufficient data for day behavior analysis'));
        return { signal: null, score: 0, reasons };
      }

      // Calculate day metrics
      this.dayMetrics = this.calculateDayMetrics(todayData, prevDayData[0]);

      if (!this.dayMetrics) {
        reasons.push(this.createReason('Metrics', 'fail', 'Unable to calculate day metrics'));
        return { signal: null, score: 0, reasons };
      }

      const metrics = this.dayMetrics;

      // Score day behavior alignment with A-Day direction
      let alignmentScore = 0;

      // 1. Day direction alignment (3 points)
      const dayAligns = (adayDirection === 'BULLISH' && metrics.dayDirection === 'BULLISH') ||
                       (adayDirection === 'BEARISH' && metrics.dayDirection === 'BEARISH');
      if (dayAligns) {
        alignmentScore += 3;
        reasons.push(this.createReason(
          'Day Direction',
          'pass',
          `Day is ${metrics.dayDirection} (${metrics.dayChangePercent.toFixed(2)}%) - aligns with A-Day`
        ));
      } else if (metrics.dayDirection === 'NEUTRAL') {
        reasons.push(this.createReason('Day Direction', 'neutral', 'Day direction unclear'));
      } else {
        reasons.push(this.createReason(
          'Day Direction',
          'fail',
          `Day is ${metrics.dayDirection} - opposite to A-Day (${adayDirection})`
        ));
      }

      // 2. Gap and fill behavior (2 points)
      if (adayDirection === 'BULLISH' && metrics.gapType === 'GAP_UP' && !metrics.gapFilled) {
        alignmentScore += 2;
        reasons.push(this.createReason('Gap Analysis', 'pass', 'Gap up unfilled - bullish continuation'));
      } else if (adayDirection === 'BEARISH' && metrics.gapType === 'GAP_DOWN' && !metrics.gapFilled) {
        alignmentScore += 2;
        reasons.push(this.createReason('Gap Analysis', 'pass', 'Gap down unfilled - bearish continuation'));
      } else if (metrics.gapFilled) {
        reasons.push(this.createReason('Gap Analysis', 'neutral', `Gap has been filled`));
      }

      // 3. Breaking previous day levels (3 points)
      if (adayDirection === 'BULLISH' && metrics.abovePDH) {
        alignmentScore += 3;
        reasons.push(this.createReason('PDH Break', 'pass', `Trading above PDH (${metrics.prevHigh})`));
      } else if (adayDirection === 'BEARISH' && metrics.belowPDL) {
        alignmentScore += 3;
        reasons.push(this.createReason('PDL Break', 'pass', `Trading below PDL (${metrics.prevLow})`));
      } else if (metrics.inPrevRange) {
        reasons.push(this.createReason('Range Position', 'neutral', 'Within previous day range'));
      }

      // 4. Recent momentum (2 points)
      const momentumAligns = (adayDirection === 'BULLISH' && metrics.recentMomentum.direction === 'BULLISH') ||
                            (adayDirection === 'BEARISH' && metrics.recentMomentum.direction === 'BEARISH');
      if (momentumAligns) {
        alignmentScore += 2;
        reasons.push(this.createReason(
          'Momentum',
          'pass',
          `${metrics.recentMomentum.direction} momentum (${metrics.recentMomentum.strength.toFixed(0)}%)`
        ));
      } else {
        reasons.push(this.createReason(
          'Momentum',
          metrics.recentMomentum.direction === 'NEUTRAL' ? 'neutral' : 'fail',
          `Recent momentum: ${metrics.recentMomentum.direction}`
        ));
      }

      score = alignmentScore;

      // Generate signal if strong alignment (score >= 7)
      if (score >= 7) {
        signal = adayDirection === 'BULLISH' ? 'BUY_CE' : 'BUY_PE';
        this.signalSent = true;

        logger.info('Day behavior signal generated', {
          direction: signal,
          alignmentScore: score,
          adayDirection,
        });
      }

      const recentCandles = todayData.slice(-5);
      const result = {
        signal,
        score,
        reasons,
        data: {
          ...metrics,
          spotPrice: metrics.currentPrice,
          adayDirection,
          stopLoss: adayDirection === 'BULLISH'
            ? Math.min(...recentCandles.map(c => c.low))
            : Math.max(...recentCandles.map(c => c.high)),
        },
      };

      this.logAnalysis(result);
      return result;
    } catch (error) {
      logger.error('Day behavior strategy analysis failed', { error: error.message });
      reasons.push(this.createReason('Error', 'fail', error.message));
      return { signal: null, score: 0, reasons };
    }
  }

  /**
   * Reset strategy state
   */
  reset() {
    super.reset();
    this.dayMetrics = null;
    this.signalSent = false;
    this.state = { dayMetrics: null, signalSent: false };
  }

  /**
   * Get current state
   */
  getState() {
    return {
      ...super.getState(),
      dayMetrics: this.dayMetrics,
      signalSent: this.signalSent,
    };
  }
}

module.exports = new DayBehaviorStrategy();
