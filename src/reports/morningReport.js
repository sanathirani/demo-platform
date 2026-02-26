/**
 * Morning Report Generator
 *
 * Generates daily 7 AM briefing with last 5 trading days analysis:
 * - OHLC data for each day
 * - Day type classification (A-Day/C-Day)
 * - Day behavior (gap, close position, trend)
 * - Key levels (PDH, PDL, Pivot, R1, S1)
 * - Weekly summary
 * - Today's setup
 */

const brokerService = require('../services/brokerService');
const alertService = require('../services/alertService');
const { logger } = require('../utils/logger');
const { formatDateForKite, getISTNow, formatTimeForAlert, getLastNTradingDays } = require('../utils/timeUtils');

/**
 * Classify day type based on price action
 * @param {Object} candle - Day candle with OHLC
 * @returns {Object} { type, direction }
 */
function classifyDayType(candle) {
  if (!candle || !candle.open) return { type: 'UNKNOWN', direction: null };

  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = range > 0 ? body / range : 0;

  if (bodyRatio >= 0.6 && range >= 100) {
    const direction = candle.close > candle.open ? 'BULLISH' : 'BEARISH';
    return { type: 'A-DAY', direction };
  } else if (bodyRatio < 0.3 && range < 80) {
    return { type: 'CONSOLIDATION', direction: null };
  } else if (range > 150) {
    return { type: 'VOLATILE', direction: null };
  } else {
    return { type: 'C-DAY', direction: null };
  }
}

/**
 * Analyze day behavior
 * @param {Object} candle - Day candle
 * @param {number} prevClose - Previous day's close
 * @returns {Object} Behavior analysis
 */
function analyzeDayBehavior(candle, prevClose) {
  if (!candle || !candle.open) return null;

  const range = candle.high - candle.low;
  const gap = candle.open - prevClose;
  const closePosition = range > 0 ? (candle.close - candle.low) / range : 0.5;

  // Gap analysis
  let gapAnalysis;
  if (gap > 30) {
    gapAnalysis = `Gap UP (+${gap.toFixed(0)} pts)`;
  } else if (gap < -30) {
    gapAnalysis = `Gap DOWN (${gap.toFixed(0)} pts)`;
  } else {
    gapAnalysis = `Flat open (${gap >= 0 ? '+' : ''}${gap.toFixed(0)} pts)`;
  }

  // Close position analysis
  let closeAnalysis;
  if (closePosition >= 0.7) {
    closeAnalysis = 'Closed near day HIGH (upper 30%)';
  } else if (closePosition <= 0.3) {
    closeAnalysis = 'Closed near day LOW (lower 30%)';
  } else {
    closeAnalysis = 'Closed in middle of range';
  }

  // Trend pattern (based on body ratio and direction)
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = range > 0 ? body / range : 0;
  let trendPattern;
  if (bodyRatio >= 0.6) {
    trendPattern = 'Strong trending day, minimal pullbacks';
  } else if (bodyRatio >= 0.4) {
    trendPattern = 'Moderate trend with some choppiness';
  } else {
    trendPattern = 'Choppy/range-bound action';
  }

  return {
    gap,
    gapAnalysis,
    closePosition,
    closeAnalysis,
    trendPattern,
  };
}

/**
 * Calculate key levels from candle
 * @param {Object} candle - Day candle
 * @returns {Object} Key levels
 */
function calculateLevels(candle) {
  if (!candle) return null;

  const { high, low, close } = candle;
  const pivot = (high + low + close) / 3;

  return {
    pdh: Math.round(high),
    pdl: Math.round(low),
    pivot: Math.round(pivot),
    r1: Math.round((2 * pivot) - low),
    s1: Math.round((2 * pivot) - high),
  };
}

/**
 * Analyze a single trading day
 * @param {Object} candle - Day candle
 * @param {number} prevClose - Previous day's close
 * @param {number} avgVolume - 20-day average volume
 * @returns {Object} Day analysis
 */
function analyzeSingleDay(candle, prevClose, avgVolume) {
  const dayType = classifyDayType(candle);
  const behavior = analyzeDayBehavior(candle, prevClose);
  const levels = calculateLevels(candle);

  const range = candle.high - candle.low;
  const change = candle.close - prevClose;
  const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = range > 0 ? (body / range) * 100 : 0;
  const volumeStatus = candle.volume > avgVolume ? 'Above Avg' : 'Below Avg';

  return {
    date: candle.date,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    range: Math.round(range),
    change: Math.round(change),
    changePercent: changePercent.toFixed(2),
    bodyRatio: Math.round(bodyRatio),
    volumeStatus,
    dayType: dayType.type,
    dayDirection: dayType.direction,
    behavior,
    levels,
  };
}

