const express = require('express');
const { createForm, updateForm, getForms, getPublicForm, deleteForm } = require('../controllers/formController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Public route - must come before any :id-style protected routes if added later
router.get('/public/:slug', getPublicForm);

// Protected routes
router.post('/', protect, authorize('admin'), createForm);
router.get('/', protect, getForms);
router.put('/:id', protect, authorize('admin'), updateForm);
router.delete('/:id', protect, authorize('admin'), deleteForm);

module.exports = router;
