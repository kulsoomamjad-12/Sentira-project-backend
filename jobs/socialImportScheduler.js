const cron = require('node-cron');
const SocialImportSource = require('../models/SocialImportSource');
const { runSource } = require('../utils/socialImportRunner');

// Re-checks every saved source that has been switched to automatic
// (SocialImportSource.isActive) on a timer, so nobody has to click "Run
// now" themselves. Off by default per-source (see the model) — this only
// ever touches sources someone explicitly opted in, since every run spends
// Apify usage plus one AI analysis call per new comment found.
function startSocialImportScheduler(io, cronExpression = process.env.SOCIAL_IMPORT_CRON || '0 * * * *') {
  cron.schedule(cronExpression, async () => {
    const sources = await SocialImportSource.find({ isActive: true });
    for (const source of sources) {
      try {
        await runSource(source, io);
      } catch (error) {
        console.error(`Scheduled social import failed for source ${source._id}:`, error.message);
      }
    }
  });
  console.log(`📡 Social import scheduler started (cron: "${cronExpression}")`);
}

module.exports = { startSocialImportScheduler };
