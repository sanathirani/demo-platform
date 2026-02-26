/**
 * Confidence Scorer
 *
 * Calculates composite confidence score from multiple strategy analyses.
 *
 * Scoring Breakdown (100 total):
 * - A-Day alignment: 20 points
 * - VWAP confirmation: 15 points
 * - S/R breakout: 15 points
 * - OI support: 15 points
 * - Volume spike: 15 points
 * - Day behavior: 10 points
 * - Option Greeks: 10 points
 */

const { config } = require('../config/config');
const { logger } = require('../utils/logger');

// Score weights for different factors
const SCORE_WEIGHTS = {
  ADAY_ALIGNMENT: 20,
  VWAP_CONFIRMATION: 15,
  SR_BREAKOUT: 15,
  OI_SUPPORT: 15,
  VOLUME_SPIKE: 15,
  DAY_BEHAVIOR: 10,
  OPTION_GREEKS: 10,
};

// Minimum confidence score to send alert (configurable via env)
const MIN_CONFIDENCE_SCORE = parseInt(process.env.MIN_CONFIDENCE_SCORE, 10) || 60;

/**
 * Calculate composite confidence score from strategy results
 * @param {Object} params - Scoring parameters
 * @param {Array} params.strategyResults - Results from all strategies
 * @param {Object} params.adayStatus - A-Day status { isADay, direction }
 * @param {Object} params.oiAnalysis - OI analysis results
 * @param {Object} params.volumeAnalysis - Volume analysis results
 * @param {string} params.signalDirection - 'BUY_CE' or 'BUY_PE'
 * @returns {Object} { totalScore, breakdown, meetsThreshold, reasons }
 */
function calculateConfidence({
  strategyResults = [],
  adayStatus = {},
  oiAnalysis = {},
  volumeAnalysis = {},
  signalDirection = null,
}) {
  const breakdown = {};
  const reasons = [];
  let totalScore = 0;

  // 1. A-Day Alignment (20 points)
  const adayScore = scoreAdayAlignment(adayStatus, signalDirection);
  breakdown.adayAlignment = adayScore;
  totalScore += adayScore.score;
  reasons.push(...adayScore.reasons);

  // 2. Strategy Scores (VWAP, S/R, Day Behavior)
  for (const result of strategyResults) {
    if (result && result.score > 0) {
      const categoryKey = getCategoryKey(result.strategyName);
      if (categoryKey && !breakdown[categoryKey]) {
        breakdown[categoryKey] = {
          score: result.score,
          maxScore: result.maxScore || 15,
          reasons: result.reasons || [],
        };
        totalScore += result.score;
        reasons.push(...(result.reasons || []));
      }
    }
  }

  // 3. OI Support (15 points)
  const oiScore = scoreOISupport(oiAnalysis, signalDirection);
  breakdown.oiSupport = oiScore;
  totalScore += oiScore.score;
  reasons.push(...oiScore.reasons);

  // 4. Volume Spike (15 points)
  const volumeScore = scoreVolumeSpike(volumeAnalysis);
  breakdown.volumeSpike = volumeScore;
  totalScore += volumeScore.score;
  reasons.push(...volumeScore.reasons);

  // 5. Option Greeks (10 points) - simplified for now
  const greeksScore = scoreOptionGreeks();
  breakdown.optionGreeks = greeksScore;
  totalScore += greeksScore.score;
  reasons.push(...greeksScore.reasons);

  // Cap at 100
  totalScore = Math.min(100, totalScore);

  const meetsThreshold = totalScore >= MIN_CONFIDENCE_SCORE;

  logger.info('Confidence score calculated', {
    totalScore,
    meetsThreshold,
    threshold: MIN_CONFIDENCE_SCORE,
    signalDirection,
  });

  return {
    totalScore,
    maxScore: 100,
    breakdown,
    meetsThreshold,
    threshold: MIN_CONFIDENCE_SCORE,
    reasons: deduplicateReasons(reasons),
  };
}