/**
 * Generate morning report data
 * @returns {Promise<Object>} Report data
 */
async function generateMorningReport() {
  try {
    const now = getISTNow();
    logger.info('Generating morning report');

    // Get last 5 trading days
    const tradingDays = getLastNTradingDays(5);
    const instrumentToken = await brokerService.getNiftyInstrumentToken();

    // Fetch day candles for date range (oldest to newest for proper prev close)
    const oldestDate = formatDateForKite(tradingDays[tradingDays.length - 1]);
    const newestDate = formatDateForKite(tradingDays[0]);

    // Need one extra day before oldest for prev close calculation
    const extraDay = new Date(tradingDays[tradingDays.length - 1]);
    extraDay.setDate(extraDay.getDate() - 1);
    while (extraDay.getDay() === 0 || extraDay.getDay() === 6) {
      extraDay.setDate(extraDay.getDate() - 1);
    }
    const startDate = formatDateForKite(extraDay);

    const dayCandles = await brokerService.getHistoricalData(
      instrumentToken,
      'day',
      startDate,
      newestDate
    );

    if (!dayCandles || dayCandles.length < 2) {
      throw new Error('Insufficient historical data');
    }

    // Calculate 20-day average volume (use available data)
    const avgVolume = dayCandles.reduce((sum, c) => sum + (c.volume || 0), 0) / dayCandles.length;

    // Analyze each of the 5 days
    const daysAnalysis = [];
    for (let i = 1; i < dayCandles.length && daysAnalysis.length < 5; i++) {
      const candle = dayCandles[i];
      const prevClose = dayCandles[i - 1].close;
      const analysis = analyzeSingleDay(candle, prevClose, avgVolume);
      daysAnalysis.push(analysis);
    }

    // Reverse so most recent is first
    daysAnalysis.reverse();

    // Calculate weekly summary
    const weeklySummary = calculateWeeklySummary(daysAnalysis);

    // Today's setup (based on most recent day)
    const todaySetup = generateTodaySetup(daysAnalysis[0]);

    const report = {
      generatedAt: formatTimeForAlert(now),
      reportDate: formatDateForKite(now),
      days: daysAnalysis,
      weeklySummary,
      todaySetup,
    };

    logger.info('Morning report generated', {
      days: daysAnalysis.length,
      aDays: weeklySummary.aDayCount,
    });

    return report;
  } catch (error) {
    logger.error('Failed to generate morning report', { error: error.message });
    throw error;
  }
}

/**
 * Calculate weekly summary from days analysis
 * @param {Array} days - Array of day analyses
 * @returns {Object} Weekly summary
 */
function calculateWeeklySummary(days) {
  const aDays = days.filter(d => d.dayType === 'A-DAY');
  const cDays = days.filter(d => d.dayType === 'C-DAY');
  const volatileDays = days.filter(d => d.dayType === 'VOLATILE');
  const consolidationDays = days.filter(d => d.dayType === 'CONSOLIDATION');

  const netChange = days.reduce((sum, d) => sum + d.change, 0);
  const netChangePercent = days.reduce((sum, d) => sum + parseFloat(d.changePercent), 0);
  const avgRange = days.reduce((sum, d) => sum + d.range, 0) / days.length;

  return {
    aDayCount: aDays.length,
    aDayBullish: aDays.filter(d => d.dayDirection === 'BULLISH').length,
    aDayBearish: aDays.filter(d => d.dayDirection === 'BEARISH').length,
    cDayCount: cDays.length,
    volatileCount: volatileDays.length,
    consolidationCount: consolidationDays.length,
    netChange: Math.round(netChange),
    netChangePercent: netChangePercent.toFixed(2),
    avgRange: Math.round(avgRange),
  };
}

/**
 * Generate today's setup from previous day
 * @param {Object} prevDay - Previous day analysis
 * @returns {Object} Today's setup
 */
function generateTodaySetup(prevDay) {
  if (!prevDay) return null;

  const isActive = prevDay.dayType === 'A-DAY';
  let expectation;
  let watchLevels;

  if (isActive) {
    const direction = prevDay.dayDirection === 'BULLISH' ? 'bullish' : 'bearish';
    expectation = `Follow-through in ${direction} direction expected`;
    watchLevels = prevDay.dayDirection === 'BULLISH'
      ? `PDH ${prevDay.levels.pdh} for breakout, PDL ${prevDay.levels.pdl} for support`
      : `PDL ${prevDay.levels.pdl} for breakdown, PDH ${prevDay.levels.pdh} for resistance`;
  } else {
    expectation = 'No A-Day setup - system will be inactive unless force-analyze enabled';
    watchLevels = `Range: ${prevDay.levels.pdl} - ${prevDay.levels.pdh}`;
  }

  return {
    prevDayType: prevDay.dayType,
    prevDayDirection: prevDay.dayDirection,
    systemActive: isActive,
    expectation,
    watchLevels,
    keyLevels: prevDay.levels,
  };
}

