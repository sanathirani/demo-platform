/**
 * OI (Open Interest) Analyzer
 *
 * Analyzes option chain OI data to provide:
 * - OI by strike
 * - Max Pain calculation
 * - OI build-up detection
 * - Put-Call Ratio (PCR)
 */

const brokerService = require('../services/brokerService');
const { logger } = require('../utils/logger');

// Cache for OI data
let cachedOIData = null;
let lastOIFetchTime = null;
const OI_CACHE_DURATION = 60000; // 1 minute cache

/**
 * Fetch and analyze OI data
 * @returns {Promise<Object>} OI analysis results
 */
async function analyze() {
  try {
    // Check cache
    if (cachedOIData && lastOIFetchTime && (Date.now() - lastOIFetchTime < OI_CACHE_DURATION)) {
      return cachedOIData;
    }

    // Get option chain data
    const optionChain = await brokerService.getOptionChain();
    const spotPrice = await brokerService.getNiftySpot();

    if (!optionChain || (!optionChain.ce && !optionChain.pe)) {
      return {
        error: 'Option chain data not available',
        pcrRatio: null,
        maxPain: null,
      };
    }

    // Calculate PCR (Put-Call Ratio)
    const pcrRatio = calculatePCR(optionChain);

    // Calculate Max Pain
    const maxPain = calculateMaxPain(optionChain, spotPrice);

    // Get OI by strike
    const oiByStrike = getOIByStrike(optionChain, spotPrice);

    // Detect OI build-up at key levels
    const oiBuildUp = detectOIBuildUp(optionChain, spotPrice);

    // Find support/resistance from OI
    const oiLevels = findOILevels(optionChain, spotPrice);

    const result = {
      pcrRatio,
      maxPain,
      spotPrice,
      oiByStrike,
      oiBuildUp,
      oiLevels,
      timestamp: new Date(),
    };

    // Cache results
    cachedOIData = result;
    lastOIFetchTime = Date.now();

    return result;
  } catch (error) {
    logger.error('OI analysis failed', { error: error.message });
    return {
      error: error.message,
      pcrRatio: null,
      maxPain: null,
    };
  }
}

/**
 * Calculate Put-Call Ratio
 * @param {Object} optionChain - { ce: [], pe: [] }
 * @returns {number} PCR ratio
 */
function calculatePCR(optionChain) {
  if (!optionChain.ce || !optionChain.pe) {
    return null;
  }

  const totalCallOI = optionChain.ce.reduce((sum, opt) => sum + (opt.oi || 0), 0);
  const totalPutOI = optionChain.pe.reduce((sum, opt) => sum + (opt.oi || 0), 0);

  if (totalCallOI === 0) return null;

  return totalPutOI / totalCallOI;
}

/**
 * Calculate Max Pain strike
 * Max Pain is the strike where option buyers lose the most money
 * @param {Object} optionChain - { ce: [], pe: [] }
 * @param {number} spotPrice - Current spot price
 * @returns {number} Max Pain strike
 */
function calculateMaxPain(optionChain, spotPrice) {
  if (!optionChain.ce || !optionChain.pe) {
    return null;
  }

  // Get unique strikes
  const strikes = new Set([
    ...optionChain.ce.map(o => o.strike),
    ...optionChain.pe.map(o => o.strike),
  ]);

  // Calculate pain at each strike
  let minPain = Infinity;
  let maxPainStrike = null;

  for (const strike of strikes) {
    let pain = 0;

    // Calculate call pain (calls ITM if spot > strike)
    for (const call of optionChain.ce) {
      if (strike > call.strike) {
        // Call is ITM at this strike
        pain += (strike - call.strike) * (call.oi || 0);
      }
    }

    // Calculate put pain (puts ITM if spot < strike)
    for (const put of optionChain.pe) {
      if (strike < put.strike) {
        // Put is ITM at this strike
        pain += (put.strike - strike) * (put.oi || 0);
      }
    }

    if (pain < minPain) {
      minPain = pain;
      maxPainStrike = strike;
    }
  }

  return maxPainStrike;
}