/**
 * Score A-Day alignment
 * @param {Object} adayStatus - { isADay, direction }
 * @param {string} signalDirection - 'BUY_CE' or 'BUY_PE'
 * @returns {Object} { score, reasons }
 */
function scoreAdayAlignment(adayStatus, signalDirection) {
  const maxScore = SCORE_WEIGHTS.ADAY_ALIGNMENT;
  const reasons = [];

  if (!adayStatus || !adayStatus.isADay) {
    reasons.push({
      factor: 'A-Day Status',
      status: 'fail',
      detail: 'Previous day was NOT an A-Day',
    });
    return { score: 0, maxScore, reasons };
  }

  // Check if signal direction aligns with A-Day direction
  const adayDirection = adayStatus.direction; // 'BULLISH' or 'BEARISH'
  const signalIsBullish = signalDirection === 'BUY_CE';

  if (
    (adayDirection === 'BULLISH' && signalIsBullish) ||
    (adayDirection === 'BEARISH' && !signalIsBullish)
  ) {
    reasons.push({
      factor: 'A-Day Alignment',
      status: 'pass',
      detail: `Signal aligns with A-Day direction (${adayDirection})`,
    });
    return { score: maxScore, maxScore, reasons };
  } else {
    reasons.push({
      factor: 'A-Day Alignment',
      status: 'neutral',
      detail: `Signal opposite to A-Day direction (A-Day: ${adayDirection})`,
    });
    return { score: Math.floor(maxScore * 0.5), maxScore, reasons };
  }
}

/**
 * Score OI support
 * @param {Object} oiAnalysis - { pcrRatio, maxPain, oiBuildUp }
 * @param {string} signalDirection - 'BUY_CE' or 'BUY_PE'
 * @returns {Object} { score, reasons }
 */
function scoreOISupport(oiAnalysis, signalDirection) {
  const maxScore = SCORE_WEIGHTS.OI_SUPPORT;
  const reasons = [];
  let score = 0;

  if (!oiAnalysis || Object.keys(oiAnalysis).length === 0) {
    reasons.push({
      factor: 'OI Analysis',
      status: 'neutral',
      detail: 'OI data not available',
    });
    return { score: 0, maxScore, reasons };
  }

  // PCR analysis (5 points)
  if (oiAnalysis.pcrRatio) {
    const pcr = oiAnalysis.pcrRatio;
    const signalIsBullish = signalDirection === 'BUY_CE';

    if (pcr > 1.2 && signalIsBullish) {
      score += 5;
      reasons.push({
        factor: 'PCR Ratio',
        status: 'pass',
        detail: `PCR ${pcr.toFixed(2)} > 1.2 supports bullish move`,
      });
    } else if (pcr < 0.8 && !signalIsBullish) {
      score += 5;
      reasons.push({
        factor: 'PCR Ratio',
        status: 'pass',
        detail: `PCR ${pcr.toFixed(2)} < 0.8 supports bearish move`,
      });
    } else {
      reasons.push({
        factor: 'PCR Ratio',
        status: 'neutral',
        detail: `PCR ${pcr.toFixed(2)} is neutral`,
      });
    }
  }

  // Max Pain (5 points)
  if (oiAnalysis.maxPain && oiAnalysis.spotPrice) {
    const distanceFromMaxPain = Math.abs(oiAnalysis.spotPrice - oiAnalysis.maxPain);
    const percentFromMaxPain = (distanceFromMaxPain / oiAnalysis.spotPrice) * 100;

    if (percentFromMaxPain < 1) {
      score += 5;
      reasons.push({
        factor: 'Max Pain',
        status: 'pass',
        detail: `Spot near Max Pain (${oiAnalysis.maxPain}) - high probability zone`,
      });
    } else {
      reasons.push({
        factor: 'Max Pain',
        status: 'neutral',
        detail: `Spot ${percentFromMaxPain.toFixed(1)}% from Max Pain`,
      });
    }
  }

  // OI buildup (5 points)
  if (oiAnalysis.oiBuildUp) {
    score += 5;
    reasons.push({
      factor: 'OI Build-up',
      status: 'pass',
      detail: 'Fresh OI build-up detected at key strikes',
    });
  }

  return { score, maxScore, reasons };
}

