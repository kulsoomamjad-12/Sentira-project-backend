const rateLimit = require('express-rate-limit');

// Protects the public feedback submission endpoint from spam
const submissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 submissions per window
  message: { message: 'Too many submissions from this device. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { submissionLimiter };
