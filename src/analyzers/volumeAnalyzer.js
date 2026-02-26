/**
 * Volume Analyzer
 *
 * Analyzes volume patterns to detect:
 * - Volume vs 20-day average
 * - Volume spikes (1.5x+)
 * - Volume trends
 */

const brokerService = require('../services/brokerService');
const { logger } = require('../utils/logger');
const { formatDateForKite, getTradingDaysAgo, getISTNow } = require('../utils/timeUtils');

// Cache for baseline volume
let volumeBaseline = null;
let lastBaselineDate = null;

/**
 * Initialize or get volume baseline (20-day average)
 * @returns {Promise<number>} Average volume per 5-minute candle
 */
async function initBaseline() {
  const today = formatDateForKite(new Date());

  // Return cached if same day
  if (lastBaselineDate === today && volumeBaseline !== null) {
    return volumeBaseline;
  }

  try {
    const instrumentToken = await brokerService.getNiftyInstrumentToken();
    const fromDate = getTradingDaysAgo(5);
    const toDate = getTradingDaysAgo(1);

    const historicalData = await brokerService.getHistoricalData(
      instrumentToken,
      '5minute',
      formatDateForKite(fromDate),
      formatDateForKite(toDate)
    );

    if (!historicalData || historicalData.length === 0) {
      logger.warn('No historical volume data available');
      return 0;
    }

    // Calculate average volume per candle
    const totalVolume = historicalData.reduce((sum, c) => sum + (c.volume || 0), 0);
    volumeBaseline = totalVolume / historicalData.length;
    lastBaselineDate = today;

    logger.info('Volume baseline initialized', {
      baseline: volumeBaseline,
      candles: historicalData.length,
    });

    return volumeBaseline;
  } catch (error) {
    logger.error('Failed to initialize volume baseline', { error: error.message });
    return 0;
  }
}

/**
 * Analyze current volume conditions
 * @returns {Promise<Object>} Volume analysis results
 */
async function analyze() {
  try {
    const baseline = await initBaseline();
    if (baseline === 0) {
      return {
        volumeRatio: null,
        isSpike: false,
        spikeLevel: null,
        error: 'Baseline not available',
      };
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

    if (!historicalData || historicalData.length === 0) {
      return {
        volumeRatio: null,
        isSpike: false,
        error: 'No today data',
      };
    }

    // Analyze recent candles (last 3)
    const recentCandles = historicalData.slice(-3);
    const recentVolume = recentCandles.reduce((sum, c) => sum + (c.volume || 0), 0) / recentCandles.length;

    const volumeRatio = recentVolume / baseline;

    // Determine spike level
    let spikeLevel = null;
    let isSpike = false;

    if (volumeRatio >= 2.5) {
      spikeLevel = 'EXTREME';
      isSpike = true;
    } else if (volumeRatio >= 2.0) {
      spikeLevel = 'VERY_HIGH';
      isSpike = true;
    } else if (volumeRatio >= 1.5) {
      spikeLevel = 'HIGH';
      isSpike = true;
    } else if (volumeRatio >= 1.0) {
      spikeLevel = 'NORMAL';
    } else {
      spikeLevel = 'LOW';
    }

    // Calculate volume trend (comparing first hour vs current)
    let volumeTrend = 'NEUTRAL';
    if (historicalData.length > 12) {
      const firstHourVol = historicalData.slice(0, 12).reduce((sum, c) => sum + (c.volume || 0), 0) / 12;
      const recentHourVol = historicalData.slice(-12).reduce((sum, c) => sum + (c.volume || 0), 0) / 12;

      if (recentHourVol > firstHourVol * 1.2) {
        volumeTrend = 'INCREASING';
      } else if (recentHourVol < firstHourVol * 0.8) {
        volumeTrend = 'DECREASING';
      }
    }

    return {
      volumeRatio,
      isSpike,
      spikeLevel,
      volumeTrend,
      baseline,
      recentVolume,
      percentOfAvg: Math.round(volumeRatio * 100),
    };
  } catch (error) {
    logger.error('Volume analysis failed', { error: error.message });
    return {
      volumeRatio: null,
      isSpike: false,
      error: error.message,
    };
  }
}

/**
 * Get volume spike status for a specific set of candles
 * @param {Array} candles - Array of OHLCV candles
 * @param {number} baseline - Baseline volume to compare against
 * @returns {Object} Spike analysis
 */
function analyzeCandles(candles, baseline) {
  if (!candles || candles.length === 0 || !baseline) {
    return { isSpike: false, volumeRatio: 0 };
  }

  const avgVolume = candles.reduce((sum, c) => sum + (c.volume || 0), 0) / candles.length;
  const volumeRatio = avgVolume / baseline;

  return {
    isSpike: volumeRatio >= 1.5,
    volumeRatio,
    avgVolume,
    percentOfAvg: Math.round(volumeRatio * 100),
  };
}

/**
 * Clear cached baseline
 */
function clearCache() {
  volumeBaseline = null;
  lastBaselineDate = null;
}

/**
 * Get current baseline value
 * @returns {number|null}
 */
function getBaseline() {
  return volumeBaseline;
}

module.exports = {
  analyze,
  initBaseline,
  analyzeCandles,
  clearCache,
  getBaseline,
};
