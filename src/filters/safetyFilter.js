/**
 * Safety Filter Module
 *
 * Risk management and signal filtering to prevent:
 * - Duplicate signals in the same direction
 * - Signals outside valid time windows
 * - Signals after max daily loss is hit
 */

const { config } = require('../config/config');
const { logger } = require('../utils/logger');
const { isWithinTimeWindow, formatDateForKite } = require('../utils/timeUtils');

// Daily state (resets each day)
let dailyState = {
  date: null,
  signalsSent: {
    BUY_CE: false,
    BUY_PE: false,
  },
  totalLoss: 0,
  trades: [],
  lastSignalTime: null,
  isLocked: false,
};

/**
 * Reset daily state (called at start of each day)
 */
function resetDailyState() {
  const today = formatDateForKite(new Date());
  dailyState = {
    date: today,
    signalsSent: {
      BUY_CE: false,
      BUY_PE: false,
    },
    totalLoss: 0,
    trades: [],
    lastSignalTime: null,
    isLocked: false,
  };
  logger.info('Daily safety state reset', { date: today });
}

/**
 * Ensure state is for today
 */
function ensureTodayState() {
  const today = formatDateForKite(new Date());
  if (dailyState.date !== today) {
    resetDailyState();
  }
}

/**
 * Check if a signal has already been sent for a direction today
 * @param {string} direction - 'BUY_CE' or 'BUY_PE'
 * @returns {boolean} True if signal already sent
 */
function hasSignalBeenSent(direction) {
  ensureTodayState();
  return dailyState.signalsSent[direction] === true;
}

/**
 * Mark a direction as having a signal sent
 * @param {string} direction - 'BUY_CE' or 'BUY_PE'
 */
function markSignalSent(direction) {
  ensureTodayState();
  dailyState.signalsSent[direction] = true;
  dailyState.lastSignalTime = new Date();
  logger.info('Signal marked as sent', { direction, time: dailyState.lastSignalTime });
}

/**
 * Check if we're within a valid time window for a strategy
 * @param {string} strategy - Strategy name ('ORB', 'PULLBACK', 'EXPIRY')
 * @returns {boolean} True if within valid time window
 */
function isWithinStrategyTimeWindow(strategy) {
  const timeWindows = {
    ORB: { start: '09:30', end: '10:30' },
    PULLBACK: { start: '10:15', end: '13:30' },
    EXPIRY: { start: '11:00', end: '14:00' },
  };

  const window = timeWindows[strategy];
  if (!window) {
    logger.warn('Unknown strategy for time window check', { strategy });
    return false;
  }

  return isWithinTimeWindow(window.start, window.end);
}

/**
 * Record a trade result (for loss tracking)
 * @param {Object} trade - Trade details
 * @param {string} trade.direction - 'BUY_CE' or 'BUY_PE'
 * @param {number} trade.pnl - Profit/Loss amount (negative for loss)
 * @param {string} trade.strategy - Strategy name
 */
function recordTrade(trade) {
  ensureTodayState();

  dailyState.trades.push({
    ...trade,
    time: new Date(),
  });

  if (trade.pnl < 0) {
    dailyState.totalLoss += Math.abs(trade.pnl);
  }

  logger.info('Trade recorded', {
    direction: trade.direction,
    pnl: trade.pnl,
    totalLoss: dailyState.totalLoss,
  });
}

/**
 * Check if max daily loss has been hit
 * @returns {boolean} True if max loss exceeded
 */
function isMaxLossHit() {
  ensureTodayState();
  const maxLoss = config.trading.maxLossPerTrade;
  const isHit = dailyState.totalLoss >= maxLoss;

  if (isHit) {
    logger.warn('Max daily loss hit', {
      totalLoss: dailyState.totalLoss,
      maxLoss,
    });
  }

  return isHit;
}

/**
 * Lock trading for the day (manual override or after max loss)
 */
function lockTrading() {
  ensureTodayState();
  dailyState.isLocked = true;
  logger.warn('Trading locked for the day');
}

/**
 * Unlock trading (manual override)
 */
function unlockTrading() {
  ensureTodayState();
  dailyState.isLocked = false;
  logger.info('Trading unlocked');
}

/**
 * Check if trading is locked
 * @returns {boolean}
 */
function isTradingLocked() {
  ensureTodayState();
  return dailyState.isLocked;
}

/**
 * Validate a signal through all safety checks
 * @param {Object} signal - Signal to validate
 * @param {string} signal.direction - 'BUY_CE' or 'BUY_PE'
 * @param {string} signal.strategy - Strategy name
 * @returns {Object} { isValid: boolean, reason: string }
 */
function validateSignal(signal) {
  ensureTodayState();

  // Check if trading is locked
  if (isTradingLocked()) {
    return { isValid: false, reason: 'Trading is locked for the day' };
  }

  // Check max loss
  if (isMaxLossHit()) {
    return { isValid: false, reason: 'Max daily loss hit' };
  }

  // Check duplicate signal
  if (hasSignalBeenSent(signal.direction)) {
    return { isValid: false, reason: `Signal already sent for ${signal.direction}` };
  }

  // Check time window
  const strategyKey = signal.strategy.split(' ')[0].toUpperCase(); // Extract first word
  if (!isWithinStrategyTimeWindow(strategyKey)) {
    return { isValid: false, reason: `Outside time window for ${strategyKey}` };
  }

  // Check minimum time between signals (prevent rapid-fire)
  if (dailyState.lastSignalTime) {
    const timeSinceLastSignal = Date.now() - dailyState.lastSignalTime.getTime();
    const minGap = 5 * 60 * 1000; // 5 minutes
    if (timeSinceLastSignal < minGap) {
      return { isValid: false, reason: 'Too soon after last signal' };
    }
  }

  return { isValid: true, reason: 'Signal validated' };
}

/**
 * Get current daily state (for debugging/monitoring)
 * @returns {Object} Current state
 */
function getState() {
  ensureTodayState();
  return { ...dailyState };
}

/**
 * Get summary of today's activity
 * @returns {Object} Summary
 */
function getDailySummary() {
  ensureTodayState();
  return {
    date: dailyState.date,
    signalsSent: { ...dailyState.signalsSent },
    totalLoss: dailyState.totalLoss,
    tradeCount: dailyState.trades.length,
    isLocked: dailyState.isLocked,
  };
}

module.exports = {
  resetDailyState,
  hasSignalBeenSent,
  markSignalSent,
  isWithinStrategyTimeWindow,
  recordTrade,
  isMaxLossHit,
  lockTrading,
  unlockTrading,
  isTradingLocked,
  validateSignal,
  getState,
  getDailySummary,
};
