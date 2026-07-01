const { createClient } = require('@supabase/supabase-js');

const ONE_HOUR_MS  = 60 * 60 * 1000;
const PAID_STATUSES = ['active', 'trialing'];

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Missing Supabase env vars.');
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  return _client;
}

/**
 * Find free users who:
 * 1. Have a parsed resume
 * 2. Created their account between 25–26 hours ago (24hr window, checked hourly)
 * 3. Have no active subscription
 * 4. Received Email 1 (key exists in KV) — meaning they were eligible then too
 */
async function findEligibleUsers() {
  const supabase = getSupabase();

  const windowStart = new Date(Date.now() - 26 * ONE_HOUR_MS).toISOString();
  const windowEnd   = new Date(Date.now() - 25 * ONE_HOUR_MS).toISOString();

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, resume_parsed, subscription_status, created_at')
    .not('resume_parsed', 'is', null)
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd);

  if (error) throw new Error(`profiles query failed: ${error.message}`);

  return (profiles || [])
    .filter(p => !PAID_STATUSES.includes(p.subscription_status) && p.email)
    .map(p => ({ id: p.id, email: p.email, resume_parsed: p.resume_parsed, created_at: p.created_at }));
}

/**
 * For each user, get:
 * 1. The same job that was sent in Email 1 (from KV key sent:{userId})
 * 2. Total match count from match_jobs_for_survey RPC
 * Returns a Map of userId -> { job, matchCount }
 */
async function findJobsAndMatchCounts(users, sentTracker) {
  const supabase = getSupabase();
  const result = new Map();

  // Fetch survey IDs in one query
  const { data: surveys } = await supabase
    .from('surveys')
    .select('id, user_id')
    .in('user_id', users.map(u => u.id));

  const surveyByUser = new Map((surveys || []).map(s => [s.user_id, s.id]));

  await Promise.all(users.map(async user => {
    // Get job ID from Email 1 KV entry
    const email1JobId = await sentTracker.getSentJobId(user.id);
    if (!email1JobId) {
      console.log(`[email2/queries] No Email 1 record for ${user.email} — skipping.`);
      return;
    }

    // Fetch the job row
    const { data: job, error: jobErr } = await supabase
      .from('jobs')
      .select('id, title, company, location, salary_min, salary_max, work_type, source_url, role_category, first_seen_at, last_seen_at')
      .eq('id', email1JobId)
      .single();

    if (jobErr || !job) {
      console.log(`[email2/queries] Job ${email1JobId} not found for ${user.email} — skipping.`);
      return;
    }

    // Get match count from RPC (use limit=20 to get a real count)
    let matchCount = 0;
    const surveyId = surveyByUser.get(user.id);
    if (surveyId) {
      const { data: matches } = await supabase.rpc('match_jobs_for_survey', {
        p_survey_id: surveyId,
        p_limit: 20,
        p_fresh_days: 30, // broader window for count purposes
      });
      matchCount = (matches || []).length;
    }

    result.set(user.id, { job, matchCount });
    console.log(`[email2/queries] ${user.email} → "${job.title}" at ${job.company} | ${matchCount} matches`);
  }));

  return result;
}

module.exports = { getSupabase, findEligibleUsers, findJobsAndMatchCounts };
