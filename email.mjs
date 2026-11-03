import { emailFrom, resendApiKey, siteUrl } from './config.mjs';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendEmail({ to, subject, html }) {
  if (!resendApiKey || !to) return { sent: false, reason: 'email-not-configured' };

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: emailFrom, to: [to], subject, html }),
    });
    return { sent: response.ok, status: response.status };
  } catch {
    // Email is best-effort: a failure must never fail a registration.
    return { sent: false, reason: 'network' };
  }
}

function wrap(title, bodyLines, accent = '#34d399') {
  return `<!doctype html><html><body style="margin:0;background:#05090e;font-family:Segoe UI,Arial,sans-serif;color:#e2e8f0;padding:24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="100%" style="max-width:560px;background:#08121d;border:1px solid #1e293b;border-radius:14px;padding:24px">
  <tr><td>
  <p style="margin:0 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${accent}">CU Esports Club</p>
  <h1 style="margin:0 0 16px;font-size:20px;color:#ffffff">${escapeHtml(title)}</h1>
  ${bodyLines.map((line) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#cbd5e1">${line}</p>`).join('')}
  <p style="margin:20px 0 0;font-size:12px;color:#64748b"><a href="${siteUrl}" style="color:${accent}">${siteUrl}</a></p>
  </td></tr></table></td></tr></table></body></html>`;
}

export function sendRegistrationReceivedEmail(tournament, registration) {
  if (!registration?.captainEmail) return Promise.resolve({ sent: false });
  return sendEmail({
    to: registration.captainEmail,
    subject: `Registration received — ${tournament.name}`,
    html: wrap(
      'Registration received',
      [
        `Team <strong>${escapeHtml(registration.name)} [${escapeHtml(registration.tag)}]</strong> is registered for <strong>${escapeHtml(tournament.name)}</strong>.`,
        `Pass code: <strong>${escapeHtml(registration.passCode)}</strong> — keep it safe, you need it at check-in.`,
        'An admin will review your roster and approve it before the bracket is published.',
      ],
      '#22d3ee'
    ),
  });
}

export function sendRegistrationApprovedEmail(tournament, registration) {
  if (!registration?.captainEmail) return Promise.resolve({ sent: false });
  return sendEmail({
    to: registration.captainEmail,
    subject: `Approved — ${tournament.name}`,
    html: wrap('Roster approved', [
      `Team <strong>${escapeHtml(registration.name)}</strong> is confirmed for <strong>${escapeHtml(tournament.name)}</strong>.`,
      `${escapeHtml(tournament.checkInLabel || 'Check-in opens 30 minutes before the match.')}`,
    ]),
  });
}

export function sendRegistrationRejectedEmail(tournament, registration) {
  if (!registration?.captainEmail) return Promise.resolve({ sent: false });
  return sendEmail({
    to: registration.captainEmail,
    subject: `Registration needs changes — ${tournament.name}`,
    html: wrap(
      'Registration needs changes',
      [
        `Team <strong>${escapeHtml(registration.name)}</strong> could not be approved for <strong>${escapeHtml(tournament.name)}</strong>.`,
        `Reason: ${escapeHtml(registration.rejectionReason || 'Not specified.')}`,
        'You can register again once the issue is fixed.',
      ],
      '#fb7185'
    ),
  });
}
