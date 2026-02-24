const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

const config = {
  // Broker Selection (kite or angel)
  broker: {
    type: (process.env.BROKER_TYPE || 'kite').toLowerCase(),
  },

  // Zerodha Kite API
  kite: {
    apiKey: process.env.KITE_API_KEY,
    apiSecret: process.env.KITE_API_SECRET,
    accessToken: process.env.KITE_ACCESS_TOKEN,
  },

  // Angel One SmartAPI
  angel: {
    clientCode: process.env.ANGEL_CLIENT_CODE,
    password: process.env.ANGEL_PASSWORD,
    totpSecret: process.env.ANGEL_TOTP_SECRET,
    apiKey: process.env.ANGEL_API_KEY,
    secretKey: process.env.ANGEL_SECRET_KEY,
  },

  // Twilio (WhatsApp + SMS)
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
    smsFrom: process.env.TWILIO_SMS_FROM,
  },

  // Email (Gmail)
  email: {
    user: process.env.EMAIL_USER,
    appPassword: process.env.EMAIL_APP_PASSWORD,
  },

  // Alert Recipients
  alerts: {
    phone: process.env.ALERT_PHONE,
    email: process.env.ALERT_EMAIL,
  },

  // Trading Config
  trading: {
    maxLossPerTrade: parseInt(process.env.MAX_LOSS_PER_TRADE, 10) || 300000,
    premiumMin: parseInt(process.env.PREMIUM_MIN, 10) || 80,
    premiumMax: parseInt(process.env.PREMIUM_MAX, 10) || 150,
    niftySymbol: 'NSE:NIFTY 50',
    niftyFutSymbol: 'NFO:NIFTY', // Will be appended with expiry
    lotSize: 25,
  },

  // Server Config
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
  },

  // Time Config (IST)
  time: {
    marketOpen: '09:15',
    marketClose: '15:30',
    orbCaptureTime: '09:30',
    orbEndTime: '10:30',
    pullbackStartTime: '10:15',
    pullbackEndTime: '13:30',
    expiryStartTime: '11:00',
    expiryEndTime: '14:00',
  },
};

/**
 * Validate required configuration based on selected broker
 * @returns {Object} { isValid: boolean, missingKeys: string[] }
 */
function validateConfig() {
  // Common required keys (alerts/notifications)
  const commonKeys = [
    { key: 'twilio.accountSid', value: config.twilio.accountSid },
    { key: 'twilio.authToken', value: config.twilio.authToken },
    { key: 'email.user', value: config.email.user },
    { key: 'email.appPassword', value: config.email.appPassword },
    { key: 'alerts.phone', value: config.alerts.phone },
    { key: 'alerts.email', value: config.alerts.email },
  ];

  // Broker-specific required keys
  let brokerKeys = [];
  if (config.broker.type === 'angel') {
    brokerKeys = [
      { key: 'angel.clientCode', value: config.angel.clientCode },
      { key: 'angel.password', value: config.angel.password },
      { key: 'angel.totpSecret', value: config.angel.totpSecret },
      { key: 'angel.apiKey', value: config.angel.apiKey },
    ];
  } else {
    // Default to Kite
    brokerKeys = [
      { key: 'kite.apiKey', value: config.kite.apiKey },
      { key: 'kite.apiSecret', value: config.kite.apiSecret },
    ];
  }

  const requiredKeys = [...commonKeys, ...brokerKeys];

  const missingKeys = requiredKeys
    .filter(({ value }) => !value)
    .map(({ key }) => key);

  return {
    isValid: missingKeys.length === 0,
    missingKeys,
  };
}

module.exports = {
  config,
  validateConfig,
};
