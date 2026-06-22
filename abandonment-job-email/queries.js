const { createClient } = require('@supabase/supabase-js');

const ONE_HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PAID_STATUSES = ['active', 'trialing'];

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars. Copy .env.example to .env and fill them in.');
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

function isPaid(subscriptionStatus) {
  return subscriptionStatus != null && PAID_STATUSES.includes(subscriptionStatus);
}

// Step 1 — find free users who registered (earliest batch_at) 1+ hour ago and have a parsed resume.
async function findEligibleUsers() {
  const supabase = getSupabase();

  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('id, email, resume_parsed, subscription_status')
    .not('resume_parsed', 'is', null);
  if (profErr) throw new Error(`profiles query failed: ${profErr.message}`);

  const freeProfiles = (profiles || []).filter((p) => !isPaid(p.subscription_status) && p.email);
  if (freeProfiles.length === 0) return [];

  const ids = freeProfiles.map((p) => p.id);

  // Earliest batch_at per user serves as the "registered" timestamp.
  const { data: queueRows, error: queueErr } = await supabase
    .from('user_match_queue')
    .select('user_id, batch_at')
    .in('user_id', ids);
  if (queueErr) throw new Error(`user_match_queue batch_at query failed: ${queueErr.message}`);

  const minBatchByUser = new Map();
  for (const row of queueRows || []) {
    if (!row.batch_at) continue;
    const ts = new Date(row.batch_at).getTime();
    const current = minBatchByUser.get(row.user_id);
    if (current === undefined || ts < current) minBatchByUser.set(row.user_id, ts);
  }

  // Only pick up users whose batch_at crossed the 1-hour mark during THIS cron window.
  // Window: between 2 hours ago and 1 hour ago — catches anyone who just passed the 1-hour mark.
  // Users older than 2 hours are ignored (they'll have been caught by a previous run or missed the window).
  const windowStart = Date.now() - (2 * ONE_HOUR_MS); // 2 hours ago
  const windowEnd   = Date.now() - ONE_HOUR_MS;        // 1 hour ago

  const eligible = [];
  for (const p of freeProfiles) {
    const minBatch = minBatchByUser.get(p.id);
    if (minBatch === undefined) continue;
    if (minBatch > windowEnd) continue;   // too recent — not yet 1 hour
    if (minBatch < windowStart) continue; // too old — previous cron should have caught this
    eligible.push({
      id: p.id,
      email: p.email,
      resume_parsed: p.resume_parsed,
      batch_at: new Date(minBatch).toISOString(),
    });
  }
  return eligible;
}

// Step 2 — batch fetch best job match for ALL eligible users in 2 queries total.
// Returns a Map of userId -> best job object (or null if no match).
async function findBestJobsForUsers(userIds) {
  const supabase = getSupabase();
  const freshCutoff = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  // Query 1: all queue rows for eligible users (rank > 2, not sent)
  const { data: queueRows, error: qErr } = await supabase
    .from('user_match_queue')
    .select('user_id, job_id, pct, rank, role_label, intent_label')
    .in('user_id', userIds)
    .gt('rank', 2)
    .is('sent_at', null)
    .order('pct', { ascending: false })
    .order('rank', { ascending: true });
  if (qErr) throw new Error(`batch queue query failed: ${qErr.message}`);
  if (!queueRows || queueRows.length === 0) return new Map();

  const allJobIds = [...new Set(queueRows.map((r) => r.job_id))];

  // Query 2: fetch all those jobs that are still fresh, in batches of 500
  const freshJobMap = new Map();
  const BATCH = 500;
  for (let i = 0; i < allJobIds.length; i += BATCH) {
    const batch = allJobIds.slice(i, i + BATCH);
    const { data: jobs, error: jErr } = await supabase
      .from('jobs')
      .select('id, title, company, location, salary_min, salary_max, work_type, source_url, description, role_category, first_seen_at, last_seen_at, ats_provider')
      .in('id', batch)
      .gte('last_seen_at', freshCutoff);
    if (jErr) throw new Error(`batch jobs query failed: ${jErr.message}`);
    for (const j of jobs || []) freshJobMap.set(j.id, j);
  }

  // For each user, pick the highest-pct queue row whose job is fresh
  // queueRows is already sorted by pct desc, rank asc
  const bestByUser = new Map();
  for (const qRow of queueRows) {
    if (bestByUser.has(qRow.user_id)) continue; // already found best for this user
    const job = freshJobMap.get(qRow.job_id);
    if (job) {
      bestByUser.set(qRow.user_id, {
        ...job,
        pct: qRow.pct,
        rank: qRow.rank,
        role_label: qRow.role_label,
        intent_label: qRow.intent_label,
      });
    }
  }
  return bestByUser;
}

// Single-user wrapper kept for backwards compat
async function findBestJobForUser(userId) {
  const map = await findBestJobsForUsers([userId]);
  return map.get(userId) || null;
}

module.exports = { getSupabase, findEligibleUsers, findBestJobForUser, findBestJobsForUsers };
