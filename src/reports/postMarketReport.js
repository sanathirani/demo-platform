/**
 * Post-Market Report Generator
 *
 * Generates comprehensive end-of-day analysis at 3:45 PM IST:
 * - Day summary (OHLC, change, range)
 * - Day type classification (A-Day/C-Day)
 * - Intraday reversals with magnitude
 * - Key levels analysis
 * - Strategy performance summary
 * - Tomorrow's key levels
 * - Market outlook
 */

const brokerService = require('../services/brokerService');
const alertService = require('../services/alertService');
const telegramService = require('../services/telegramService');
const { logger } = require('../utils/logger');
const { formatDateForKite, getISTNow, formatTimeForAlert } = require('../utils/timeUtils');
const reversalDetector = require('../analyzers/reversalDetector');
const oiAnalyzer = require('../analyzers/oiAnalyzer');

// Track signals sent today (populated by index.js)
let todaySignals = [];

/**
 * Set today's signals for the report
 * @param {Array} signals - Signals sent today
 */
function setTodaySignals(signals) {
  todaySignals = signals || [];
}

/**
 * Add a signal to today's list
 * @param {Object} signal
 */
function addSignal(signal) {
  todaySignals.push({
    strategy: signal.primaryStrategy || signal.strategy,
    direction: signal.direction,
    time: signal.time || new Date(),
    confidence: signal.confidenceScore,
  });
}

/**
 * Generate complete post-market report
 * @param {Object} adayStatus - A-Day status for today
 * @returns {Promise<Object>} Report data
 */
async function generateReport(adayStatus = {}) {
  try {
    const now = getISTNow();
    const today = formatDateForKite(now);

    logger.info('Generating post-market report', { date: today });

    const instrumentToken = await brokerService.getNiftyInstrumentToken();

    // Get today's day candle
    const dayCandles = await brokerService.getHistoricalData(
      instrumentToken,
      'day',
      today,
      today
    );

    // Get today's 5-minute candles for detailed analysis
    const intradayCandles = await brokerService.getHistoricalData(
      instrumentToken,
      '5minute',
      today,
      today
    );

    // Day summary
    let daySummary = {
      date: today,
      open: null,
      high: null,
      low: null,
      close: null,
      change: null,
      changePercent: null,
      range: null,
      volume: null,
    };

    if (dayCandles && dayCandles.length > 0) {
      const dayCandle = dayCandles[0];
      const prevClose = adayStatus?.data?.close || dayCandle.open;

      daySummary = {
        date: today,
        open: dayCandle.open,
        high: dayCandle.high,
        low: dayCandle.low,
        close: dayCandle.close,
        change: dayCandle.close - prevClose,
        changePercent: ((dayCandle.close - prevClose) / prevClose) * 100,
        range: dayCandle.high - dayCandle.low,
        volume: dayCandle.volume,
      };
    } else if (intradayCandles && intradayCandles.length > 0) {
      // Fallback to intraday data
      const open = intradayCandles[0].open;
      const close = intradayCandles[intradayCandles.length - 1].close;
      const high = Math.max(...intradayCandles.map(c => c.high));
      const low = Math.min(...intradayCandles.map(c => c.low));
      const prevClose = adayStatus?.data?.close || open;

      daySummary = {
        date: today,
        open,
        high,
        low,
        close,
        change: close - prevClose,
        changePercent: ((close - prevClose) / prevClose) * 100,
        range: high - low,
        volume: intradayCandles.reduce((sum, c) => sum + (c.volume || 0), 0),
      };
    }

    // Determine today's day type
    const dayType = classifyDayType(daySummary);

    // Get reversals
    const reversalSummary = reversalDetector.getDailySummary();

    // Get OI analysis
    const oiData = await oiAnalyzer.analyze();

    // Calculate tomorrow's levels
    const tomorrowLevels = calculateTomorrowLevels(daySummary);

    // Generate outlook
    const outlook = generateOutlook(daySummary, dayType, adayStatus, reversalSummary);

    // Strategy performance
    const strategyPerformance = analyzeStrategyPerformance(todaySignals);

    const report = {
      date: today,
      generatedAt: formatTimeForAlert(now),

      // Day summary
      ...daySummary,
      dayType,

      // Previous day context
      previousDayWasADay: adayStatus?.isADay || false,
      previousDayDirection: adayStatus?.direction || null,

      // Reversals
      reversals: reversalSummary.reversals || [],
      reversalCount: reversalSummary.total || 0,
      totalReversalMagnitude: reversalSummary.totalMagnitude || 0,

      // OI data
      pcrRatio: oiData?.pcrRatio,
      maxPain: oiData?.maxPain,
      oiLevels: oiData?.oiLevels,

      // Signals
      signalsSent: todaySignals,
      signalCount: todaySignals.length,

      // Strategy performance
      strategyPerformance,

      // Tomorrow
      tomorrowLevels,
      outlook,
    };

    logger.info('Post-market report generated', {
      date: today,
      dayType,
      signalCount: todaySignals.length,
      reversalCount: reversalSummary.total,
    });

    return report;
  } catch (error) {
    logger.error('Failed to generate post-market report', { error: error.message });
    throw error;
  }
}

