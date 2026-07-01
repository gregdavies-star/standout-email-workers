require('dotenv').config();

const { createHmac } = require('node:crypto');
const { findEligibleUsers, findJobsAndMatchCounts } = require('./queries');
const sentTracker = require('../abandonment-job-email/sent-tracker');

// ---------------------------------------------------------------------------
// Magic link signing (same as Email 1 — shared secret)
// ---------------------------------------------------------------------------

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signEmailToken(payload, secret) {
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}
function buildMagicLink(appUrl, userId, redirect) {
  const secret = process.env.EMAIL_LINK_SECRET;
  if (!secret) return `${appUrl}${redirect}`;
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const token = signEmailToken({ uid: userId, redirect, exp }, secret);
  const params = new URLSearchParams({ uid: userId, t: token });
  return `${appUrl}/api/auth/email-link?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDryRun() {
  return String(process.env.DRY_RUN).toLowerCase() !== 'false';
}

function getFirstName(resumeParsed) {
  const name = resumeParsed?.name || '';
  return name.split(' ')[0] || 'there';
}

function timeSinceSignup(createdAt) {
  const hours = Math.round((Date.now() - new Date(createdAt).getTime()) / (60 * 60 * 1000));
  if (hours < 24) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const appUrl     = process.env.STANDOUT_APP_URL || 'https://usestandout.today';
  const brevoKey   = process.env.BREVO_API_KEY || process.env.BREVO_KEY;
  const templateId = parseInt(process.env.BREVO_TEMPLATE_ID_2 || '40');
  const dryRun     = isDryRun();

  console.log(`[email2] Starting — DRY_RUN=${dryRun}`);

  // 1. Find eligible users (signed up 25–26h ago, has resume, not subscribed)
  const users = await findEligibleUsers();
  console.log(`[email2] Eligible users: ${users.length}`);
  if (!users.length) return { sent: 0, skipped: 0 };

  // 2. Get the job from Email 1 + match count for each user
  const jobData = await findJobsAndMatchCounts(users, sentTracker);

  let sent = 0, skipped = 0;

  for (const user of users) {
    const data = jobData.get(user.id);
    if (!data) { skipped++; continue; }

    const { job, matchCount } = data;
    const firstName   = getFirstName(user.resume_parsed);
    const timeSince   = timeSinceSignup(user.created_at);

    // Build magic links
    const jobRedirect     = `/dashboard?job=${job.id}&utm_source=brevo&utm_medium=email&utm_campaign=abandonment_2`;
    const matchesRedirect = `/matches?utm_source=brevo&utm_medium=email&utm_campaign=abandonment_2`;
    const jobUrl          = buildMagicLink(appUrl, user.id, jobRedirect);
    const matchesUrl      = buildMagicLink(appUrl, user.id, matchesRedirect);

    const params = {
      FIRST_NAME:       firstName,
      JOB_TITLE:        job.title,
      COMPANY_NAME:     job.company,
      JOB_LOCATION:     job.location,
      WORK_TYPE:        job.work_type || '',
      MATCH_PCT:        '',  // not shown in Email 2 job card header but kept for consistency
      MATCH_COUNT:      matchCount || 'several',
      TIME_SINCE_SIGNUP: timeSince,
      JOB_URL:          jobUrl,
      MATCHES_URL:      matchesUrl,
    };

    if (dryRun) {
      console.log(`[email2] DRY RUN — would send to ${user.email}:`, params);
      sent++;
      continue;
    }

    // Send via Brevo
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId,
        to: [{ email: user.email, name: firstName }],
        params,
      }),
    });

    const body = await res.json();
    if (res.ok && body.messageId) {
      console.log(`[email2] Sent to ${user.email} — messageId: ${body.messageId}`);
      sent++;
    } else {
      console.error(`[email2] Failed for ${user.email}:`, body);
      skipped++;
    }
  }

  console.log(`[email2] Done — sent: ${sent}, skipped: ${skipped}`);
  return { sent, skipped };
}

module.exports = { run };
