const express = require('express');
const {
  fetchNow,
  createSource,
  getSources,
  updateSource,
  deleteSource,
  runSourceNow,
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

module.exports = router;
