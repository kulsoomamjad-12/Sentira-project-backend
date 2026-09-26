const mongoose = require('mongoose');
const crypto = require('crypto');

// Question types an admin can add beyond the two built-in ones (rating,
// comment) which stay fixed so the AI analysis / CSAT / NPS pipeline always
// has a rating + comment to work with. See FeedbackSubmission for how
// answers to these are stored.
const CUSTOM_FIELD_TYPES = ['short_text', 'paragraph', 'multiple_choice', 'checkboxes', 'dropdown', 'date'];

const customFieldSchema = new mongoose.Schema(
  {
    id: { type: String, default: () => crypto.randomBytes(6).toString('hex') },
    type: { type: String, enum: CUSTOM_FIELD_TYPES, required: true },
    label: { type: String, required: true, trim: true },
    required: { type: Boolean, default: false },
    // Choices for multiple_choice / checkboxes / dropdown; ignored otherwise.
    options: [{ type: String, trim: true }],
  },
  { _id: false }
);

const feedbackFormSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    ratingType: {
      type: String,
      enum: ['stars', 'nps'],
      default: 'stars',
    },
    // Wording for the two built-in questions — customizable, but the
    // questions themselves can't be removed (everything downstream assumes
    // every submission has a rating + a comment).
    ratingLabel: { type: String, trim: true, default: 'How would you rate your experience?' },
    commentLabel: { type: String, trim: true, default: 'Tell us more about your experience' },
    collectName: { type: Boolean, default: true },
    collectEmail: { type: Boolean, default: true },
    nameRequired: { type: Boolean, default: false },
    emailRequired: { type: Boolean, default: false },
    // Admin-defined extra questions, in display order.
    fields: {
      type: [customFieldSchema],
      default: [],
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // The real tenant boundary — scoping queries always filter by this.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    // Denormalized display copy only; never used for scoping.
    companyName: { type: String, required: true },
    publicSlug: { type: String, unique: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Generate a unique public slug before saving a new form
feedbackFormSchema.pre('validate', function (next) {
  if (!this.publicSlug) {
    this.publicSlug = crypto.randomBytes(6).toString('hex');
  }
  next();
});

feedbackFormSchema.statics.CUSTOM_FIELD_TYPES = CUSTOM_FIELD_TYPES;

module.exports = mongoose.model('FeedbackForm', feedbackFormSchema);
