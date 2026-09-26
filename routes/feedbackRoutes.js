const express = require('express');
const {
  submitFeedback,
  logExternalFeedback,
  getFeedback,
  getAnalyticsSummary,
  getTopicTrends,
  translateFeedback,
  draftFeedbackResponse,
  sendFeedbackReply,
  deleteAllFeedback,
  deleteFeedback,
} = require('../controllers/feedbackController');
const { protect, authorize } = require('../middleware/auth');
const { submissionLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Protected - staff manually logging a review found elsewhere (must be
// registered before "/:slug" so "external" isn't swallowed as a slug)
router.post('/external', protect, logExternalFeedback);

// Protected - admin-only bulk wipe, so it can never collide with "/:slug"
router.delete('/all', protect, authorize('admin'), deleteAllFeedback);

// Protected - delete a single review (must stay registered after "/all" so
// that literal path isn't swallowed as an :id)
router.delete('/:id', protect, authorize('admin'), deleteFeedback);

// Protected - dashboard views
router.get('/', protect, getFeedback);
router.get('/analytics/summary', protect, getAnalyticsSummary);
router.get('/analytics/trends', protect, getTopicTrends);

// Protected - on-demand AI assist actions for one feedback item
router.post('/:id/translate', protect, translateFeedback);
router.post('/:id/draft-response', protect, draftFeedbackResponse);
router.post('/:id/send-reply', protect, sendFeedbackReply);

// Public - customer submits feedback via the shareable form link
router.post('/:slug', submissionLimiter, submitFeedback);

module.exports = router;
