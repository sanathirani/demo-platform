const { config } = require('../config/config');
const { logger } = require('../utils/logger');
const brokerService = require('./brokerService');

/**
 * Select the best strike based on direction and premium range
 * @param {string} direction - 'BUY_CE' or 'BUY_PE'
 * @param {Object} options - Selection options
 * @param {number} options.premiumMin - Minimum premium (default from config)
 * @param {number} options.premiumMax - Maximum premium (default from config)
 * @param {number} options.otmDistance - Preferred OTM distance in points (optional)
 * @returns {Promise<Object>} Selected strike details
 */
async function selectStrike(direction, options = {}) {
  const {
    premiumMin = config.trading.premiumMin,
    premiumMax = config.trading.premiumMax,
    otmDistance = null,
  } = options;

  try {
    // Get current NIFTY spot price
    const spotPrice = await brokerService.getNiftySpot();
    logger.info('NIFTY spot price', { spotPrice });

    // Get option chain
    const optionChain = await brokerService.getOptionChain();

    // Determine which options to look at based on direction
    const optionType = direction === 'BUY_CE' ? 'ce' : 'pe';
    const availableOptions = optionChain[optionType];

    if (!availableOptions || availableOptions.length === 0) {
      throw new Error(`No ${optionType.toUpperCase()} options available`);
    }

    // Calculate ATM strike (round to nearest 50)
    const atmStrike = Math.round(spotPrice / 50) * 50;
    logger.info('ATM strike calculated', { atmStrike, spotPrice });

    // Filter options by OTM distance if specified
    let filteredOptions = availableOptions;
    if (otmDistance) {
      const targetStrike = direction === 'BUY_CE'
        ? atmStrike + otmDistance
        : atmStrike - otmDistance;

      filteredOptions = availableOptions.filter(opt => {
        const distance = Math.abs(opt.strike - targetStrike);
        return distance <= 100; // Within 100 points of target
      });
    }

    // Get LTP for filtered options
    const optionSymbols = filteredOptions.map(opt => `NFO:${opt.tradingsymbol}`);

    // Batch requests to avoid rate limits (max 50 at a time)
    const batchSize = 50;
    const ltpData = {};

    for (let i = 0; i < optionSymbols.length; i += batchSize) {
      const batch = optionSymbols.slice(i, i + batchSize);
      const batchLtp = await brokerService.getLTP(batch);
      Object.assign(ltpData, batchLtp);
    }

    // Find options within premium range
    const validOptions = [];
    for (const opt of filteredOptions) {
      const symbol = `NFO:${opt.tradingsymbol}`;
      const ltp = ltpData[symbol]?.last_price;

      if (ltp && ltp >= premiumMin && ltp <= premiumMax) {
        validOptions.push({
          strike: opt.strike,
          tradingsymbol: opt.tradingsymbol,
          premium: ltp,
          instrumentToken: opt.instrument_token,
          // Calculate how far OTM this strike is
          otmPoints: direction === 'BUY_CE'
            ? opt.strike - spotPrice
            : spotPrice - opt.strike,
        });
      }
    }

    if (validOptions.length === 0) {
      logger.warn('No options found in premium range', { premiumMin, premiumMax, direction });

      // Fallback: find closest to premium range
      const allWithPremium = filteredOptions
        .map(opt => {
          const symbol = `NFO:${opt.tradingsymbol}`;
          const ltp = ltpData[symbol]?.last_price;
          return {
            strike: opt.strike,
            tradingsymbol: opt.tradingsymbol,
            premium: ltp,
            instrumentToken: opt.instrument_token,
            otmPoints: direction === 'BUY_CE'
              ? opt.strike - spotPrice
              : spotPrice - opt.strike,
          };
        })
        .filter(opt => opt.premium > 0)
        .sort((a, b) => {
          // Sort by distance from target premium range midpoint
          const targetMid = (premiumMin + premiumMax) / 2;
          return Math.abs(a.premium - targetMid) - Math.abs(b.premium - targetMid);
        });

      if (allWithPremium.length > 0) {
        const best = allWithPremium[0];
        logger.info('Using closest available strike', best);
        return {
          strike: best.strike,
          symbol: best.tradingsymbol,
          premium: best.premium,
          spotPrice,
          otmPoints: best.otmPoints,
          instrumentToken: best.instrumentToken,
        };
      }

      throw new Error('No suitable strikes found');
    }

    // Sort by OTM points (prefer slightly OTM for better risk/reward)
    // For CE: positive OTM is good, for PE: positive OTM is good
    validOptions.sort((a, b) => {
      // Prefer options that are OTM (positive otmPoints)
      // But not too far OTM
      const aScore = a.otmPoints > 0 && a.otmPoints < 200 ? a.otmPoints : -Math.abs(a.otmPoints);
      const bScore = b.otmPoints > 0 && b.otmPoints < 200 ? b.otmPoints : -Math.abs(b.otmPoints);
      return bScore - aScore;
    });

    const selected = validOptions[0];

    logger.info('Strike selected', {
      direction,
      strike: selected.strike,
      symbol: selected.tradingsymbol,
      premium: selected.premium,
      spotPrice,
      otmPoints: selected.otmPoints,
    });

    return {
      strike: selected.strike,
      symbol: selected.tradingsymbol,
      premium: selected.premium,
      spotPrice,
      otmPoints: selected.otmPoints,
      instrumentToken: selected.instrumentToken,
    };
  } catch (error) {
    logger.error('Strike selection failed', { direction, error: error.message });
    throw error;
  }
}

/**
 * Get ATM strike for current NIFTY spot
 * @returns {Promise<number>} ATM strike price
 */
async function getATMStrike() {
  const spotPrice = await brokerService.getNiftySpot();
  return Math.round(spotPrice / 50) * 50;
}

/**
 * Get option premium for a specific strike
 * @param {number} strike - Strike price
 * @param {string} type - 'CE' or 'PE'
 * @returns {Promise<number>} Current premium
 */
async function getOptionPremium(strike, type) {
  try {
    const optionChain = await brokerService.getOptionChain();
    const options = type === 'CE' ? optionChain.ce : optionChain.pe;

    const option = options.find(opt => opt.strike === strike);
    if (!option) {
      throw new Error(`Strike ${strike} ${type} not found`);
    }

    const symbol = `NFO:${option.tradingsymbol}`;
    const ltp = await brokerService.getLTP([symbol]);

    return ltp[symbol]?.last_price || 0;
  } catch (error) {
    logger.error('Failed to get option premium', { strike, type, error: error.message });
    throw error;
  }
}

module.exports = {
  selectStrike,
  getATMStrike,
  getOptionPremium,
};
