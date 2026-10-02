const express = require('express');
const { createTicket, getTickets, updateTicket } = require('../controllers/ticketController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Admin-only: opening a ticket (deciding something needs follow-up and
// routing it) is an admin call — team members work the tickets they're
// assigned, but don't create new ones themselves.
router.post('/', protect, authorize('admin'), createTicket);
router.get('/', protect, getTickets);
router.patch('/:id', protect, updateTicket);

module.exports = router;