/**
 * Format day name from date string
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {string} Day name (Mon, Tue, etc.)
 */
function getDayName(dateStr) {
  const date = new Date(dateStr + 'T00:00:00+05:30');
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

/**
 * Format report as HTML email
 * @param {Object} report - Report data
 * @returns {string} HTML content
 */
function formatReportHTML(report) {
  const dayCards = report.days.map(day => {
    const changeColor = day.change >= 0 ? '#28a745' : '#dc3545';
    const changeArrow = day.change >= 0 ? '▲' : '▼';
    const dayTypeColor = day.dayType === 'A-DAY'
      ? (day.dayDirection === 'BULLISH' ? '#28a745' : '#dc3545')
      : day.dayType === 'VOLATILE' ? '#fd7e14' : '#6c757d';

    return `
    <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 15px 0; border-left: 4px solid ${dayTypeColor};">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
        <div>
          <span style="font-size: 18px; font-weight: bold;">${day.date}</span>
          <span style="color: #666; margin-left: 10px;">(${getDayName(day.date)})</span>
        </div>
        <span style="background: ${dayTypeColor}; color: white; padding: 5px 15px; border-radius: 20px; font-weight: bold;">
          ${day.dayType}${day.dayDirection ? ` (${day.dayDirection})` : ''}
        </span>
      </div>

      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 15px;">
        <div style="background: white; padding: 10px; border-radius: 4px; text-align: center;">
          <div style="font-size: 11px; color: #666; text-transform: uppercase;">Open</div>
          <div style="font-size: 16px; font-weight: bold;">${day.open.toFixed(0)}</div>
        </div>
        <div style="background: white; padding: 10px; border-radius: 4px; text-align: center;">
          <div style="font-size: 11px; color: #666; text-transform: uppercase;">High</div>
          <div style="font-size: 16px; font-weight: bold; color: #28a745;">${day.high.toFixed(0)}</div>
        </div>
        <div style="background: white; padding: 10px; border-radius: 4px; text-align: center;">
          <div style="font-size: 11px; color: #666; text-transform: uppercase;">Low</div>
          <div style="font-size: 16px; font-weight: bold; color: #dc3545;">${day.low.toFixed(0)}</div>
        </div>
        <div style="background: white; padding: 10px; border-radius: 4px; text-align: center;">
          <div style="font-size: 11px; color: #666; text-transform: uppercase;">Close</div>
          <div style="font-size: 16px; font-weight: bold;">${day.close.toFixed(0)}</div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 15px;">
        <div style="background: white; padding: 10px; border-radius: 4px; text-align: center;">
          <div style="font-size: 11px; color: #666;">Change</div>
          <div style="font-size: 14px; font-weight: bold; color: ${changeColor};">${changeArrow} ${Math.abs(day.change)} pts (${day.changePercent}%)</div>
        </div>
        <div style="background: white; padding: 10px; border-radius: 4px; text-align: center;">
          <div style="font-size: 11px; color: #666;">Range</div>
          <div style="font-size: 14px; font-weight: bold;">${day.range} pts</div>
        </div>
        <div style="background: white; padding: 10px; border-radius: 4px; text-align: center;">
          <div style="font-size: 11px; color: #666;">Body Ratio</div>
          <div style="font-size: 14px; font-weight: bold;">${day.bodyRatio}%</div>
        </div>
      </div>

      <div style="background: #e7f3ff; padding: 12px; border-radius: 4px; margin-bottom: 10px;">
        <div style="font-weight: bold; margin-bottom: 8px; color: #1a73e8;">Day Behavior:</div>
        <div style="font-size: 13px; line-height: 1.6;">
          • ${day.behavior.gapAnalysis}<br/>
          • ${day.behavior.closeAnalysis}<br/>
          • ${day.behavior.trendPattern}
        </div>
      </div>

      <div style="font-size: 12px; color: #666;">
        <strong>Key Levels:</strong> PDH: ${day.levels.pdh} | PDL: ${day.levels.pdl} | Pivot: ${day.levels.pivot} | R1: ${day.levels.r1} | S1: ${day.levels.s1}
      </div>
    </div>`;
  }).join('');

  const summary = report.weeklySummary;
  const setup = report.todaySetup;
  const setupColor = setup.systemActive ? '#28a745' : '#fd7e14';

  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; background: #f5f5f5; }
    .header { background: linear-gradient(135deg, #1a73e8, #4285f4); color: white; padding: 25px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: white; padding: 25px; }
    .section-title { font-size: 16px; font-weight: bold; color: #333; margin: 25px 0 15px 0; padding-bottom: 10px; border-bottom: 2px solid #1a73e8; }
    .footer { text-align: center; padding: 20px; color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1 style="margin: 0;">Morning Briefing</h1>
    <p style="margin: 10px 0 0 0; opacity: 0.9;">${report.reportDate} | Generated at ${report.generatedAt}</p>
  </div>

  <div class="content">
    <div class="section-title">LAST 5 TRADING DAYS - DETAILED ANALYSIS</div>
    ${dayCards}

    <div class="section-title">WEEKLY SUMMARY</div>
    <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px;">
      <div>
        <div style="color: #666; font-size: 12px;">A-Days</div>
        <div style="font-size: 20px; font-weight: bold;">${summary.aDayCount} <span style="font-size: 14px; color: #666;">(${summary.aDayBullish} Bull, ${summary.aDayBearish} Bear)</span></div>
      </div>
      <div>
        <div style="color: #666; font-size: 12px;">C-Days</div>
        <div style="font-size: 20px; font-weight: bold;">${summary.cDayCount}</div>
      </div>
      <div>
        <div style="color: #666; font-size: 12px;">Net Change</div>
        <div style="font-size: 20px; font-weight: bold; color: ${summary.netChange >= 0 ? '#28a745' : '#dc3545'};">${summary.netChange >= 0 ? '+' : ''}${summary.netChange} pts (${summary.netChangePercent}%)</div>
      </div>
      <div>
        <div style="color: #666; font-size: 12px;">Avg Daily Range</div>
        <div style="font-size: 20px; font-weight: bold;">${summary.avgRange} pts</div>
      </div>
    </div>

    <div class="section-title">TODAY'S SETUP</div>
    <div style="background: ${setupColor}15; border-left: 4px solid ${setupColor}; padding: 20px; border-radius: 0 8px 8px 0;">
      <div style="font-size: 18px; font-weight: bold; margin-bottom: 10px;">
        Previous Day: ${setup.prevDayType}${setup.prevDayDirection ? ` (${setup.prevDayDirection})` : ''}
      </div>
      <div style="margin-bottom: 10px;">
        <strong>System Status:</strong>
        <span style="background: ${setupColor}; color: white; padding: 3px 10px; border-radius: 10px; font-size: 12px;">
          ${setup.systemActive ? 'ACTIVE' : 'INACTIVE'}
        </span>
      </div>
      <div style="margin-bottom: 10px;"><strong>Expectation:</strong> ${setup.expectation}</div>
      <div><strong>Watch:</strong> ${setup.watchLevels}</div>
    </div>
  </div>

  <div class="footer">
    A-Day Trading Alert System • Morning Briefing
  </div>
</body>
</html>`;
}

/**
 * Send morning report via email
 * @returns {Promise<Object>} Report data
 */
async function sendMorningReport() {
  try {
    // Login to broker if needed
    if (!brokerService.isAuthenticated()) {
      logger.info('Morning report: Logging in to broker...');
      await brokerService.login();
    }

    logger.info('Morning report: Generating report...');
    const report = await generateMorningReport();

    logger.info('Morning report: Formatting HTML...', { days: report.days.length });
    const htmlReport = formatReportHTML(report);

    logger.info('Morning report: HTML generated', { htmlSize: htmlReport.length });

    const subject = `Morning Briefing: ${report.reportDate} | ${report.todaySetup.prevDayType}${report.todaySetup.prevDayDirection ? ` (${report.todaySetup.prevDayDirection})` : ''} | System ${report.todaySetup.systemActive ? 'ACTIVE' : 'INACTIVE'}`;

    logger.info('Morning report: Sending email...', { subject });
    await alertService.sendEmail(subject, htmlReport);

    logger.info('Morning report sent successfully', { date: report.reportDate });
    return report;
  } catch (error) {
    logger.error('Failed to send morning report', { error: error.message, stack: error.stack });
    throw error;
  }
}

module.exports = {
  classifyDayType,
  analyzeDayBehavior,
  calculateLevels,
  analyzeSingleDay,
  generateMorningReport,
  calculateWeeklySummary,
  generateTodaySetup,
  formatReportHTML,
  sendMorningReport,
};
