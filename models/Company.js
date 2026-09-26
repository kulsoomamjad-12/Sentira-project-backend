const mongoose = require('mongoose');
const crypto = require('crypto');

// The real tenant boundary. Users, forms, submissions, and tickets are all
// ultimately scoped through a form's `company` reference — replacing the
// old approach of matching on a free-text companyName string, which had no
// protection against two different companies picking the same name.
const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // The one persistent, reusable link every member of this
    // company joins with (see authController.register / getInviteLink).
    inviteCode: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

companySchema.statics.generateInviteCode = () => crypto.randomBytes(6).toString('hex');

module.exports = mongoose.model('Company', companySchema);
