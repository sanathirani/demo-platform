const { config } = require('../config/config');
const { logger } = require('../utils/logger');

let brokerService = null;

/**
 * Get the appropriate broker service based on configuration
 * @returns {Object} Broker service (kiteService or angelService)
 */
function getBroker() {
  if (brokerService) {
    return brokerService;
  }

  const brokerType = config.broker.type;

  if (brokerType === 'angel') {
    logger.info('Using Angel One SmartAPI as broker');
    brokerService = require('./angelService');
  } else {
    logger.info('Using Zerodha Kite Connect as broker');
    brokerService = require('./kiteService');
  }

  return brokerService;
}

/**
 * Get the current broker type
 * @returns {string} 'kite' or 'angel'
 */
function getBrokerType() {
  return config.broker.type;
}

/**
 * Reset broker service (useful for testing)
 */
function resetBroker() {
  brokerService = null;
}

module.exports = {
  getBroker,
  getBrokerType,
  resetBroker,
};
