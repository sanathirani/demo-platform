/**
 * Telegram Service
 *
 * Handles Telegram bot integration for:
 * - Sending formatted alerts
 * - Bot commands (/status, /levels, /oi, /lock, /unlock, /force)
 */

const { logger } = require('../utils/logger');

// Lazy load Telegraf to avoid issues if not installed
let Telegraf = null;
let bot = null;
let isInitialized = false;

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// State references (set by index.js)
let stateHandlers = {
  getStatus: null,
  getLevels: null,
  getOI: null,
  lockTrading: null,
  unlockTrading: null,
  toggleForceAnalyze: null,
};

/**
 * Initialize Telegram bot
 * @param {Object} handlers - State handler functions
 */
async function initialize(handlers = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    logger.warn('Telegram bot token not configured - bot disabled');
    return false;
  }

  try {
    // Try to load Telegraf
    const { Telegraf: TelegrafClass } = require('telegraf');
    Telegraf = TelegrafClass;

    bot = new Telegraf(TELEGRAM_BOT_TOKEN);
    stateHandlers = { ...stateHandlers, ...handlers };

    // Setup commands
    setupCommands();

    // Start bot (don't await - runs in background)
    bot.launch().catch(err => {
      logger.error('Telegram bot launch error', { error: err.message });
    });

    isInitialized = true;
    logger.info('Telegram bot initialized');

    // Graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

    return true;
  } catch (error) {
    logger.error('Failed to initialize Telegram bot', { error: error.message });
    return false;
  }
}

/**
 * Setup bot commands
 */
