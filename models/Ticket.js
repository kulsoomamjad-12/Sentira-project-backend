const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema(
  {
    feedback: { type: mongoose.Schema.Types.ObjectId, ref: 'FeedbackSubmission', required: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['open', 'in-progress', 'resolved'],
      default: 'open',
    },
    resolutionNotes: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Ticket', ticketSchema);
