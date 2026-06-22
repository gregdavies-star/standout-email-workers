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

  const cutoff = Date.now() - ONE_HOUR_MS;
  const eligible = [];
  for (const p of freeProfiles) {
    const minBatch = minBatchByUser.get(p.id);
    if (minBatch === undefined) continue;
    if (minBatch > cutoff) continue; // registered less than 1 hour ago
    eligible.push({
      id: p.id,
      email: p.email,
      resume_parsed: p.resume_parsed,
      batch_at: new Date(minBatch).toISOString(),
    });
  }
  return eligible;
}

// Step 2 — best untouched job match for a user: rank > 2, job seen within 7 days, highest pct.
async function findBestJobForUser(userId) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('user_match_queue')
    .select(
      'pct, rank, role_label, intent_label, sent_at, ' +
        'jobs ( id, title, company, location, salary_min, salary_max, work_type, source_url, description, role_category, first_seen_at, last_seen_at, ats_provider )'
    )
    .eq('user_id', userId)
    .gt('rank', 2)
    .is('sent_at', null);
  if (error) throw new Error(`best-job query failed for user ${userId}: ${error.message}`);

  const freshCutoff = Date.now() - SEVEN_DAYS_MS;
  const candidates = (data || [])
    .filter((row) => row.jobs && row.jobs.last_seen_at && new Date(row.jobs.last_seen_at).getTime() >= freshCutoff)
    .sort((a, b) => {
      if (b.pct !== a.pct) return (b.pct || 0) - (a.pct || 0);
      return (a.rank || 0) - (b.rank || 0);
    });

  if (candidates.length === 0) return null;

  const top = candidates[0];
  return {
    ...top.jobs,
    pct: top.pct,
    rank: top.rank,
    role_label: top.role_label,
    intent_label: top.intent_label,
  };
}

module.exports = { getSupabase, findEligibleUsers, findBestJobForUser };