/**
 * Classify day type based on price action
 * @param {Object} daySummary
 * @returns {string}
 */
function classifyDayType(daySummary) {
  if (!daySummary || !daySummary.open) return 'UNKNOWN';

  const bodyRatio = Math.abs(daySummary.close - daySummary.open) / daySummary.range;
  const changePercent = Math.abs(daySummary.changePercent);

  if (bodyRatio >= 0.6 && daySummary.range >= 100) {
    return daySummary.close > daySummary.open ? 'A-DAY (BULLISH)' : 'A-DAY (BEARISH)';
  } else if (bodyRatio < 0.3 && daySummary.range < 80) {
    return 'CONSOLIDATION';
  } else if (daySummary.range > 150) {
    return 'VOLATILE';
  } else {
    return 'C-DAY';
  }
}

/**
 * Calculate tomorrow's key levels
 * @param {Object} daySummary
 * @returns {Object}
 */
function calculateTomorrowLevels(daySummary) {
  if (!daySummary || !daySummary.high) return null;

  const { high, low, close } = daySummary;
  const pivot = (high + low + close) / 3;

  return {
    pdh: high,
    pdl: low,
    pdc: close,
    pivot: Math.round(pivot),
    r1: Math.round((2 * pivot) - low),
    r2: Math.round(pivot + (high - low)),
    s1: Math.round((2 * pivot) - high),
    s2: Math.round(pivot - (high - low)),
  };
}

/**
 * Generate market outlook
 * @param {Object} daySummary
 * @param {string} dayType
 * @param {Object} adayStatus
 * @param {Object} reversalSummary
 * @returns {string}
 */
function generateOutlook(daySummary, dayType, adayStatus, reversalSummary) {
  const outlookParts = [];

  // Day type outlook
  if (dayType.includes('A-DAY')) {
    const direction = dayType.includes('BULLISH') ? 'bullish' : 'bearish';
    outlookParts.push(`Today was an A-Day (${direction}) - expect follow-through tomorrow.`);
    outlookParts.push(`Watch for continuation patterns in ${direction} direction.`);
  } else if (dayType === 'CONSOLIDATION') {
    outlookParts.push('Consolidation day - range-bound action.');
    outlookParts.push('Wait for breakout above/below today\'s range before taking positions.');
  } else if (dayType === 'VOLATILE') {
    outlookParts.push('Volatile day with wide range.');
    outlookParts.push('Be cautious - consider smaller position sizes.');
  } else {
    outlookParts.push('Regular trading day - no strong trend established.');
    outlookParts.push('Watch for A-Day formation tomorrow.');
  }

  // Reversal context
  if (reversalSummary.total >= 3) {
    outlookParts.push(`Multiple reversals (${reversalSummary.total}) suggest choppy conditions may continue.`);
  }

  // Key level to watch
  if (daySummary) {
    const midpoint = (daySummary.high + daySummary.low) / 2;
    if (daySummary.close > midpoint) {
      outlookParts.push(`Closed in upper half - PDH (${daySummary.high.toFixed(0)}) is key resistance.`);
    } else {
      outlookParts.push(`Closed in lower half - PDL (${daySummary.low.toFixed(0)}) is key support.`);
    }
  }

  return outlookParts.join(' ');
}

/**
 * Analyze strategy performance
 * @param {Array} signals
 * @returns {Object}
 */
function analyzeStrategyPerformance(signals) {
  const byStrategy = {};

  for (const signal of signals) {
    const name = signal.strategy || 'Unknown';
    if (!byStrategy[name]) {
      byStrategy[name] = { count: 0, directions: [] };
    }
    byStrategy[name].count++;
    byStrategy[name].directions.push(signal.direction);
  }

  return {
    totalSignals: signals.length,
    byStrategy,
    avgConfidence: signals.length > 0
      ? signals.reduce((sum, s) => sum + (s.confidence || 0), 0) / signals.length
      : 0,
  };
}

/**
 * Format report as HTML for email
 * @param {Object} report
 * @returns {string}
 */