function setupCommands() {
  if (!bot) return;

  // /start - Welcome message
  bot.start(async (ctx) => {
    await ctx.reply(
      '*NIFTY A-Day Trading Alert System*\n\n' +
      'Available commands:\n' +
      '/status - Market status + A-Day info\n' +
      '/levels - Today\'s S/R levels\n' +
      '/oi - Current OI snapshot\n' +
      '/lock - Lock trading\n' +
      '/unlock - Unlock trading\n' +
      '/force - Toggle force analyze mode',
      { parse_mode: 'Markdown' }
    );
  });

  // /status - Get current market status
  bot.command('status', async (ctx) => {
    try {
      if (stateHandlers.getStatus) {
        const status = await stateHandlers.getStatus();
        const message = formatStatusMessage(status);
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('Status handler not configured');
      }
    } catch (error) {
      await ctx.reply(`Error: ${error.message}`);
    }
  });

  // /levels - Get today's S/R levels
  bot.command('levels', async (ctx) => {
    try {
      if (stateHandlers.getLevels) {
        const levels = await stateHandlers.getLevels();
        const message = formatLevelsMessage(levels);
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('Levels handler not configured');
      }
    } catch (error) {
      await ctx.reply(`Error: ${error.message}`);
    }
  });

  // /oi - Get OI snapshot
  bot.command('oi', async (ctx) => {
    try {
      if (stateHandlers.getOI) {
        const oi = await stateHandlers.getOI();
        const message = formatOIMessage(oi);
        await ctx.reply(message, { parse_mode: 'Markdown' });
      } else {
        await ctx.reply('OI handler not configured');
      }
    } catch (error) {
      await ctx.reply(`Error: ${error.message}`);
    }
  });

  // /lock - Lock trading
  bot.command('lock', async (ctx) => {
    try {
      if (stateHandlers.lockTrading) {
        stateHandlers.lockTrading();
        await ctx.reply('Trading LOCKED for today');
      } else {
        await ctx.reply('Lock handler not configured');
      }
    } catch (error) {
      await ctx.reply(`Error: ${error.message}`);
    }
  });

  // /unlock - Unlock trading
  bot.command('unlock', async (ctx) => {
    try {
      if (stateHandlers.unlockTrading) {
        stateHandlers.unlockTrading();
        await ctx.reply('Trading UNLOCKED');
      } else {
        await ctx.reply('Unlock handler not configured');
      }
    } catch (error) {
      await ctx.reply(`Error: ${error.message}`);
    }
  });

  // /force - Toggle force analyze mode
  bot.command('force', async (ctx) => {
    try {
      if (stateHandlers.toggleForceAnalyze) {
        const newState = stateHandlers.toggleForceAnalyze();
        await ctx.reply(
          newState
            ? 'Force Analyze Mode: *ON*\nSignals will be sent even on C-Days'
            : 'Force Analyze Mode: *OFF*\nNormal A-Day gating restored',
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply('Force analyze handler not configured');
      }
    } catch (error) {
      await ctx.reply(`Error: ${error.message}`);
    }
  });
}

/**
 * Format status message
 * @param {Object} status
 * @returns {string}
 */
function formatStatusMessage(status) {
  if (!status) return 'Status not available';

  const lines = [
    '*Market Status*',
    '',
    `Is Running: ${status.isRunning ? '✅' : '❌'}`,
    `Market Open: ${status.isMarketOpen ? '✅' : '❌'}`,
    `Trading Day: ${status.isTradingDay ? '✅' : '❌'}`,
    '',
    `*A-Day Status:* ${status.todayIsADay ? `✅ ${status.adayDirection}` : '❌ C-Day'}`,
    `Force Analyze: ${status.forceAnalyzeMode ? '✅ ON' : '❌ OFF'}`,
    '',
    '*Safety State:*',
    `CE Signal Sent: ${status.safetyState?.signalsSent?.BUY_CE ? '✅' : '❌'}`,
    `PE Signal Sent: ${status.safetyState?.signalsSent?.BUY_PE ? '✅' : '❌'}`,
    `Trading Locked: ${status.safetyState?.isLocked ? '✅ LOCKED' : '❌ Unlocked'}`,
  ];

  return lines.join('\n');
}

/**
 * Format levels message
 * @param {Object} levels
 * @returns {string}
 */
function formatLevelsMessage(levels) {
  if (!levels) return 'Levels not available';

  const lines = [
    '*Key Levels*',
    '',
    `PDH: ${levels.pdh?.toFixed(0) || 'N/A'}`,
    `PDL: ${levels.pdl?.toFixed(0) || 'N/A'}`,
    `Today Open: ${levels.todayOpen?.toFixed(0) || 'N/A'}`,
    '',
    '*Pivot Points:*',
    `R2: ${levels.r2?.toFixed(0) || 'N/A'}`,
    `R1: ${levels.r1?.toFixed(0) || 'N/A'}`,
    `Pivot: ${levels.pivot?.toFixed(0) || 'N/A'}`,
    `S1: ${levels.s1?.toFixed(0) || 'N/A'}`,
    `S2: ${levels.s2?.toFixed(0) || 'N/A'}`,
  ];

  if (levels.roundAbove || levels.roundBelow) {
    lines.push('');
    lines.push('*Round Numbers:*');
    if (levels.roundAbove) lines.push(`Above: ${levels.roundAbove}`);
    if (levels.roundBelow) lines.push(`Below: ${levels.roundBelow}`);
  }

  return lines.join('\n');
}

/**
 * Format OI message
 * @param {Object} oi
 * @returns {string}
 */
function formatOIMessage(oi) {
  if (!oi || oi.error) return 'OI data not available';

  const lines = [
    '*OI Snapshot*',
    '',
    `Spot: ${oi.spotPrice?.toFixed(0) || 'N/A'}`,
    `PCR: ${oi.pcrRatio?.toFixed(2) || 'N/A'}`,
    `Max Pain: ${oi.maxPain || 'N/A'}`,
    '',
  ];

  if (oi.oiLevels) {
    lines.push('*OI Levels:*');
    if (oi.oiLevels.resistance) lines.push(`Resistance (Max Call OI): ${oi.oiLevels.resistance}`);
    if (oi.oiLevels.support) lines.push(`Support (Max Put OI): ${oi.oiLevels.support}`);
  }

  if (oi.oiBuildUp) {
    lines.push('');
    lines.push('Fresh OI build-up detected at key strikes');
  }

  return lines.join('\n');
}

/**
 * Send a message to the configured chat
 * @param {string} message - Message to send
 * @param {Object} options - Send options
 * @returns {Promise<Object>} Telegram response
 */
async function sendMessage(message, options = {}) {
  if (!bot || !TELEGRAM_CHAT_ID) {
    logger.warn('Telegram bot not configured or chat ID missing');
    return null;
  }

  try {
    const result = await bot.telegram.sendMessage(
      TELEGRAM_CHAT_ID,
      message,
      { parse_mode: 'Markdown', ...options }
    );
    logger.info('Telegram message sent');
    return result;
  } catch (error) {
    logger.error('Telegram send failed', { error: error.message });
    throw error;
  }
}

/**
 * Send a trading alert
 * @param {Object} signal - Trading signal with WHY section
 * @returns {Promise<Object>}
 */
async function sendAlert(signal) {
  const message = formatAlertMessage(signal);
  return sendMessage(message);
}

/**
 * Format alert message for Telegram
 * @param {Object} signal
 * @returns {string}
 */
function formatAlertMessage(signal) {
  const {
    primaryStrategy,
    direction,
    confidenceScore,
    whySection,
    strike,
    premium,
    stopLoss,
    spotPrice,
    isCDaySignal,
  } = signal;

  const header = isCDaySignal
    ? '⚠️ *C-DAY SIGNAL* ⚠️\n_Force Analyze Mode - Trade with caution_'
    : '🚨 *A-DAY SIGNAL* 🚨';

  const lines = [
    header,
    '',
    `*Setup:* ${primaryStrategy || 'COMBINED'}`,
    `*Direction:* NIFTY ${direction}`,
    '',
    `*Strike:* ${strike || 'TBD'}`,
    `*Premium:* Rs ${premium || 'TBD'}`,
    `*Spot:* ${spotPrice?.toFixed(0) || 'N/A'}`,
    '',
    `*Stop Loss:* ${stopLoss?.toFixed(0) || 'N/A'}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ];

  // Add WHY section if available
  if (whySection) {
    lines.push(whySection);
  } else if (signal.reasons) {
    // Format reasons manually
    lines.push('*📊 WHY THIS SIGNAL:*');
    lines.push('');
    for (const reason of signal.reasons) {
      const emoji = reason.status === 'pass' ? '✅' : reason.status === 'fail' ? '❌' : '⚠️';
      lines.push(`${emoji} *${reason.factor}*`);
      lines.push(`    ${reason.detail}`);
    }
    lines.push('');
    lines.push(`*📈 Confidence: ${confidenceScore}/100*`);
  }

  return lines.join('\n');
}

/**
 * Send post-market report
 * @param {Object} report - Report data
 * @returns {Promise<Object>}
 */
async function sendPostMarketReport(report) {
  const message = formatPostMarketReport(report);
  return sendMessage(message);
}

/**
 * Format post-market report
 * @param {Object} report
 * @returns {string}
 */
function formatPostMarketReport(report) {
  const lines = [
    '📊 *POST-MARKET REPORT*',
    '',
    `Date: ${report.date}`,
    `Day Type: ${report.dayType}`,
    '',
    '*Day Summary:*',
    `Open: ${report.open?.toFixed(0) || 'N/A'}`,
    `High: ${report.high?.toFixed(0) || 'N/A'}`,
    `Low: ${report.low?.toFixed(0) || 'N/A'}`,
    `Close: ${report.close?.toFixed(0) || 'N/A'}`,
    `Change: ${report.change >= 0 ? '+' : ''}${report.change?.toFixed(0) || 'N/A'} (${report.changePercent?.toFixed(2) || 'N/A'}%)`,
    `Range: ${report.range?.toFixed(0) || 'N/A'} pts`,
    '',
  ];

  if (report.reversals && report.reversals.length > 0) {
    lines.push('*Reversals:*');
    for (const rev of report.reversals.slice(0, 5)) {
      lines.push(`• ${rev.type}: ${rev.magnitude} pts at ${rev.time}`);
    }
    lines.push('');
  }

  if (report.signalsSent && report.signalsSent.length > 0) {
    lines.push('*Signals Sent:*');
    for (const sig of report.signalsSent) {
      lines.push(`• ${sig.strategy}: ${sig.direction}`);
    }
    lines.push('');
  }

  if (report.tomorrowLevels) {
    lines.push("*Tomorrow's Key Levels:*");
    lines.push(`PDH: ${report.tomorrowLevels.pdh?.toFixed(0) || 'N/A'}`);
    lines.push(`PDL: ${report.tomorrowLevels.pdl?.toFixed(0) || 'N/A'}`);
    lines.push('');
  }

  if (report.outlook) {
    lines.push(`*Outlook:* ${report.outlook}`);
  }

  return lines.join('\n');
}

/**
 * Check if bot is initialized
 * @returns {boolean}
 */
function isReady() {
  return isInitialized && !!bot;
}

/**
 * Stop the bot
 */
function stop() {
  if (bot) {
    bot.stop();
    isInitialized = false;
  }
}

module.exports = {
  initialize,
  sendMessage,
  sendAlert,
  sendPostMarketReport,
  isReady,
  stop,
  formatStatusMessage,
  formatLevelsMessage,
  formatOIMessage,
  formatAlertMessage,
};
