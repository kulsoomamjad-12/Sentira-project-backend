const express = require('express');
const {
  fetchNow,
  createSource,
  getSources,
  updateSource,
  deleteSource,
  runSourceNow,
  cronRunAll,
} = require('../controllers/socialImportController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes here are staff-only (never public) — unlike the customer
// feedback form, there's no anonymous/public side to this feature.
router.post('/fetch', protect, authorize('admin'), fetchNow);

router.get('/sources', protect, getSources);
router.post('/sources', protect, authorize('admin'), createSource);
router.patch('/sources/:id', protect, authorize('admin'), updateSource);
router.delete('/sources/:id', protect, authorize('admin'), deleteSource);
router.post('/sources/:id/run', protect, authorize('admin'), runSourceNow);

// Called by Vercel's Cron Jobs (see vercel.json), never by a logged-in user
// — auth is its own CRON_SECRET check inside the handler, not the usual
// JWT. On a normal long-running deploy (local/Render/Railway), node-cron
// handles this instead and this route just sits unused.
router.get('/cron-run', cronRunAll);

module.exports = router;