function formatReportHTML(report) {
  const changeColor = report.change >= 0 ? '#28a745' : '#dc3545';
  const changeArrow = report.change >= 0 ? '▲' : '▼';

  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; background: #f5f5f5; }
    .header { background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 25px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: white; padding: 25px; }
    .section { margin: 20px 0; padding: 20px; background: #f8f9fa; border-radius: 8px; }
    .section-title { font-size: 16px; font-weight: bold; color: #333; margin-bottom: 15px; border-bottom: 2px solid #1a73e8; padding-bottom: 10px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; }
    .stat { background: white; padding: 15px; border-radius: 8px; text-align: center; }
    .stat-label { font-size: 12px; color: #666; text-transform: uppercase; }
    .stat-value { font-size: 22px; font-weight: bold; color: #333; margin-top: 5px; }
    .change { color: ${changeColor}; }
    .day-type { display: inline-block; background: #e7f3ff; color: #1a73e8; padding: 5px 15px; border-radius: 20px; font-weight: bold; }
    .signal-item { padding: 10px; background: white; border-left: 3px solid #1a73e8; margin: 10px 0; }
    .reversal-item { padding: 8px; background: white; margin: 5px 0; border-radius: 4px; }
    .outlook { background: #e7f3ff; border-left: 4px solid #1a73e8; padding: 15px; margin: 20px 0; }
    .levels-table { width: 100%; border-collapse: collapse; }
    .levels-table td { padding: 8px; border-bottom: 1px solid #eee; }
    .levels-table td:first-child { font-weight: bold; color: #666; }
    .footer { text-align: center; padding: 20px; color: #999; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1 style="margin: 0;">📊 Post-Market Report</h1>
    <p style="margin: 10px 0 0 0; opacity: 0.9;">${report.date}</p>
  </div>

  <div class="content">
    <div style="text-align: center; margin: 20px 0;">
      <span class="day-type">${report.dayType}</span>
    </div>

    <div class="section">
      <div class="section-title">Day Summary</div>
      <div style="text-align: center; margin-bottom: 20px;">
        <div style="font-size: 36px; font-weight: bold;">${report.close?.toFixed(2) || 'N/A'}</div>
        <div class="change" style="font-size: 18px;">
          ${changeArrow} ${Math.abs(report.change || 0).toFixed(2)} (${(report.changePercent || 0).toFixed(2)}%)
        </div>
      </div>
      <div class="grid">
        <div class="stat">
          <div class="stat-label">Open</div>
          <div class="stat-value">${report.open?.toFixed(0) || 'N/A'}</div>
        </div>
        <div class="stat">
          <div class="stat-label">High</div>
          <div class="stat-value">${report.high?.toFixed(0) || 'N/A'}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Low</div>
          <div class="stat-value">${report.low?.toFixed(0) || 'N/A'}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Range</div>
          <div class="stat-value">${report.range?.toFixed(0) || 'N/A'} pts</div>
        </div>
      </div>
    </div>

    ${report.reversals && report.reversals.length > 0 ? `
    <div class="section">
      <div class="section-title">Intraday Reversals (${report.reversalCount})</div>
      ${report.reversals.slice(0, 5).map(r => `
        <div class="reversal-item">
          <strong>${r.type}</strong>: ${r.magnitude} pts at ${r.time}
        </div>
      `).join('')}
      <div style="margin-top: 10px; color: #666;">
        Total reversal magnitude: ${report.totalReversalMagnitude} pts
      </div>
    </div>
    ` : ''}

    ${report.signalsSent && report.signalsSent.length > 0 ? `
    <div class="section">
      <div class="section-title">Signals Sent (${report.signalCount})</div>
      ${report.signalsSent.map(s => `
        <div class="signal-item">
          <strong>${s.strategy}</strong>: ${s.direction}
          ${s.confidence ? `<span style="color: #666;">(Confidence: ${s.confidence})</span>` : ''}
        </div>
      `).join('')}
    </div>
    ` : '<div class="section"><div class="section-title">Signals</div><p>No signals sent today</p></div>'}

    ${report.tomorrowLevels ? `
    <div class="section">
      <div class="section-title">Tomorrow's Key Levels</div>
      <table class="levels-table">
        <tr><td>PDH</td><td>${report.tomorrowLevels.pdh}</td></tr>
        <tr><td>PDL</td><td>${report.tomorrowLevels.pdl}</td></tr>
        <tr><td>R1</td><td>${report.tomorrowLevels.r1}</td></tr>
        <tr><td>Pivot</td><td>${report.tomorrowLevels.pivot}</td></tr>
        <tr><td>S1</td><td>${report.tomorrowLevels.s1}</td></tr>
      </table>
    </div>
    ` : ''}

    <div class="outlook">
      <strong>💡 Outlook:</strong><br/>
      ${report.outlook || 'No outlook available'}
    </div>
  </div>

  <div class="footer">
    Generated at ${report.generatedAt} • A-Day Trading Alert System
  </div>
</body>
</html>`;
}

/**
 * Send post-market report via Email and Telegram
 * @param {Object} adayStatus
 * @returns {Promise<Object>}
 */
async function sendReport(adayStatus = {}) {
  try {
    const report = await generateReport(adayStatus);

    // Send HTML email
    const htmlReport = formatReportHTML(report);
    const subject = `📊 Post-Market: ${report.date} - ${report.dayType} | ${report.change >= 0 ? '+' : ''}${report.change?.toFixed(0) || 0}`;

    await alertService.sendEmail(subject, htmlReport);

    // Send condensed Telegram report
    if (telegramService.isReady()) {
      await telegramService.sendPostMarketReport(report);
    }

    logger.info('Post-market report sent', { date: report.date });
    return report;
  } catch (error) {
    logger.error('Failed to send post-market report', { error: error.message });
    throw error;
  }
}

/**
 * Reset for new day
 */
function reset() {
  todaySignals = [];
}

module.exports = {
  generateReport,
  sendReport,
  formatReportHTML,
  setTodaySignals,
  addSignal,
  reset,
  classifyDayType,
  calculateTomorrowLevels,
};
