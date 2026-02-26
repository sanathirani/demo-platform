/**
 * Strategy Engine
 *
 * Orchestrates all trading strategies, runs them in parallel during their
 * time windows, and aggregates results.
 */

const { logger } = require('../utils/logger');
const { getISTNow, formatDateForKite } = require('../utils/timeUtils');
const { aggregateSignals } = require('./signalAggregator');

class StrategyEngine {
  constructor() {
    this.strategies = new Map();
    this.analyzers = {};
    this.lastRunDate = null;
    this.isInitialized = false;
  }

  /**
   * Register a strategy
   * @param {string} name - Strategy identifier
   * @param {BaseStrategy} strategy - Strategy instance
   */
  registerStrategy(name, strategy) {
    this.strategies.set(name, strategy);
    logger.info(`Strategy registered: ${name}`);
  }

  /**
   * Register an analyzer
   * @param {string} name - Analyzer identifier
   * @param {Object} analyzer - Analyzer module
   */
  registerAnalyzer(name, analyzer) {
    this.analyzers[name] = analyzer;
    logger.info(`Analyzer registered: ${name}`);
  }

  /**
   * Get a registered strategy
   * @param {string} name
   * @returns {BaseStrategy|undefined}
   */
  getStrategy(name) {
    return this.strategies.get(name);
  }

  /**
   * Get all registered strategies
   * @returns {Map}
   */
  getAllStrategies() {
    return this.strategies;
  }

  /**
   * Reset all strategies (called at start of each day)
   */
  resetAll() {
    for (const [name, strategy] of this.strategies) {
      strategy.reset();
      logger.debug(`Reset strategy: ${name}`);
    }
    this.lastRunDate = formatDateForKite(new Date());
    logger.info('All strategies reset');
  }

  /**
   * Check if day reset is needed
   */
  checkDayReset() {
    const today = formatDateForKite(new Date());
    if (this.lastRunDate !== today) {
      this.resetAll();
    }
  }

  /**
   * Run all active strategies in parallel
   * @param {Object} context - Shared context for strategies
   * @param {Object} context.adayStatus - A-Day status
   * @param {Object} context.marketData - Current market data
   * @returns {Promise<Array>} Array of strategy results
   */
  async runStrategies(context = {}) {
    this.checkDayReset();

    const activeStrategies = [];

    // Identify strategies that are in their time window
    for (const [name, strategy] of this.strategies) {
      if (strategy.isInTimeWindow()) {
        activeStrategies.push({ name, strategy });
      }
    }

    if (activeStrategies.length === 0) {
      logger.debug('No strategies active in current time window');
      return [];
    }

    logger.info(`Running ${activeStrategies.length} active strategies`, {
      strategies: activeStrategies.map(s => s.name),
    });

    // Run all active strategies in parallel
    const results = await Promise.all(
      activeStrategies.map(async ({ name, strategy }) => {
        try {
          const result = await strategy.analyze(context);
          return {
            strategyName: name,
            ...result,
          };
        } catch (error) {
          logger.error(`Strategy ${name} failed`, { error: error.message });
          return {
            strategyName: name,
            signal: null,
            score: 0,
            reasons: [{
              factor: name,
              status: 'fail',
              detail: `Strategy error: ${error.message}`,
            }],
            error: error.message,
          };
        }
      })
    );

    return results;
  }

  /**
   * Run analyzers to gather market context
   * @returns {Promise<Object>} Analysis results
   */
  async runAnalyzers() {
    const results = {};

    // Run each analyzer
    const analyzerPromises = Object.entries(this.analyzers).map(
      async ([name, analyzer]) => {
        try {
          if (typeof analyzer.analyze === 'function') {
            results[name] = await analyzer.analyze();
          } else {
            logger.warn(`Analyzer ${name} has no analyze() method`);
          }
        } catch (error) {
          logger.error(`Analyzer ${name} failed`, { error: error.message });
          results[name] = { error: error.message };
        }
      }
    );

    await Promise.all(analyzerPromises);

    return results;
  }

  /**
   * Full analysis cycle: run analyzers, strategies, and aggregate
   * @param {Object} adayStatus - A-Day status
   * @returns {Promise<Object|null>} Aggregated signal or null
   */
  async analyze(adayStatus = {}) {
    try {
      // Run analyzers first for context
      const analyzerResults = await this.runAnalyzers();

      // Build context for strategies
      const context = {
        adayStatus,
        oiAnalysis: analyzerResults.oi || {},
        volumeAnalysis: analyzerResults.volume || {},
        trendAnalysis: analyzerResults.trend || {},
        reversalData: analyzerResults.reversal || {},
      };

      // Run all active strategies
      const strategyResults = await this.runStrategies(context);

      // Aggregate signals
      const aggregatedSignal = aggregateSignals({
        strategyResults,
        adayStatus,
        oiAnalysis: context.oiAnalysis,
        volumeAnalysis: context.volumeAnalysis,
      });

      return aggregatedSignal;
    } catch (error) {
      logger.error('Strategy engine analysis failed', { error: error.message });
      return null;
    }
  }

  /**
   * Get status of all strategies
   * @returns {Object}
   */
  getStatus() {
    const status = {
      initialized: this.isInitialized,
      lastRunDate: this.lastRunDate,
      strategies: {},
      analyzers: Object.keys(this.analyzers),
    };

    for (const [name, strategy] of this.strategies) {
      status.strategies[name] = {
        timeWindow: strategy.getTimeWindow(),
        isActive: strategy.isInTimeWindow(),
        state: strategy.getState(),
      };
    }

    return status;
  }

  /**
   * Initialize engine with strategies and analyzers
   * @param {Object} options - Configuration options
   */
  async initialize(options = {}) {
    logger.info('Initializing strategy engine');

    // Strategies will be registered externally
    // This is a placeholder for any async initialization

    this.isInitialized = true;
    logger.info('Strategy engine initialized', {
      strategies: this.strategies.size,
      analyzers: Object.keys(this.analyzers).length,
    });
  }
}

// Singleton instance
const engine = new StrategyEngine();

module.exports = engine;
