const { run } = require('../abandonment-job-email-2/index');

module.exports = async (req, res) => {
  // Allow manual POST triggers as well as cron GET
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await run();
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[api/abandonment-job-email-2] Unhandled error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
