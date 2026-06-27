const { createClient } = require('@supabase/supabase-js');

const ONE_HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PAID_STATUSES = ['active', 'trialing'];

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  }
  _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
}

function isPaid(subscriptionStatus) {
  return subscriptionStatus != null && PAID_STATUSES.includes(subscriptionStatus);
}

/**
 * Find free users who:
 * 1. Have a parsed resume (resume_parsed IS NOT NULL)
 * 2. Created their account between 1–2 hours ago
 * 3. Have no active subscription
 *
 * Uses created_at as the trigger — reliable, always written, no dependency
 * on user_match_queue which is updated on a separate weekly schedule.
 */
async function findEligibleUsers() {
  const supabase = getSupabase();

  const windowStart = new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString(); // 2 hours ago
  const windowEnd   = new Date(Date.now() - ONE_HOUR_MS).toISOString();     // 1 hour ago

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, resume_parsed, subscription_status, created_at')
    .not('resume_parsed', 'is', null)
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd);

  if (error) throw new Error(`profiles query failed: ${error.message}`);

  return (profiles || [])
    .filter((p) => !isPaid(p.subscription_status) && p.email)
    .map((p) => ({
      id: p.id,
      email: p.email,
      resume_parsed: p.resume_parsed,
      created_at: p.created_at,
    }));
}

/**
 * Extract a best-guess role/title from the parsed resume to use as a search signal.
 * Falls back to generic professional roles if nothing useful is found.
 */
function extractRoleKeywords(resumeParsed) {
  if (!resumeParsed) return null;

  // Try common resume JSON shapes
  const title =
    resumeParsed.current_title ||
    resumeParsed.title ||
    resumeParsed.headline ||
    (resumeParsed.experience && resumeParsed.experience[0] && resumeParsed.experience[0].title) ||
    (resumeParsed.work_experience && resumeParsed.work_experience[0] && resumeParsed.work_experience[0].title) ||
    null;

  return title;
}

/**
 * Batch fetch best job for all eligible users.
 * Since user_match_queue is populated weekly (not at signup), we query jobs directly.
 * Strategy: find fresh jobs matching the user's most recent job title via text search.
 * Returns a Map of userId -> best job object.
 */
async function findBestJobsForUsers(users) {
  const supabase = getSupabase();
  const freshCutoff = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const bestByUser = new Map();

  // Process users in parallel — one job search per user based on their resume
  await Promise.all(
    users.map(async (user) => {
      const roleTitle = extractRoleKeywords(user.resume_parsed);

      let query = supabase
        .from('jobs')
        .select('id, title, company, location, salary_min, salary_max, work_type, source_url, description, role_category, first_seen_at, last_seen_at, ats_provider')
        .gte('last_seen_at', freshCutoff)
        .not('description', 'is', null)
        .order('last_seen_at', { ascending: false })
        .limit(5);

      // Filter by role title if we have one
      if (roleTitle) {
        query = query.ilike('title', `%${roleTitle.split(' ').slice(-2).join('%')}%`);
      }

      const { data: jobs, error } = await query;

      if (error) {
        console.error(`[queries] job search failed for ${user.email}: ${error.message}`);
        return;
      }

      if (jobs && jobs.length > 0) {
        // Pick the most recently seen job
        bestByUser.set(user.id, { ...jobs[0], pct: null, rank: null });
      }
    })
  );

  return bestByUser;
}

// Single-user wrapper kept for backwards compat
async function findBestJobForUser(userId) {
  const map = await findBestJobsForUsers([{ id: userId }]);
  return map.get(userId) || null;
}

module.exports = { getSupabase, findEligibleUsers, findBestJobForUser, findBestJobsForUsers };
