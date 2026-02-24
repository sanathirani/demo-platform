const winston = require('winston');
const path = require('path');

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `[${timestamp}] ${level}: ${message} ${metaStr}`;
  })
);

// Custom format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.json()
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // File transport for errors only
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // File transport for signals/alerts
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/signals.log'),
      level: 'info',
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 10,
    }),
  ],
});

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Log a trading signal
 * @param {string} strategy - Strategy name (ORB, PULLBACK, EXPIRY)
 * @param {Object} signal - Signal details
 */
function logSignal(strategy, signal) {
  logger.info(`SIGNAL: ${strategy}`, {
    type: 'SIGNAL',
    strategy,
    ...signal,
  });
}

/**
 * Log an alert being sent
 * @param {string} channel - Alert channel (WHATSAPP, EMAIL, SMS)
 * @param {boolean} success - Whether alert was sent successfully
 * @param {string} message - Alert message or error
 */
function logAlert(channel, success, message) {
  const level = success ? 'info' : 'error';
  logger[level](`ALERT ${channel}: ${success ? 'SENT' : 'FAILED'}`, {
    type: 'ALERT',
    channel,
    success,
    message: message.substring(0, 100), // Truncate for log
  });
}

/**
 * Log A-Day detection result
 * @param {boolean} isADay - Whether today is an A-Day
 * @param {string} reason - Reason for classification
 * @param {Object} data - Supporting data
 */
function logADayCheck(isADay, reason, data) {
  logger.info(`A-DAY CHECK: ${isADay ? 'YES' : 'NO'}`, {
    type: 'ADAY_CHECK',
    isADay,
    reason,
    ...data,
  });
}

module.exports = {
  logger,
  logSignal,
  logAlert,
  logADayCheck,
};
