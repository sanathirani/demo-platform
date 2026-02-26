/**
 * Reason Builder
 *
 * Formats the WHY section for alerts with all contributing factors.
 * Uses status indicators: pass, fail, neutral
 */

const STATUS_EMOJI = {
  pass: '✅',
  fail: '❌',
  neutral: '⚠️',
};

/**
 * Format reasons into human-readable WHY section for text alerts
 * @param {Array} reasons - Array of { factor, status, detail }
 * @param {number} confidenceScore - Overall confidence score
 * @returns {string} Formatted WHY section
 */
function formatWHYSection(reasons, confidenceScore) {
  if (!reasons || reasons.length === 0) {
    return '📊 No detailed analysis available';
  }

  const lines = ['📊 WHY THIS SIGNAL:', ''];

  // Group by status for better readability
  const passing = reasons.filter(r => r.status === 'pass');
  const neutral = reasons.filter(r => r.status === 'neutral');
  const failing = reasons.filter(r => r.status === 'fail');

  // Show passing factors first
  for (const reason of passing) {
    lines.push(`${STATUS_EMOJI.pass} ${reason.factor}`);
    lines.push(`   ${reason.detail}`);
  }

  // Then neutral
  for (const reason of neutral) {
    lines.push(`${STATUS_EMOJI.neutral} ${reason.factor}`);
    lines.push(`   ${reason.detail}`);
  }

  // Then failing (if any)
  for (const reason of failing) {
    lines.push(`${STATUS_EMOJI.fail} ${reason.factor}`);
    lines.push(`   ${reason.detail}`);
  }

  lines.push('');
  lines.push(`📈 Confidence Score: ${confidenceScore}/100`);

  return lines.join('\n');
}

/**
 * Format reasons into HTML WHY section for email alerts
 * @param {Array} reasons - Array of { factor, status, detail }
 * @param {number} confidenceScore - Overall confidence score
 * @returns {string} HTML formatted WHY section
 */
function formatWHYSectionHTML(reasons, confidenceScore) {
  if (!reasons || reasons.length === 0) {
    return '<div class="why-section"><p>No detailed analysis available</p></div>';
  }

  const statusClass = {
    pass: 'why-pass',
    fail: 'why-fail',
    neutral: 'why-neutral',
  };

  const statusColor = {
    pass: '#28a745',
    fail: '#dc3545',
    neutral: '#ffc107',
  };

  let html = `
<div class="why-section" style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 15px 0;">
  <h3 style="margin: 0 0 15px 0; color: #333;">📊 WHY THIS SIGNAL</h3>
  <div class="reasons-list">`;

  // Group by status
  const passing = reasons.filter(r => r.status === 'pass');
  const neutral = reasons.filter(r => r.status === 'neutral');
  const failing = reasons.filter(r => r.status === 'fail');

  const allGrouped = [...passing, ...neutral, ...failing];

  for (const reason of allGrouped) {
    const color = statusColor[reason.status];
    const emoji = STATUS_EMOJI[reason.status];
    html += `
    <div class="reason-item" style="padding: 10px; margin: 5px 0; border-left: 3px solid ${color}; background: white;">
      <div style="font-weight: bold; color: #333;">${emoji} ${reason.factor}</div>
      <div style="color: #666; font-size: 14px;">${reason.detail}</div>
    </div>`;
  }

  // Confidence score bar
  const scoreColor = confidenceScore >= 60 ? '#28a745' : '#ffc107';
  html += `
  </div>
  <div class="confidence-score" style="margin-top: 20px; padding: 15px; background: white; border-radius: 8px;">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
      <span style="font-weight: bold;">Confidence Score</span>
      <span style="font-size: 24px; font-weight: bold; color: ${scoreColor};">${confidenceScore}/100</span>
    </div>
    <div style="background: #e9ecef; border-radius: 4px; height: 8px; overflow: hidden;">
      <div style="background: ${scoreColor}; width: ${confidenceScore}%; height: 100%;"></div>
    </div>
  </div>
</div>`;

  return html;
}

/**
 * Format reasons for Telegram (Markdown)
 * @param {Array} reasons - Array of { factor, status, detail }
 * @param {number} confidenceScore - Overall confidence score
 * @returns {string} Telegram markdown formatted WHY section
 */
function formatWHYSectionTelegram(reasons, confidenceScore) {
  if (!reasons || reasons.length === 0) {
    return '*No detailed analysis available*';
  }

  const lines = ['*📊 WHY THIS SIGNAL:*', ''];

  // Group by status
  const passing = reasons.filter(r => r.status === 'pass');
  const neutral = reasons.filter(r => r.status === 'neutral');
  const failing = reasons.filter(r => r.status === 'fail');

  // Show passing factors first
  for (const reason of passing) {
    lines.push(`${STATUS_EMOJI.pass} *${escapeMarkdown(reason.factor)}*`);
    lines.push(`    ${escapeMarkdown(reason.detail)}`);
  }

  // Then neutral
  for (const reason of neutral) {
    lines.push(`${STATUS_EMOJI.neutral} *${escapeMarkdown(reason.factor)}*`);
    lines.push(`    ${escapeMarkdown(reason.detail)}`);
  }

  // Then failing
  for (const reason of failing) {
    lines.push(`${STATUS_EMOJI.fail} *${escapeMarkdown(reason.factor)}*`);
    lines.push(`    ${escapeMarkdown(reason.detail)}`);
  }

  lines.push('');

  // Confidence score with visual bar
  const filledBlocks = Math.round(confidenceScore / 10);
  const emptyBlocks = 10 - filledBlocks;
  const scoreBar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

  lines.push(`*📈 Confidence: ${confidenceScore}/100*`);
  lines.push(`\`${scoreBar}\``);

  return lines.join('\n');
}

/**
 * Escape special characters for Telegram Markdown
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

/**
 * Create a summary line for the WHY section
 * @param {Array} reasons
 * @returns {string}
 */
function createSummaryLine(reasons) {
  const passing = reasons.filter(r => r.status === 'pass').length;
  const total = reasons.length;
  return `${passing}/${total} factors aligned`;
}

/**
 * Build a compact reason string for logging
 * @param {Array} reasons
 * @returns {string}
 */
function buildCompactReason(reasons) {
  const passing = reasons
    .filter(r => r.status === 'pass')
    .map(r => r.factor)
    .join(', ');
  return passing || 'No clear factors';
}

module.exports = {
  formatWHYSection,
  formatWHYSectionHTML,
  formatWHYSectionTelegram,
  createSummaryLine,
  buildCompactReason,
  STATUS_EMOJI,
};