/**
 * Score volume spike
 * @param {Object} volumeAnalysis - { volumeRatio, isSpike }
 * @returns {Object} { score, reasons }
 */
function scoreVolumeSpike(volumeAnalysis) {
  const maxScore = SCORE_WEIGHTS.VOLUME_SPIKE;
  const reasons = [];

  if (!volumeAnalysis || volumeAnalysis.volumeRatio === undefined) {
    reasons.push({
      factor: 'Volume',
      status: 'neutral',
      detail: 'Volume data not available',
    });
    return { score: 0, maxScore, reasons };
  }

  const ratio = volumeAnalysis.volumeRatio;

  if (ratio >= 2.0) {
    reasons.push({
      factor: 'Volume Spike',
      status: 'pass',
      detail: `Strong volume spike (${(ratio * 100).toFixed(0)}% of average)`,
    });
    return { score: maxScore, maxScore, reasons };
  } else if (ratio >= 1.5) {
    reasons.push({
      factor: 'Volume Spike',
      status: 'pass',
      detail: `Moderate volume spike (${(ratio * 100).toFixed(0)}% of average)`,
    });
    return { score: Math.floor(maxScore * 0.7), maxScore, reasons };
  } else if (ratio >= 1.0) {
    reasons.push({
      factor: 'Volume',
      status: 'neutral',
      detail: `Volume at average (${(ratio * 100).toFixed(0)}%)`,
    });
    return { score: Math.floor(maxScore * 0.3), maxScore, reasons };
  } else {
    reasons.push({
      factor: 'Volume',
      status: 'fail',
      detail: `Volume below average (${(ratio * 100).toFixed(0)}%)`,
    });
    return { score: 0, maxScore, reasons };
  }
}

/**
 * Score option Greeks (simplified for now)
 * @returns {Object} { score, reasons }
 */
function scoreOptionGreeks() {
  const maxScore = SCORE_WEIGHTS.OPTION_GREEKS;
  const reasons = [];

  // Placeholder - can be enhanced with actual Greeks analysis
  reasons.push({
    factor: 'Option Greeks',
    status: 'neutral',
    detail: 'Greeks analysis pending implementation',
  });

  return { score: Math.floor(maxScore * 0.5), maxScore, reasons };
}

/**
 * Map strategy name to scoring category
 * @param {string} strategyName
 * @returns {string|null}
 */
function getCategoryKey(strategyName) {
  const name = (strategyName || '').toUpperCase();

  if (name.includes('VWAP')) return 'vwapConfirmation';
  if (name.includes('S/R') || name.includes('SUPPORT') || name.includes('RESISTANCE')) return 'srBreakout';
  if (name.includes('DAY') && name.includes('BEHAVIOR')) return 'dayBehavior';
  if (name.includes('ORB')) return 'orbBreakout';
  if (name.includes('PULLBACK')) return 'pullbackContinuation';
  if (name.includes('EXPIRY') || name.includes('MOMENTUM')) return 'expiryMomentum';

  return null;
}

/**
 * Remove duplicate reasons
 * @param {Array} reasons
 * @returns {Array}
 */
function deduplicateReasons(reasons) {
  const seen = new Set();
  return reasons.filter(r => {
    const key = `${r.factor}:${r.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Check if score meets threshold
 * @param {number} score
 * @returns {boolean}
 */
function meetsThreshold(score) {
  return score >= MIN_CONFIDENCE_SCORE;
}

/**
 * Get current threshold
 * @returns {number}
 */
function getThreshold() {
  return MIN_CONFIDENCE_SCORE;
}

module.exports = {
  calculateConfidence,
  meetsThreshold,
  getThreshold,
  SCORE_WEIGHTS,
};
