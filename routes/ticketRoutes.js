const express = require('express');
const { createTicket, getTickets, updateTicket } = require('../controllers/ticketController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.post('/', protect, createTicket);
router.get('/', protect, getTickets);
router.patch('/:id', protect, updateTicket);

module.exports = router;
