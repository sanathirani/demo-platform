/**
 * Time utilities for market hours and trading windows
 * All times are in IST (Indian Standard Time)
 */

/**
 * Get current time in IST
 * @returns {Date} Current date in IST
 */
function getISTNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

/**
 * Get current time string in HH:mm format
 * @returns {string} Time in HH:mm format
 */
function getCurrentTimeString() {
  const now = getISTNow();
  return now.toTimeString().slice(0, 5);
}

/**
 * Parse time string to minutes since midnight
 * @param {string} timeStr - Time in HH:mm format
 * @returns {number} Minutes since midnight
 */
function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Check if current time is within a time window
 * @param {string} startTime - Start time in HH:mm format
 * @param {string} endTime - End time in HH:mm format
 * @returns {boolean}
 */
function isWithinTimeWindow(startTime, endTime) {
  const now = timeToMinutes(getCurrentTimeString());
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  return now >= start && now <= end;
}

/**
 * Check if market is open (9:15 AM - 3:30 PM IST, weekdays)
 * @returns {boolean}
 */
function isMarketOpen() {
  const now = getISTNow();
  const day = now.getDay();

  // Market closed on weekends (0 = Sunday, 6 = Saturday)
  if (day === 0 || day === 6) {
    return false;
  }

  return isWithinTimeWindow('09:15', '15:30');
}

/**
 * Check if today is a trading day (weekday)
 * @returns {boolean}
 */
function isTradingDay() {
  const now = getISTNow();
  const day = now.getDay();
  return day !== 0 && day !== 6;
}

/**
 * Check if today is Thursday (weekly expiry)
 * @returns {boolean}
 */
function isThursday() {
  return getISTNow().getDay() === 4;
}

/**
 * Check if today is expiry day (Thursday for weekly, or day before monthly)
 * @returns {boolean}
 */
function isExpiryDay() {
  // For simplicity, treating every Thursday as expiry day
  // Monthly expiry detection would require calendar lookup
  return isThursday();
}

/**
 * Get the upcoming weekly expiry date (next Thursday)
 * @returns {Date}
 */
function getNextWeeklyExpiry() {
  const now = getISTNow();
  const daysUntilThursday = (4 - now.getDay() + 7) % 7 || 7;
  const expiry = new Date(now);
  expiry.setDate(now.getDate() + daysUntilThursday);
  return expiry;
}

/**
 * Format date for Kite API (YYYY-MM-DD)
 * @param {Date} date
 * @returns {string}
 */
function formatDateForKite(date) {
  const d = date || getISTNow();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format date for Angel One API (YYYY-MM-DD HH:mm)
 * @param {Date} date
 * @returns {string}
 */
function formatDateForAngel(date) {
  const d = date || getISTNow();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Get previous trading day
 * @returns {Date}
 */
function getPreviousTradingDay() {
  const now = getISTNow();
  const prev = new Date(now);
  prev.setDate(prev.getDate() - 1);

  // Skip weekends
  while (prev.getDay() === 0 || prev.getDay() === 6) {
    prev.setDate(prev.getDate() - 1);
  }

  return prev;
}

/**
 * Get the last completed trading day
 * - If before 3:45 PM IST, returns previous trading day
 * - If 3:45 PM or later on a weekday, returns today
 * - On weekends, returns previous trading day (Friday)
 * @returns {Date}
 */
function getLastCompletedTradingDay() {
  const now = getISTNow();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const day = now.getDay();

  // On weekends, use previous trading day (Friday)
  if (day === 0 || day === 6) {
    return getPreviousTradingDay();
  }

  // If before 3:45 PM (post-market report time), use previous trading day
  if (hours < 15 || (hours === 15 && minutes < 45)) {
    return getPreviousTradingDay();
  }

  // If 3:45 PM or later on a weekday, use today
  return now;
}

/**
 * Get date N trading days ago
 * @param {number} days - Number of trading days
 * @returns {Date}
 */
function getTradingDaysAgo(days) {
  const date = getISTNow();
  let count = 0;

  while (count < days) {
    date.setDate(date.getDate() - 1);
    if (date.getDay() !== 0 && date.getDay() !== 6) {
      count++;
    }
  }

  return date;
}

/**
 * Format time for display in alerts
 * @param {Date} date
 * @returns {string} e.g., "10:02 AM"
 */
function formatTimeForAlert(date) {
  const d = date || getISTNow();
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  getISTNow,
  getCurrentTimeString,
  timeToMinutes,
  isWithinTimeWindow,
  isMarketOpen,
  isTradingDay,
  isThursday,
  isExpiryDay,
  getNextWeeklyExpiry,
  formatDateForKite,
  formatDateForAngel,
  getPreviousTradingDay,
  getLastCompletedTradingDay,
  getTradingDaysAgo,
  formatTimeForAlert,
  sleep,
};
