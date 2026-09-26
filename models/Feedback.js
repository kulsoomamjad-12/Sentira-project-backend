const mongoose = require('mongoose');

const feedbackSchema = new mongoose.Schema({
  feedbackId: { type: String, required: true, unique: true },
  customerEmail: { type: String, required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, required: true },
  sentiment: { type: String, enum: ['Positive', 'Neutral', 'Negative', 'Urgent'], default: 'Neutral' },
  emotion: { type: String }, // e.g., 'Frustrated', 'Delighted', 'Confused'
  urgencyScore: { type: Number, default: 1 }, // 1 to 5 scale
  tags: [String],
  summary: { type: String },
  aiResponseDraft: { type: String },
  status: { type: String, enum: ['Open', 'In-Progress', 'Resolved'], default: 'Open' },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolutionNotes: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Feedback', feedbackSchema);