/**
 * Get OI distribution by strike (nearby strikes)
 * @param {Object} optionChain - { ce: [], pe: [] }
 * @param {number} spotPrice - Current spot price
 * @returns {Array} OI by strike
 */
function getOIByStrike(optionChain, spotPrice) {
  if (!optionChain.ce || !optionChain.pe) {
    return [];
  }

  // Get ATM strike
  const atmStrike = Math.round(spotPrice / 50) * 50;

  // Get strikes within range (+/- 500 points)
  const minStrike = atmStrike - 500;
  const maxStrike = atmStrike + 500;

  const oiData = [];

  // Create map of strikes to OI
  const strikeMap = new Map();

  for (const call of optionChain.ce) {
    if (call.strike >= minStrike && call.strike <= maxStrike) {
      if (!strikeMap.has(call.strike)) {
        strikeMap.set(call.strike, { strike: call.strike, callOI: 0, putOI: 0 });
      }
      strikeMap.get(call.strike).callOI = call.oi || 0;
    }
  }

  for (const put of optionChain.pe) {
    if (put.strike >= minStrike && put.strike <= maxStrike) {
      if (!strikeMap.has(put.strike)) {
        strikeMap.set(put.strike, { strike: put.strike, callOI: 0, putOI: 0 });
      }
      strikeMap.get(put.strike).putOI = put.oi || 0;
    }
  }

  // Convert to sorted array
  return Array.from(strikeMap.values())
    .sort((a, b) => a.strike - b.strike);
}

/**
 * Detect significant OI build-up
 * @param {Object} optionChain - { ce: [], pe: [] }
 * @param {number} spotPrice - Current spot price
 * @returns {boolean} Whether significant build-up detected
 */
function detectOIBuildUp(optionChain, spotPrice) {
  // This is a simplified detection
  // In production, you'd compare with previous day's OI

  if (!optionChain.ce || !optionChain.pe) {
    return false;
  }

  const atmStrike = Math.round(spotPrice / 50) * 50;

  // Check if ATM strikes have significant OI
  const atmCall = optionChain.ce.find(o => o.strike === atmStrike);
  const atmPut = optionChain.pe.find(o => o.strike === atmStrike);

  // Calculate average OI
  const avgCallOI = optionChain.ce.reduce((sum, o) => sum + (o.oi || 0), 0) / optionChain.ce.length;
  const avgPutOI = optionChain.pe.reduce((sum, o) => sum + (o.oi || 0), 0) / optionChain.pe.length;

  // Check if ATM OI is significantly above average
  const hasCallBuildUp = atmCall && (atmCall.oi || 0) > avgCallOI * 1.5;
  const hasPutBuildUp = atmPut && (atmPut.oi || 0) > avgPutOI * 1.5;

  return hasCallBuildUp || hasPutBuildUp;
}

/**
 * Find support and resistance levels from OI
 * @param {Object} optionChain - { ce: [], pe: [] }
 * @param {number} spotPrice - Current spot price
 * @returns {Object} { support, resistance }
 */
function findOILevels(optionChain, spotPrice) {
  if (!optionChain.ce || !optionChain.pe) {
    return { support: null, resistance: null };
  }

  const atmStrike = Math.round(spotPrice / 50) * 50;

  // Find highest call OI above spot (resistance)
  const callsAbove = optionChain.ce
    .filter(o => o.strike > spotPrice)
    .sort((a, b) => (b.oi || 0) - (a.oi || 0));

  const resistance = callsAbove.length > 0 ? callsAbove[0].strike : null;

  // Find highest put OI below spot (support)
  const putsBelow = optionChain.pe
    .filter(o => o.strike < spotPrice)
    .sort((a, b) => (b.oi || 0) - (a.oi || 0));

  const support = putsBelow.length > 0 ? putsBelow[0].strike : null;

  return { support, resistance };
}

/**
 * Clear OI cache
 */
function clearCache() {
  cachedOIData = null;
  lastOIFetchTime = null;
}

module.exports = {
  analyze,
  calculatePCR,
  calculateMaxPain,
  getOIByStrike,
  detectOIBuildUp,
  findOILevels,
  clearCache,
};
