const { KiteConnect } = require('kiteconnect');
const { config } = require('../config/config');
const { logger } = require('../utils/logger');
const { formatDateForKite, getNextWeeklyExpiry } = require('../utils/timeUtils');

let kite = null;
let isLoggedIn = false;

/**
 * Initialize Kite Connect instance
 */
function initKite() {
  kite = new KiteConnect({
    api_key: config.kite.apiKey,
  });
  return kite;
}

/**
 * Get Kite instance
 * @returns {KiteConnect}
 */
function getKite() {
  if (!kite) {
    initKite();
  }
  return kite;
}

/**
 * Handle daily login flow
 * Note: This requires manual intervention for the first login each day
 * to get the request_token from the redirect URL
 * @param {string} requestToken - Token from OAuth redirect
 * @returns {Promise<Object>} Session data
 */
async function login(requestToken) {
  try {
    const k = getKite();

    if (requestToken) {
      // Generate session from request token
      const session = await k.generateSession(requestToken, config.kite.apiSecret);
      k.setAccessToken(session.access_token);
      isLoggedIn = true;
      logger.info('Kite login successful', { userId: session.user_id });
      return session;
    } else if (config.kite.accessToken) {
      // Use existing access token
      k.setAccessToken(config.kite.accessToken);
      isLoggedIn = true;
      logger.info('Kite session restored from access token');
      return { access_token: config.kite.accessToken };
    } else {
      // Generate login URL
      const loginUrl = k.getLoginURL();
      logger.warn('No access token available. Please login manually.', { loginUrl });
      throw new Error(`Please login at: ${loginUrl}`);
    }
  } catch (error) {
    logger.error('Kite login failed', { error: error.message });
    throw error;
  }
}

/**
 * Check if logged in
 * @returns {boolean}
 */
function isAuthenticated() {
  return isLoggedIn;
}

/**
 * Get historical OHLCV data
 * @param {string} instrumentToken - Instrument token
 * @param {string} interval - Candle interval (minute, 5minute, 15minute, day)
 * @param {Date|string} from - Start date
 * @param {Date|string} to - End date
 * @returns {Promise<Array>} Array of candles
 */
async function getHistoricalData(instrumentToken, interval, from, to) {
  try {
    const k = getKite();
    const fromDate = typeof from === 'string' ? from : formatDateForKite(from);
    const toDate = typeof to === 'string' ? to : formatDateForKite(to);

    const data = await k.getHistoricalData(
      instrumentToken,
      interval,
      fromDate,
      toDate
    );

    logger.debug('Historical data fetched', {
      instrumentToken,
      interval,
      from: fromDate,
      to: toDate,
      candles: data.length,
    });

    return data;
  } catch (error) {
    logger.error('Failed to fetch historical data', {
      instrumentToken,
      interval,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Get live price (LTP) for a symbol
 * @param {string|string[]} instruments - Instrument(s) in exchange:symbol format
 * @returns {Promise<Object>} LTP data
 */
async function getLTP(instruments) {
  try {
    const k = getKite();
    const instrumentList = Array.isArray(instruments) ? instruments : [instruments];
    const data = await k.getLTP(instrumentList);
    return data;
  } catch (error) {
    logger.error('Failed to fetch LTP', { instruments, error: error.message });
    throw error;
  }
}

/**
 * Get quotes for multiple instruments
 * @param {string[]} instruments - Array of instruments in exchange:symbol format
 * @returns {Promise<Object>} Quote data
 */
async function getQuote(instruments) {
  try {
    const k = getKite();
    const data = await k.getQuote(instruments);
    return data;
  } catch (error) {
    logger.error('Failed to fetch quotes', { instruments, error: error.message });
    throw error;
  }
}

/**
 * Get OHLC for instruments
 * @param {string[]} instruments - Array of instruments
 * @returns {Promise<Object>} OHLC data
 */
async function getOHLC(instruments) {
  try {
    const k = getKite();
    const data = await k.getOHLC(instruments);
    return data;
  } catch (error) {
    logger.error('Failed to fetch OHLC', { instruments, error: error.message });
    throw error;
  }
}

/**
 * Get instruments list
 * @param {string} exchange - Exchange (NSE, NFO, etc.)
 * @returns {Promise<Array>} List of instruments
 */
async function getInstruments(exchange) {
  try {
    const k = getKite();
    const data = await k.getInstruments(exchange);
    return data;
  } catch (error) {
    logger.error('Failed to fetch instruments', { exchange, error: error.message });
    throw error;
  }
}

/**
 * Get option chain for NIFTY
 * @param {Date} expiry - Expiry date
 * @returns {Promise<Object>} Option chain with CE and PE options
 */
async function getOptionChain(expiry) {
  try {
    const k = getKite();

    // Get all NFO instruments
    const instruments = await k.getInstruments('NFO');

    // Format expiry date
    const expiryDate = expiry || getNextWeeklyExpiry();
    const expiryStr = formatDateForKite(expiryDate);

    // Filter NIFTY options for the given expiry
    const niftyOptions = instruments.filter(inst => {
      return (
        inst.name === 'NIFTY' &&
        inst.segment === 'NFO-OPT' &&
        formatDateForKite(new Date(inst.expiry)) === expiryStr
      );
    });

    // Separate CE and PE options
    const ceOptions = niftyOptions
      .filter(opt => opt.instrument_type === 'CE')
      .sort((a, b) => a.strike - b.strike);

    const peOptions = niftyOptions
      .filter(opt => opt.instrument_type === 'PE')
      .sort((a, b) => a.strike - b.strike);

    logger.info('Option chain fetched', {
      expiry: expiryStr,
      ceCount: ceOptions.length,
      peCount: peOptions.length,
    });

    return {
      expiry: expiryStr,
      ce: ceOptions,
      pe: peOptions,
    };
  } catch (error) {
    logger.error('Failed to fetch option chain', { error: error.message });
    throw error;
  }
}

/**
 * Get NIFTY spot price
 * @returns {Promise<number>} Current NIFTY spot price
 */
async function getNiftySpot() {
  try {
    const ltp = await getLTP([config.trading.niftySymbol]);
    return ltp[config.trading.niftySymbol].last_price;
  } catch (error) {
    logger.error('Failed to fetch NIFTY spot', { error: error.message });
    throw error;
  }
}

/**
 * Get NIFTY instrument token (for historical data)
 * @returns {Promise<number>} Instrument token
 */
async function getNiftyInstrumentToken() {
  try {
    const instruments = await getInstruments('NSE');
    const nifty = instruments.find(i => i.tradingsymbol === 'NIFTY 50');
    if (!nifty) {
      throw new Error('NIFTY 50 instrument not found');
    }
    return nifty.instrument_token;
  } catch (error) {
    logger.error('Failed to get NIFTY instrument token', { error: error.message });
    throw error;
  }
}

module.exports = {
  initKite,
  getKite,
  login,
  isAuthenticated,
  getHistoricalData,
  getLTP,
  getQuote,
  getOHLC,
  getInstruments,
  getOptionChain,
  getNiftySpot,
  getNiftyInstrumentToken,
};
