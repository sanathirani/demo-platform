const { SmartAPI } = require('smartapi-javascript');
const speakeasy = require('speakeasy');
const { config } = require('../config/config');
const { logger } = require('../utils/logger');
const { formatDateForAngel, getNextWeeklyExpiry, formatDateForKite } = require('../utils/timeUtils');

let smartApi = null;
let isLoggedIn = false;
let jwtToken = null;
let refreshToken = null;

// Angel One specific constants
const NIFTY_SPOT_TOKEN = '99926000'; // Angel One's NIFTY 50 spot token
const NIFTY_SYMBOL = 'NIFTY';

// Cache for NIFTY Futures token
let niftyFuturesToken = null;
let niftyFuturesExpiry = null;

// Interval mapping: Kite format -> Angel format
const INTERVAL_MAP = {
  'minute': 'ONE_MINUTE',
  '5minute': 'FIVE_MINUTE',
  '15minute': 'FIFTEEN_MINUTE',
  '30minute': 'THIRTY_MINUTE',
  '60minute': 'ONE_HOUR',
  'day': 'ONE_DAY',
};

/**
 * Initialize SmartAPI instance
 */
function initAngel() {
  smartApi = new SmartAPI({
    api_key: config.angel.apiKey,
  });
  return smartApi;
}

/**
 * Get SmartAPI instance
 * @returns {SmartAPI}
 */
function getAngel() {
  if (!smartApi) {
    initAngel();
  }
  return smartApi;
}

/**
 * Generate TOTP from secret
 * @returns {string} 6-digit TOTP
 */
function generateTOTP() {
  return speakeasy.totp({
    secret: config.angel.totpSecret,
    encoding: 'base32',
  });
}

/**
 * Handle login flow with auto-TOTP generation
 * @returns {Promise<Object>} Session data
 */
