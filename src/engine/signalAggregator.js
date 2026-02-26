/**
 * Signal Aggregator
 *
 * Combines signals from multiple strategies into a single, coherent signal
 * with composite confidence score and unified reasoning.
 */

const { logger } = require('../utils/logger');
const { calculateConfidence, meetsThreshold } = require('./confidenceScorer');
const { formatWHYSection, createSummaryLine } = require('./reasonBuilder');

/**
 * Aggregate results from multiple strategies
 * @param {Object} params - Aggregation parameters
 * @param {Array} params.strategyResults - Array of strategy analysis results
 * @param {Object} params.adayStatus - A-Day status { isADay, direction }
 * @param {Object} params.oiAnalysis - OI analysis results
 * @param {Object} params.volumeAnalysis - Volume analysis results
 * @returns {Object|null} Aggregated signal or null if no valid signal
 */
function aggregateSignals({
  strategyResults = [],
  adayStatus = {},
  oiAnalysis = {},
  volumeAnalysis = {},
}) {
  // Filter to only results with signals
  const signalResults = strategyResults.filter(r => r && r.signal);

  if (signalResults.length === 0) {
    logger.debug('No signals to aggregate');
    return null;
  }

  // Determine dominant direction (most signals pointing same way)
  const directionCounts = {
    BUY_CE: 0,
    BUY_PE: 0,
  };

  const directionScores = {
    BUY_CE: 0,
    BUY_PE: 0,
  };

  for (const result of signalResults) {
    if (result.signal === 'BUY_CE' || result.signal === 'BUY_PE') {
      directionCounts[result.signal]++;
      directionScores[result.signal] += result.score || 0;
    }
  }

  // No valid direction
  if (directionCounts.BUY_CE === 0 && directionCounts.BUY_PE === 0) {
    logger.debug('No valid direction in signals');
    return null;
  }

  // Choose direction with higher score (or count if tied)
  let primaryDirection;
  if (directionScores.BUY_CE !== directionScores.BUY_PE) {
    primaryDirection = directionScores.BUY_CE > directionScores.BUY_PE ? 'BUY_CE' : 'BUY_PE';
  } else {
    primaryDirection = directionCounts.BUY_CE >= directionCounts.BUY_PE ? 'BUY_CE' : 'BUY_PE';
  }

  // Get all results that align with primary direction
  const alignedResults = signalResults.filter(r => r.signal === primaryDirection);

  // Collect all reasons from aligned strategies
  const allReasons = [];
  const strategyNames = [];
  let totalStrategyScore = 0;

  for (const result of alignedResults) {
    if (result.reasons) {
      allReasons.push(...result.reasons);
    }
    if (result.strategyName) {
      strategyNames.push(result.strategyName);
    }
    totalStrategyScore += result.score || 0;
  }

  // Calculate composite confidence score
  const confidence = calculateConfidence({
    strategyResults: alignedResults,
    adayStatus,
    oiAnalysis,
    volumeAnalysis,
    signalDirection: primaryDirection,
  });

  // Check threshold
  if (!confidence.meetsThreshold) {
    logger.info('Signal below confidence threshold', {
      direction: primaryDirection,
      score: confidence.totalScore,
      threshold: confidence.threshold,
    });
    return null;
  }

  // Find the primary strategy (highest score)
  const primaryStrategy = alignedResults.reduce((best, current) => {
    if (!best || (current.score || 0) > (best.score || 0)) {
      return current;
    }
    return best;
  }, null);

  // Build aggregated signal
  const aggregatedSignal = {
    signal: primaryDirection,
    direction: primaryDirection,
    primaryStrategy: primaryStrategy?.strategyName || 'COMBINED',
    contributingStrategies: strategyNames,
    spotPrice: primaryStrategy?.data?.spotPrice,
    stopLoss: primaryStrategy?.data?.stopLoss,

    // Confidence data
    confidenceScore: confidence.totalScore,
    confidenceBreakdown: confidence.breakdown,
    meetsThreshold: confidence.meetsThreshold,

    // Reasoning
    reasons: confidence.reasons,
    whySection: formatWHYSection(confidence.reasons, confidence.totalScore),
    reasonSummary: createSummaryLine(confidence.reasons),

    // Strategy-specific data
    strategyData: alignedResults.map(r => ({
      name: r.strategyName,
      score: r.score,
      data: r.data,
    })),

    // Metadata
    timestamp: new Date(),
    strategyCount: alignedResults.length,
  };

  logger.info('Signal aggregated', {
    direction: primaryDirection,
    confidence: confidence.totalScore,
    strategies: strategyNames.length,
    primaryStrategy: primaryStrategy?.strategyName,
  });

  return aggregatedSignal;
}

/**
 * Validate aggregated signal before sending
 * @param {Object} signal - Aggregated signal
 * @returns {Object} { isValid, reason }
 */
function validateAggregatedSignal(signal) {
  if (!signal) {
    return { isValid: false, reason: 'No signal to validate' };
  }

  if (!signal.direction) {
    return { isValid: false, reason: 'Signal missing direction' };
  }

  if (!signal.meetsThreshold) {
    return { isValid: false, reason: `Below confidence threshold (${signal.confidenceScore})` };
  }

  if (!signal.spotPrice) {
    return { isValid: false, reason: 'Signal missing spot price' };
  }

  return { isValid: true, reason: 'Signal validated' };
}

/**
 * Create a quick summary of aggregated signal
 * @param {Object} signal - Aggregated signal
 * @returns {string}
 */
function createSignalSummary(signal) {
  if (!signal) return 'No signal';

  const parts = [
    signal.direction,
    `Confidence: ${signal.confidenceScore}`,
    `Strategies: ${signal.contributingStrategies?.join(', ') || 'Unknown'}`,
  ];

  return parts.join(' | ');
}

module.exports = {
  aggregateSignals,
  validateAggregatedSignal,
  createSignalSummary,
};
