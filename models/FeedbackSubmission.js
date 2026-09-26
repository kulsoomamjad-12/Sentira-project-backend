const mongoose = require('mongoose');

const feedbackSubmissionSchema = new mongoose.Schema(
  {
    form: { type: mongoose.Schema.Types.ObjectId, ref: 'FeedbackForm', required: true },
    customerName: { type: String, trim: true },
    customerEmail: { type: String, trim: true, lowercase: true },
    rating: { type: Number, min: 0, max: 10 },
    // Denormalized from the form at write time, since a form's scale can
    // change over time but each submission's CSAT/NPS math must stay fixed
    // to whichever scale was actually shown to that respondent.
    ratingType: { type: String, enum: ['stars', 'nps'] },
    comment: { type: String, required: true, trim: true },

    // Answers to the form's admin-defined custom questions (see
    // FeedbackForm.fields). Snapshotted with each field's label/type at
    // submit time so a submission still reads correctly even if the form is
    // edited or a question removed later.
    responses: [
      {
        fieldId: { type: String, required: true },
        label: { type: String, trim: true },
        type: { type: String },
        value: mongoose.Schema.Types.Mixed,
        _id: false,
      },
    ],

    // Customer-submitted via the public form link (default) vs. staff manually
    // logging a review they read elsewhere, vs. auto-imported from a social
    // media post's comments via Apify (see utils/apifyService.js).
    source: { type: String, enum: ['form', 'external', 'social'], default: 'form' },
    sourceUrl: { type: String, trim: true },
    sourcePlatform: { type: String, enum: ['instagram', 'facebook', 'youtube', 'tiktok', 'linkedin'] },

    // The scraped comment's own ID on its platform — only set for
    // source:'social'. Lets re-running an import (manually or on the
    // scheduler) skip comments already imported instead of duplicating them
    // and re-spending an AI analysis call on each.
    externalId: { type: String },

    // --- AI analysis output (this is the "unique" layer) ---
    aiAnalysis: {
      sentiment: {
        type: String,
        enum: ['Positive', 'Neutral', 'Negative'],
      },
      emotion: {
        type: String,
        enum: [
          'delighted',
          'satisfied',
          'neutral',
          'confused',
          'disappointed',
          'frustrated',
          'angry',
        ],
      },
      intensity: { type: Number, min: 1, max: 10 }, // how strongly they feel
      urgency: {
        type: String,
        enum: ['low', 'medium', 'high', 'critical'],
        default: 'low',
      },
      actionable: { type: Boolean, default: false },
      tags: [{ type: String, trim: true }],
      summary: { type: String, trim: true },
      analyzedAt: { type: Date },
    },

    status: {
      type: String,
      enum: ['new', 'reviewed', 'archived'],
      default: 'new',
    },
  },
  { timestamps: true }
);

// Speeds up trend queries: filtering/grouping by tag + date
feedbackSubmissionSchema.index({ 'aiAnalysis.tags': 1, createdAt: 1 });
feedbackSubmissionSchema.index({ form: 1, createdAt: -1 });
// Sparse+unique: only applies to documents that actually have an
// externalId (social imports), so it can't collide with the many
// submissions that have none.
feedbackSubmissionSchema.index({ form: 1, externalId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('FeedbackSubmission', feedbackSubmissionSchema);
