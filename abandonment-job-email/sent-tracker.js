const fs = require('fs');
const path = require('path');

const SENT_FILE = path.join(__dirname, 'sent.json');

function loadAll() {
  try {
    const raw = fs.readFileSync(SENT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error(`[sent-tracker] Could not parse ${SENT_FILE}, treating as empty:`, err.message);
    return [];
  }
}

function hasBeenSent(userId) {
  return loadAll().some((entry) => entry.userId === userId);
}

function markSent(userId, jobId) {
  const all = loadAll();
  all.push({ userId, sentAt: new Date().toISOString(), jobId });
  fs.writeFileSync(SENT_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8');
}

module.exports = { loadAll, hasBeenSent, markSent };
