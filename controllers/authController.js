const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Company = require('../models/Company');
const Ticket = require('../models/Ticket');
const { sendMail } = require('../utils/mailer');

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

// POST /api/auth/register
const register = async (req, res) => {
  try {
    const { name, email, password, companyName, role, inviteCode } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide name, email, and password' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    const validRoles = ['admin', 'member'];
    const chosenRole = validRoles.includes(role) ? role : 'admin';

    let company;

    if (chosenRole === 'admin') {
      // Registering as admin spins up a brand-new company (a real Company
      // record, not just a name string) with a fresh invite code.
      if (!companyName) {
        return res.status(400).json({ message: 'Please provide a companyName' });
      }
      company = await Company.create({ name: companyName, inviteCode: Company.generateInviteCode() });
    } else {
      // Registering as a member joins an *existing* company — the
      // company is resolved from the invite code itself, never from
      // client-supplied text, so you can't just type any company name and
      // land inside it.
      if (!inviteCode) {
        return res
          .status(400)
          .json({ message: 'An invite link from your company admin is required to join as a team member' });
      }
      company = await Company.findOne({ inviteCode });
      if (!company) {
        return res.status(400).json({ message: 'Invalid or unrecognized invite code' });
      }
    }

    const user = await User.create({
      name,
      email,
      password,
      company: company._id,
      companyName: company.name,
      role: chosenRole,
    });

    const token = generateToken(user._id);
    res.status(201).json({ user, token });
  } catch (error) {
    res.status(500).json({ message: 'Registration failed', error: error.message });
  }
};

// POST /api/auth/login
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = generateToken(user._id);
    res.json({ user, token });
  } catch (error) {
    res.status(500).json({ message: 'Login failed', error: error.message });
  }
};

// GET /api/auth/me
const getMe = async (req, res) => {
  res.json({ user: req.user });
};

// PATCH /api/auth/me  (protected - update own profile)
const updateProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    req.user.name = name.trim();
    await req.user.save();

    res.json({ user: req.user });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update profile', error: error.message });
  }
};

// PATCH /api/auth/me/password  (protected - change own password)
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }

    const isMatch = await req.user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    req.user.password = newPassword;
    await req.user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to change password', error: error.message });
  }
};

// DELETE /api/auth/me  (protected - permanently delete own account)
const deleteAccount = async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: 'Password confirmation is required' });
    }

    const isMatch = await req.user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Password is incorrect' });
    }

    await req.user.deleteOne();

    res.json({ message: 'Account deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete account', error: error.message });
  }
};

// GET /api/auth/invite-link  (admin-only - the one persistent link/code for
// this company. It's the same for every member the admin wants to
// add, and never changes on its own — only an explicit regenerate rotates it.)
const getInviteLink = async (req, res) => {
  try {
    const company = await Company.findById(req.user.company);
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    res.json({
      inviteCode: company.inviteCode,
      inviteLink: `${process.env.CLIENT_URL}/register?invite=${company.inviteCode}`,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to load invite link', error: error.message });
  }
};

// POST /api/auth/invite-link/regenerate  (admin-only - rotates the code, so
// the old link stops working — e.g. it was shared somewhere it shouldn't have)
const regenerateInviteLink = async (req, res) => {
  try {
    const company = await Company.findById(req.user.company);
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    company.inviteCode = Company.generateInviteCode();
    await company.save();

    res.json({
      inviteCode: company.inviteCode,
      inviteLink: `${process.env.CLIENT_URL}/register?invite=${company.inviteCode}`,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to regenerate invite link', error: error.message });
  }
};

// POST /api/auth/invite-link/send  (admin-only - emails the current invite
// link straight to a teammate instead of the admin copy/pasting it manually)
const sendInviteEmail = async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: "The invitee's name is required" });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ message: 'An email address is required' });
    }

    const company = await Company.findById(req.user.company);
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const inviteLink = `${process.env.CLIENT_URL}/register?invite=${company.inviteCode}`;

    // One shared template for every invite — only the invitee's name, the
    // admin's name, the company name, and the link ever change.
    await sendMail({
      to: email.trim(),
      subject: `You're invited to join ${company.name} on Sentira`,
      html: `
        <p>Hi ${name.trim()},</p>
        <p>${req.user.name} has invited you to join <strong>${company.name}</strong> on Sentira as a team member. Click the link below to create your account and get started:</p>
        <p><a href="${inviteLink}">${inviteLink}</a></p>
      `,
    });

    res.json({ message: 'Invite email sent' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to send invite email', error: error.message });
  }
};

// GET /api/auth/team  (protected - lists everyone in the requester's company,
// used to populate ticket-assignment dropdowns)
const getTeam = async (req, res) => {
  try {
    const team = await User.find({ company: req.user.company }).select('name email role');
    res.json({ team });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch team', error: error.message });
  }
};

// DELETE /api/auth/team/:id  (admin-only - removes a teammate from the
// company. Tickets already assigned to them are unassigned, not deleted, so
// the underlying work isn't lost — just needs a new assignee.)
const removeTeamMember = async (req, res) => {
  try {
    const member = await User.findOne({ _id: req.params.id, company: req.user.company });
    if (!member) {
      return res.status(404).json({ message: 'Team member not found' });
    }
    if (member._id.toString() === req.user._id.toString()) {
      return res
        .status(400)
        .json({ message: 'You cannot remove your own account here — use Account Settings to delete it.' });
    }
    if (member.role === 'admin') {
      return res.status(403).json({ message: 'Cannot remove another admin' });
    }

    await Ticket.updateMany({ assignedTo: member._id }, { assignedTo: null });
    await member.deleteOne();

    res.json({ message: 'Team member removed' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to remove team member', error: error.message });
  }
};

module.exports = {
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
};
