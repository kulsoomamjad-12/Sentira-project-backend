// Shared core for both the manual "Fetch & analyze" button and the
// scheduled auto-recheck (see jobs/socialImportScheduler.js) — one code
// path so the two triggers can never drift apart.

const FeedbackForm = require('../models/FeedbackForm');
const FeedbackSubmission = require('../models/FeedbackSubmission');
const { fetchComments } = require('./apifyService');
const { analyzeFeedback } = require('./aiAnalysis');
const { notifyNewSubmission } = require('./notify');

// Fetches a post's comments, skips ones already imported for this form (by
// externalId), runs the new ones through the same AI sentiment analysis as
// every other feedback source, and saves + broadcasts each one.
async function importComments({ io, form, platform, url, limit = 30, customerNamePrefix = '' }) {
  const comments = await fetchComments(platform, url, limit);
  if (!comments.length) {
    return { fetched: 0, imported: 0, skipped: 0 };
  }

  const externalIds = comments.map((c) => c.externalId);
  const existing = await FeedbackSubmission.find({ form: form._id, externalId: { $in: externalIds } }).select(
    'externalId'
  );
  const alreadyImported = new Set(existing.map((e) => e.externalId));

  let imported = 0;
  // Sequential, not Promise.all: each comment triggers an AI analysis call,
  // and running dozens of those concurrently risks tripping the AI
  // provider's rate limits for what's meant to be a background/bulk import.
  for (const comment of comments) {
    if (alreadyImported.has(comment.externalId)) continue;

    try {
      const aiAnalysis = await analyzeFeedback(comment.text, undefined);
      const submission = await FeedbackSubmission.create({
        form: form._id,
        customerName: customerNamePrefix ? `${customerNamePrefix}${comment.author}` : comment.author,
        comment: comment.text,
        ratingType: form.ratingType,
        source: 'social',
        sourcePlatform: platform,
        sourceUrl: url,
        externalId: comment.externalId,
        aiAnalysis,
      });
      notifyNewSubmission(io, form, submission, aiAnalysis);
      imported += 1;
    } catch (error) {
      // A duplicate-key race (two runs overlapping) or one bad comment
      // shouldn't abort the whole batch — log it and keep going.
      console.error(`Skipped one comment during social import (${platform} ${url}):`, error.message);
    }
  }

  return { fetched: comments.length, imported, skipped: comments.length - imported };
}

// Runs one saved SocialImportSource — used by both the "run now" button on
// a saved source and the scheduler (each passes its own `io` instance).
// Persists the run's outcome onto the source itself so the UI can show
// "last run: 2 new comments, 5 min ago".
async function runSource(source, io) {
  const form = await FeedbackForm.findById(source.form);
  if (!form) {
    source.lastRunAt = new Date();
    source.lastRunStatus = 'error';
    source.lastRunError = 'The form this source was attached to no longer exists';
    await source.save();
    return { fetched: 0, imported: 0, skipped: 0 };
  }

  try {
    const result = await importComments({
      io,
      form,
      platform: source.platform,
      url: source.url,
      customerNamePrefix: '',
    });
    source.lastRunAt = new Date();
    source.lastRunStatus = 'success';
    source.lastRunError = undefined;
    source.lastImportedCount = result.imported;
    await source.save();
    return result;
  } catch (error) {
    source.lastRunAt = new Date();
    source.lastRunStatus = 'error';
    source.lastRunError = error.message;
    await source.save();
    throw error;
  }
}

module.exports = { importComments, runSource };
