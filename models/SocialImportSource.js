const mongoose = require('mongoose');

// A saved "keep checking this link for new comments" source. Created either
// for a one-off manual fetch (still saved so re-running it later only pulls
// NEW comments, via FeedbackSubmission.externalId dedup) or with `isActive`
// so the scheduler (see utils/socialImportRunner.js) re-checks it on a timer.
const socialImportSourceSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    form: { type: mongoose.Schema.Types.ObjectId, ref: 'FeedbackForm', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    platform: {
      type: String,
      enum: ['instagram', 'facebook', 'youtube', 'tiktok', 'linkedin'],
      required: true,
    },
    url: { type: String, required: true, trim: true },
    label: { type: String, trim: true },

    // Off by default — importing comments spends Apify usage (and an AI
    // analysis call per new comment) every time it runs, so automatic
    // re-checking is opt-in per source, not the default for every fetch.
    isActive: { type: Boolean, default: false },

    lastRunAt: { type: Date },
    lastRunStatus: { type: String, enum: ['success', 'error'] },
    lastRunError: { type: String },
    lastImportedCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

socialImportSourceSchema.index({ company: 1, createdAt: -1 });

module.exports = mongoose.model('SocialImportSource', socialImportSourceSchema);
