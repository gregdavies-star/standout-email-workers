require('dotenv').config();

const { findEligibleUsers, findBestJobForUser } = require('./queries');
const { generateMatchReasons } = require('./match-reason');
const { sendJobEmail } = require('./brevo');
const sentTracker = require('./sent-tracker');

function isDryRun() {
  return String(process.env.DRY_RUN).toLowerCase() !== 'false';
}

function formatSalary(min, max) {
  const m = Number(min) || 0;
  const x = Number(max) || 0;
  const k = (v) => `$${Math.round(v / 1000)}K`;
  if (m > 0 && x > 0) return `${k(m)}–${k(x)}`;
  if (m > 0) return k(m);
  if (x > 0) return k(x);
  return '';
}

function formatJobAge(firstSeenAt) {
  if (!firstSeenAt) return '';
  const days = Math.floor((Date.now() - new Date(firstSeenAt).getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Posted today';
  if (days === 1) return 'Posted yesterday';
  return `Posted ${days} days ago`;
}

function firstNameFor(resumeParsed, email) {
  const name = resumeParsed && typeof resumeParsed.name === 'string' ? resumeParsed.name.trim() : '';
  if (name) return name.split(/\s+/)[0];
  const prefix = (email || '').split('@')[0] || 'there';
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function buildPayload(user, job, reasons, firstName) {
  const appUrl = process.env.STANDOUT_APP_URL || 'https://standout.jobs';
  const params = {
    FIRST_NAME: firstName,
    JOB_TITLE: job.title,
    COMPANY_NAME: job.company,
    JOB_LOCATION: job.location,
    WORK_TYPE: job.work_type,
    JOB_AGE: formatJobAge(job.first_seen_at),
    MATCH_REASON_1: reasons[0],
    MATCH_REASON_2: reasons[1],
    MATCH_REASON_3: reasons[2],
    JOB_URL: `${appUrl}/jobs/${job.id}`,
    MATCHES_URL: `${appUrl}/matches`,
  };
  const salary = formatSalary(job.salary_min, job.salary_max);
  if (salary) params.SALARY_RANGE = salary;

  return {
    templateId: process.env.BREVO_TEMPLATE_ID,
    to: [{ email: user.email, name: firstName }],
    params,
  };
}

async function run() {
  const dryRun = isDryRun();
  console.log(`[abandonment-job-email] Starting run — DRY_RUN=${dryRun}`);

  let users;
  try {
    users = await findEligibleUsers();
  } catch (err) {
    console.error('[abandonment-job-email] Supabase query failed, aborting run:', err.message);
    throw err;
  }

  const pending = users.filter((u) => !sentTracker.hasBeenSent(u.id));
  console.log(`[abandonment-job-email] ${users.length} eligible user(s), ${pending.length} not yet emailed.`);

  let sentCount = 0;
  let skipped = 0;

  for (const user of pending) {
    let job;
    try {
      job = await findBestJobForUser(user.id);
    } catch (err) {
      console.error(`[abandonment-job-email] Failed to load match for ${user.id}, skipping:`, err.message);
      skipped++;
      continue;
    }

    if (!job) {
      skipped++;
      continue; // no suitable match — skip silently per spec
    }

    const firstName = firstNameFor(user.resume_parsed, user.email);
    const reasons = await generateMatchReasons(user.resume_parsed, job);
    const payload = buildPayload(user, job, reasons, firstName);

    if (dryRun) {
      console.log(
        `[DRY RUN] Would send to: ${user.email} — Job: ${job.title} at ${job.company} ` +
          `(rank ${job.rank}, ${job.pct}% match, ${formatJobAge(job.first_seen_at)})`
      );
      console.log('[DRY RUN] Brevo params:', JSON.stringify(payload.params, null, 2));
      sentCount++;
      continue;
    }

    try {
      const messageId = await sendJobEmail(payload);
      sentTracker.markSent(user.id, job.id);
      sentCount++;
      console.log(`[abandonment-job-email] Sent to ${user.email} (messageId=${messageId}, jobId=${job.id})`);
    } catch (err) {
      console.error(`[abandonment-job-email] Brevo send failed for ${user.email}, skipping:`, err.message);
      skipped++;
    }
  }

  if (dryRun) {
    console.log(`[DRY RUN COMPLETE] Would have sent ${sentCount} emails (${skipped} skipped).`);
  } else {
    console.log(`[abandonment-job-email] Run complete — sent ${sentCount}, skipped ${skipped}.`);
  }

  return { eligible: users.length, sent: sentCount, skipped, dryRun };
}

// Vercel serverless handler — mounted at /api/abandonment-job-email
async function handler(req, res) {
  try {
    const result = await run();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[abandonment-job-email] Handler error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
module.exports.run = run;
module.exports.handler = handler;
module.exports._internals = { formatSalary, formatJobAge, firstNameFor, buildPayload };

// Run directly via `node index.js`
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[abandonment-job-email] Fatal:', err.message);
      process.exit(1);
    });
}
