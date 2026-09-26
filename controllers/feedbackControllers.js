const Feedback = require('../models/Feedback');
const { analyzeFeedbackWithAI } = require('../utils/aiAnalyzer');

exports.submitFeedback = async (req, res) => {
  try {
    const { customerEmail, rating, comment } = req.body;
    const feedbackId = 'FB-' + Math.floor(1000 + Math.random() * 9000);

    // Run Advanced AI Engine
    const aiAnalysis = await analyzeFeedbackWithAI(comment, rating);

    const feedback = new বৃহত্তর({
      feedbackId,
      customerEmail,
      rating,
      comment,
      ...aiAnalysis
    });

    // Handle variable naming safety if needed
    const savedFeedback = await feedback.save();

    // ⚡ Emit real-time WebSocket event to dashboard clients
    req.io.emit('new-feedback', savedFeedback);

    res.status(201).json({ success: true, data: savedFeedback });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getFeedbacks = async (req, res) => {
  try {
    const feedbacks = await Feedback.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: feedbacks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateTicketStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, assignedTo, resolutionNotes } = req.body;
    const updated = await Feedback.findByIdAndUpdate(
      id,
      { status, assignedTo, resolutionNotes },
      { new: true }
    );
    req.io.emit('ticket-updated', updated);
    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};