/**
 * Base Strategy Class
 *
 * All strategies must extend this class and implement the analyze() method.
 * Each strategy returns standardized results with signals, reasons, and scores.
 */

const { logger } = require('../utils/logger');
const { isWithinTimeWindow, getISTNow, formatDateForKite } = require('../utils/timeUtils');

class BaseStrategy {
  /**
   * @param {string} name - Strategy name (e.g., 'ORB BREAKOUT')
   * @param {Object} timeWindow - { start: 'HH:mm', end: 'HH:mm' }
   * @param {number} maxScore - Maximum score this strategy can contribute
   */
  constructor(name, timeWindow, maxScore = 15) {
    if (new.target === BaseStrategy) {
      throw new Error('BaseStrategy is abstract and cannot be instantiated directly');
    }

    this.name = name;
    this.timeWindow = timeWindow;
    this.maxScore = maxScore;
    this.lastCheckDate = null;
    this.state = {};
  }

  /**
   * Check if current time is within this strategy's time window
   * @returns {boolean}
   */
  isInTimeWindow() {
    if (!this.timeWindow) return true;
    return isWithinTimeWindow(this.timeWindow.start, this.timeWindow.end);
  }

  /**
   * Get the time window for this strategy
   * @returns {Object} { start, end }
   */
  getTimeWindow() {
    return this.timeWindow;
  }

  /**
   * Analyze market conditions and return signal data
   * Must be implemented by subclasses
   *
   * @returns {Promise<Object>} Analysis result:
   *   {
   *     signal: 'BUY_CE' | 'BUY_PE' | null,
   *     direction: 'BULLISH' | 'BEARISH' | null,
   *     score: number (0 to maxScore),
   *     reasons: Array<{ factor: string, status: 'pass' | 'fail' | 'neutral', detail: string }>,
   *     data: Object (strategy-specific data)
   *   }
   */
  async analyze() {
    throw new Error('analyze() must be implemented by subclass');
  }

  /**
   * Reset strategy state (called at start of each day)
   */
  reset() {
    this.lastCheckDate = null;
    this.state = {};
    logger.info(`${this.name} strategy reset`);
  }

  /**
   * Get current strategy state
   * @returns {Object}
   */
  getState() {
    return {
      name: this.name,
      timeWindow: this.timeWindow,
      maxScore: this.maxScore,
      ...this.state,
    };
  }

  /**
   * Check if state needs reset for new day
   * @returns {boolean} true if reset was performed
   */
  checkDayReset() {
    const today = formatDateForKite(new Date());
    if (this.lastCheckDate !== today) {
      this.reset();
      this.lastCheckDate = today;
      return true;
    }
    return false;
  }

  /**
   * Create a standardized reason object
   * @param {string} factor - Factor name (e.g., 'VWAP Crossover')
   * @param {string} status - 'pass' | 'fail' | 'neutral'
   * @param {string} detail - Human-readable detail
   * @returns {Object}
   */
  createReason(factor, status, detail) {
    return { factor, status, detail };
  }

  /**
   * Calculate a partial score based on condition
   * @param {boolean} condition - Whether the condition is met
   * @param {number} points - Points to award if condition is met
   * @param {number} partialPoints - Optional partial points if partially met
   * @returns {number}
   */
  calculateScore(condition, points, partialPoints = 0) {
    return condition ? points : partialPoints;
  }

  /**
   * Log analysis result
   * @param {Object} result - Analysis result
   */
  logAnalysis(result) {
    if (result.signal) {
      logger.info(`${this.name} signal generated`, {
        signal: result.signal,
        score: result.score,
        reasons: result.reasons.filter(r => r.status === 'pass').map(r => r.factor),
      });
    }
  }
}

module.exports = BaseStrategy;
