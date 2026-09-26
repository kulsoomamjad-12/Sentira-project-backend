const express = require('express');
const {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
  deleteAccount,
  getInviteLink,
  regenerateInviteLink,
  sendInviteEmail,
  getTeam,
  removeTeamMember,
} = require('../controllers/authController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', protect, getMe);
router.patch('/me', protect, updateProfile);
router.patch('/me/password', protect, changePassword);
router.delete('/me', protect, deleteAccount);

router.get('/invite-link', protect, authorize('admin'), getInviteLink);
router.post('/invite-link/regenerate', protect, authorize('admin'), regenerateInviteLink);
router.post('/invite-link/send', protect, authorize('admin'), sendInviteEmail);

router.get('/team', protect, getTeam);
router.delete('/team/:id', protect, authorize('admin'), removeTeamMember);

module.exports = router;
