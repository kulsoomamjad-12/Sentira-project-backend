// Re-runs the AI analysis on stored reviews that weren't analyzed by the AI
// (the keyword fallback ran because the AI call failed, or they predate the
// `aiAnalysis.method` field) so their sentiment/urgency use the current rules.
//
//   node scripts/reanalyzeFeedback.js          -> dry run, lists what would change
//   node scripts/reanalyzeFeedback.js --apply  -> re-analyzes and saves
//   add --all to re-analyze every review, not just the non-AI ones
require('dotenv').config();
const mongoose = require('mongoose');
const FeedbackSubmission = require('../models/FeedbackSubmission');
const { analyzeFeedback } = require('../utils/aiAnalysis');

const DELAY_MS = 13000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const apply = process.argv.includes('--apply');
const all = process.argv.includes('--all');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const filter = all ? {} : { 'aiAnalysis.method': { $ne: 'ai' } };
  const submissions = await FeedbackSubmission.find(filter).sort({ createdAt: -1 });
  console.log(`${submissions.length} review(s) to re-analyze${apply ? '' : ' (dry run — nothing will be saved)'}\n`);

  let changed = 0;
  let stillFallback = 0;
  for (const [index, submission] of submissions.entries()) {
    // Free-tier AI keys only allow a handful of requests per minute — pace
    // the batch so most reviews get a real AI analysis instead of the fallback.
    if (index > 0) await sleep(DELAY_MS);

    const before = submission.aiAnalysis || {};
    const after = await analyzeFeedback(submission.comment, submission.rating, {
      ratingType: submission.ratingType,
      responses: submission.responses,
    });
    if (after.method !== 'ai') stillFallback++;

    const differs = before.sentiment !== after.sentiment || before.urgency !== after.urgency;
    if (differs) changed++;
    console.log(
      `${differs ? '*' : ' '} "${submission.comment.slice(0, 60)}"  ` +
        `${before.sentiment}/${before.urgency} -> ${after.sentiment}/${after.urgency} (${after.method})`
    );

    // Only overwrite with a real AI result — if the AI was unavailable, leave
    // the review as it is so it gets picked up again on the next run.
    if (apply && after.method === 'ai') {
      submission.aiAnalysis = after;
      await submission.save();
    }
  }

  console.log(
    `\n${changed} changed sentiment/urgency, ${stillFallback} couldn't reach the AI` +
      (apply ? ' (left unchanged — run the script again later to retry them).' : '.')
  );
  if (!apply) console.log('Run again with --apply to save these results.');
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