async function login() {
  try {
    const api = getAngel();
    const totp = generateTOTP();

    logger.info('Attempting Angel One login...', { clientCode: config.angel.clientCode });

    const session = await api.generateSession(
      config.angel.clientCode,
      config.angel.password,
      totp
    );

    if (session.status === false) {
      throw new Error(session.message || 'Angel One login failed');
    }

    jwtToken = session.data.jwtToken;
    refreshToken = session.data.refreshToken;
    isLoggedIn = true;

    logger.info('Angel One login successful', {
      clientCode: config.angel.clientCode,
      name: session.data.name,
    });

    return session.data;
  } catch (error) {
    logger.error('Angel One login failed', { error: error.message });
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
 * Convert Angel candle data to Kite format
 * Angel returns: [timestamp, open, high, low, close, volume]
 * Kite format: {date, open, high, low, close, volume}
 */
function convertCandleFormat(angelCandles) {
  if (!angelCandles || !Array.isArray(angelCandles)) {
    return [];
  }

  return angelCandles.map(candle => ({
    date: new Date(candle[0]),
    open: candle[1],
    high: candle[2],
    low: candle[3],
    close: candle[4],
    volume: candle[5],
  }));
}

/**
 * Get historical OHLCV data
 * @param {string} instrumentToken - Instrument token (symboltoken for Angel)
 * @param {string} interval - Candle interval (minute, 5minute, 15minute, day)
 * @param {Date|string} from - Start date
 * @param {Date|string} to - End date
 * @returns {Promise<Array>} Array of candles in Kite format
 */
async function getHistoricalData(instrumentToken, interval, from, to) {
  try {
    const api = getAngel();
    const angelInterval = INTERVAL_MAP[interval] || 'ONE_DAY';

    // Convert dates to Angel format (YYYY-MM-DD HH:mm)
    // If string is in Kite format (YYYY-MM-DD), add default times
    let fromDate, toDate;
    let fromDateOnly, toDateOnly;

    if (typeof from === 'string') {
      fromDateOnly = from.split(' ')[0];
      fromDate = from.includes(' ') ? from : `${from} 09:15`;
    } else {
      fromDateOnly = formatDateForKite(from);
      fromDate = formatDateForAngel(from);
    }

    if (typeof to === 'string') {
      toDateOnly = to.split(' ')[0];
      toDate = to.includes(' ') ? to : `${to} 15:30`;
    } else {
      toDateOnly = formatDateForKite(to);
      toDate = formatDateForAngel(to);
    }

    // Angel API quirk: for daily candles, single day range returns empty
    // Extend from date by 5 days if same day requested
    if (angelInterval === 'ONE_DAY' && fromDateOnly === toDateOnly) {
      const extendedFrom = new Date(fromDateOnly);
      extendedFrom.setDate(extendedFrom.getDate() - 5);
      fromDate = `${formatDateForKite(extendedFrom)} 09:15`;
    }

    // For NIFTY spot index use NSE, for futures/options use NFO
    const exchange = instrumentToken === NIFTY_SPOT_TOKEN ? 'NSE' : 'NFO';

    const params = {
      exchange: exchange,
      symboltoken: instrumentToken,
      interval: angelInterval,
      fromdate: fromDate,
      todate: toDate,
    };

    const response = await api.getCandleData(params);

    if (response.status === false) {
      throw new Error(response.message || 'Failed to fetch candle data');
    }

    let candles = convertCandleFormat(response.data);

    // If we extended the range for single day query, filter to requested date only
    if (angelInterval === 'ONE_DAY' && fromDateOnly === toDateOnly) {
      candles = candles.filter(c => {
        const candleDate = formatDateForKite(new Date(c.date));
        return candleDate === toDateOnly;
      });
    }

    logger.debug('Historical data fetched (Angel)', {
      instrumentToken,
      interval,
      from: fromDate,
      to: toDate,
      candles: candles.length,
    });

    return candles;
  } catch (error) {
    logger.error('Failed to fetch historical data (Angel)', {
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
 * @returns {Promise<Object>} LTP data in Kite format
 */
async function getLTP(instruments) {
  try {
    const api = getAngel();
    const instrumentList = Array.isArray(instruments) ? instruments : [instruments];
    const result = {};

    // Build exchange data for marketData API
    const exchangeTokens = { NSE: [], NFO: [] };

    for (const inst of instrumentList) {
      const [exchange, symbol] = inst.split(':');

      let symbolToken;
      if (symbol === 'NIFTY 50') {
        symbolToken = NIFTY_SPOT_TOKEN;
        exchangeTokens.NSE.push(symbolToken);
      } else {
        const tokenInfo = await getSymbolToken(exchange === 'NSE' ? 'NSE' : 'NFO', symbol);
        symbolToken = tokenInfo.token;
        const exch = exchange === 'NSE' ? 'NSE' : 'NFO';
        exchangeTokens[exch].push(symbolToken);
      }
    }

    // Call marketData API with mode LTP
    const exchangeData = {};
    if (exchangeTokens.NSE.length > 0) exchangeData.NSE = exchangeTokens.NSE;
    if (exchangeTokens.NFO.length > 0) exchangeData.NFO = exchangeTokens.NFO;

    const response = await api.marketData({
      mode: 'LTP',
      exchangeTokens: exchangeData,
    });

    if (response.status === false) {
      throw new Error(response.message || 'Failed to fetch LTP');
    }

    // Map response back to instrument format
    const fetchedData = response.data?.fetched || [];
    for (const inst of instrumentList) {
      const [exchange, symbol] = inst.split(':');
      let symbolToken;
      if (symbol === 'NIFTY 50') {
        symbolToken = NIFTY_SPOT_TOKEN;
      } else {
        const tokenInfo = await getSymbolToken(exchange === 'NSE' ? 'NSE' : 'NFO', symbol);
        symbolToken = tokenInfo.token;
      }

      const data = fetchedData.find(d => d.symbolToken === symbolToken);
      result[inst] = {
        instrument_token: symbolToken,
        last_price: data?.ltp || 0,
      };
    }

    return result;
  } catch (error) {
    logger.error('Failed to fetch LTP (Angel)', { instruments, error: error.message });
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
    const api = getAngel();
    const instrumentList = Array.isArray(instruments) ? instruments : [instruments];
    const result = {};

    // Build exchange data for marketData API
    const exchangeTokens = { NSE: [], NFO: [] };
    const tokenToInst = {};

    for (const inst of instrumentList) {
      const [exchange, symbol] = inst.split(':');

      let symbolToken;
      if (symbol === 'NIFTY 50') {
        symbolToken = NIFTY_SPOT_TOKEN;
        exchangeTokens.NSE.push(symbolToken);
      } else {
        const tokenInfo = await getSymbolToken(exchange === 'NSE' ? 'NSE' : 'NFO', symbol);
        symbolToken = tokenInfo.token;
        const exch = exchange === 'NSE' ? 'NSE' : 'NFO';
        exchangeTokens[exch].push(symbolToken);
      }
      tokenToInst[symbolToken] = inst;
    }

    // Call marketData API with mode FULL
    const exchangeData = {};
    if (exchangeTokens.NSE.length > 0) exchangeData.NSE = exchangeTokens.NSE;
    if (exchangeTokens.NFO.length > 0) exchangeData.NFO = exchangeTokens.NFO;

    const response = await api.marketData({
      mode: 'FULL',
      exchangeTokens: exchangeData,
    });

    if (response.status === false) {
      throw new Error(response.message || 'Failed to fetch quotes');
    }

    // Map response back to instrument format
    const fetchedData = response.data?.fetched || [];
    for (const data of fetchedData) {
      const inst = tokenToInst[data.symbolToken];
      if (inst) {
        result[inst] = {
          instrument_token: data.symbolToken,
          last_price: data.ltp || 0,
          ohlc: {
            open: data.open || 0,
            high: data.high || 0,
            low: data.low || 0,
            close: data.close || 0,
          },
          volume: (data.totBuyQuan || 0) + (data.totSellQuan || 0),
        };
      }
    }

    return result;
  } catch (error) {
    logger.error('Failed to fetch quotes (Angel)', { instruments, error: error.message });
    throw error;
  }
}

/**
 * Get OHLC for instruments (alias for getQuote, extracting OHLC)
 * @param {string[]} instruments - Array of instruments
 * @returns {Promise<Object>} OHLC data
 */
async function getOHLC(instruments) {
  return getQuote(instruments);
}

// Cache for instruments
let instrumentsCache = null;
let instrumentsCacheTime = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get symbol token from symbol name
 * @param {string} exchange - Exchange (NSE, NFO)
 * @param {string} symbol - Trading symbol
 * @returns {Promise<Object>} Token info
 */
async function getSymbolToken(exchange, symbol) {
  const instruments = await getInstruments(exchange);
  const inst = instruments.find(i => i.tradingsymbol === symbol);
  if (!inst) {
    throw new Error(`Symbol ${symbol} not found in ${exchange}`);
  }
  return inst;
}

/**
 * Get instruments list
 * @param {string} exchange - Exchange (NSE, NFO, etc.)
 * @returns {Promise<Array>} List of instruments in Kite format
 */
async function getInstruments(exchange) {
  try {
    // Check cache
    if (instrumentsCache && instrumentsCache[exchange] &&
        instrumentsCacheTime && (Date.now() - instrumentsCacheTime < CACHE_DURATION)) {
      return instrumentsCache[exchange];
    }

    // Download instrument master from Angel One
    const https = require('https');
    const instrumentUrl = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

    const rawData = await new Promise((resolve, reject) => {
      https.get(instrumentUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });

    const allInstruments = JSON.parse(rawData);

    // Filter by exchange and convert to Kite format
    const instruments = allInstruments
      .filter(inst => inst.exch_seg === exchange)
      .map(inst => ({
        instrument_token: inst.token,
        exchange_token: inst.token,
        tradingsymbol: inst.symbol,
        name: inst.name,
        last_price: 0,
        expiry: inst.expiry ? new Date(inst.expiry) : null,
        strike: parseFloat(inst.strike) || 0,
        tick_size: parseFloat(inst.tick_size) || 0.05,
        lot_size: parseInt(inst.lotsize) || 1,
        instrument_type: inst.instrumenttype,
        segment: `${exchange}-${inst.instrumenttype || 'EQ'}`,
        exchange: exchange,
        token: inst.token,
      }));

    // Cache the results
    if (!instrumentsCache) {
      instrumentsCache = {};
    }
    instrumentsCache[exchange] = instruments;
    instrumentsCacheTime = Date.now();

    logger.info('Instruments fetched (Angel)', { exchange, count: instruments.length });

    return instruments;
  } catch (error) {
    logger.error('Failed to fetch instruments (Angel)', { exchange, error: error.message });
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
    // Get all NFO instruments
    const instruments = await getInstruments('NFO');

    // Format expiry date
    const expiryDate = expiry || getNextWeeklyExpiry();
    const expiryStr = formatDateForKite(expiryDate);

    // Filter NIFTY options for the given expiry
    const niftyOptions = instruments.filter(inst => {
      if (!inst.name || inst.name !== 'NIFTY') return false;
      if (!inst.instrument_type || !['CE', 'PE'].includes(inst.instrument_type)) return false;
      if (!inst.expiry) return false;

      const instExpiryStr = formatDateForKite(new Date(inst.expiry));
      return instExpiryStr === expiryStr;
    });

    // Separate CE and PE options
    const ceOptions = niftyOptions
      .filter(opt => opt.instrument_type === 'CE')
      .sort((a, b) => a.strike - b.strike);

    const peOptions = niftyOptions
      .filter(opt => opt.instrument_type === 'PE')
      .sort((a, b) => a.strike - b.strike);

    logger.info('Option chain fetched (Angel)', {
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
    logger.error('Failed to fetch option chain (Angel)', { error: error.message });
    throw error;
  }
}

/**
 * Get near month NIFTY Futures token (for historical data with volume)
 * @returns {Promise<string>} NIFTY Futures token
 */
async function getNiftyFuturesToken() {
  // Return cached token if valid (not expired)
  if (niftyFuturesToken && niftyFuturesExpiry && new Date(niftyFuturesExpiry) > new Date()) {
    return niftyFuturesToken;
  }

  const instruments = await getInstruments('NFO');

  // Find NIFTY Futures sorted by expiry
  const niftyFutures = instruments
    .filter(i => i.name === 'NIFTY' && i.instrument_type === 'FUTIDX')
    .filter(i => i.expiry && new Date(i.expiry) > new Date()) // Not expired
    .sort((a, b) => new Date(a.expiry) - new Date(b.expiry)); // Nearest first

  if (niftyFutures.length === 0) {
    throw new Error('No NIFTY Futures found');
  }

  const nearMonth = niftyFutures[0];
  niftyFuturesToken = nearMonth.token;
  niftyFuturesExpiry = nearMonth.expiry;

  logger.info('NIFTY Futures token cached', {
    token: niftyFuturesToken,
    symbol: nearMonth.tradingsymbol,
    expiry: nearMonth.expiry,
  });

  return niftyFuturesToken;
}

/**
 * Get NIFTY spot price
 * @returns {Promise<number>} Current NIFTY spot price
 */
async function getNiftySpot() {
  try {
    const api = getAngel();
    const response = await api.marketData({
      mode: 'LTP',
      exchangeTokens: { NSE: [NIFTY_SPOT_TOKEN] },
    });

    if (response.status === false) {
      throw new Error(response.message || 'Failed to fetch NIFTY spot');
    }

    const data = response.data?.fetched?.[0];
    if (!data) {
      throw new Error('No data returned for NIFTY');
    }

    return data.ltp;
  } catch (error) {
    logger.error('Failed to fetch NIFTY spot (Angel)', { error: error.message });
    throw error;
  }
}

/**
 * Get NIFTY instrument token (for historical data)
 * Uses NIFTY Futures for volume data
 * @returns {Promise<string>} Instrument token
 */
async function getNiftyInstrumentToken() {
  // Use NIFTY Futures for historical data (has volume)
  return getNiftyFuturesToken();
}

// For interface compatibility with kiteService
function initKite() {
  return initAngel();
}

function getKite() {
  return getAngel();
}

module.exports = {
  initKite,
  getKite,
  initAngel,
  getAngel,
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
