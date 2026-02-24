/**
 * Unified broker service that proxies all calls to the active broker
 * Import this instead of kiteService or angelService directly
 */

const { getBroker, getBrokerType } = require('./brokerFactory');

// Proxy all broker methods through the factory
module.exports = {
  // Initialization
  initKite: (...args) => getBroker().initKite(...args),
  getKite: (...args) => getBroker().getKite(...args),

  // Authentication
  login: (...args) => getBroker().login(...args),
  isAuthenticated: (...args) => getBroker().isAuthenticated(...args),

  // Market Data
  getHistoricalData: (...args) => getBroker().getHistoricalData(...args),
  getLTP: (...args) => getBroker().getLTP(...args),
  getQuote: (...args) => getBroker().getQuote(...args),
  getOHLC: (...args) => getBroker().getOHLC(...args),

  // Instruments
  getInstruments: (...args) => getBroker().getInstruments(...args),
  getOptionChain: (...args) => getBroker().getOptionChain(...args),

  // NIFTY specific
  getNiftySpot: (...args) => getBroker().getNiftySpot(...args),
  getNiftyInstrumentToken: (...args) => getBroker().getNiftyInstrumentToken(...args),

  // Utility
  getBrokerType,
};
