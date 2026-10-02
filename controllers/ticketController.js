const Ticket = require('../models/Ticket');
const FeedbackSubmission = require('../models/FeedbackSubmission');
const FeedbackForm = require('../models/FeedbackForm');

// Every submission ID belonging to the requesting user's company, via its
// form. Tickets are scoped through this everywhere below — without it,
// getTickets/createTicket would leak across companies (feedback IDs are
// guessable ObjectIds with no company check otherwise).
const companySubmissionIds = async (companyId) => {
  const forms = await FeedbackForm.find({ company: companyId }).select('_id');
  const formIds = forms.map((f) => f._id);
  const submissions = await FeedbackSubmission.find({ form: { $in: formIds } }).select('_id');
  return submissions.map((s) => s._id);
};

// POST /api/tickets  (admin-only - create a ticket from a feedback submission;
// see routes/ticketRoutes.js for the authorize('admin') guard)
const createTicket = async (req, res) => {
  try {
    const { feedbackId, assignedTo } = req.body;

    const feedback = await FeedbackSubmission.findById(feedbackId).populate('form');
    if (!feedback || feedback.form?.company?.toString() !== req.user.company.toString()) {
      return res.status(404).json({ message: 'Feedback submission not found' });
    }

    const ticket = await Ticket.create({
      feedback: feedbackId,
      assignedTo: assignedTo || undefined,
      createdBy: req.user._id,
    });

    await ticket.populate(['feedback', 'assignedTo']);
    // Skip the creator's own room — you don't need a notification about the
    // ticket you just opened yourself, only the other party does.
    req.io
      .to(req.user.company.toString())
      .except(`user:${req.user._id}`)
      .emit('ticket-created', ticket);
    res.status(201).json({ ticket });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create ticket', error: error.message });
  }
};

// GET /api/tickets  (protected)
const getTickets = async (req, res) => {
  try {
    const { status } = req.query;
    const submissionIds = await companySubmissionIds(req.user.company.toString());

    const filter = { feedback: { $in: submissionIds } };
    if (status) filter.status = status;

    const tickets = await Ticket.find(filter)
      .populate('feedback')
      .populate('assignedTo', 'name email')
      .sort({ createdAt: -1 });

    res.json({ tickets });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch tickets', error: error.message });
  }
};

// PATCH /api/tickets/:id  (protected - update status / notes / assignment)
// Resolving the actual issue — status and resolution notes — is the assigned
// team member's job, never the admin's; the admin can only view that part.
// Assignment/reassignment (routing work to someone) stays an admin
// privilege, separate from doing the work itself. A Team Member/Resolver can
// only touch status/notes on a ticket already assigned to them, and can
// never change the assignee.
const updateTicket = async (req, res) => {
  try {
    const { status, resolutionNotes, assignedTo } = req.body;
    const isAdmin = req.user.role === 'admin';
    const canAssign = isAdmin;
    const isWorkUpdate = status !== undefined || resolutionNotes !== undefined;

    const submissionIds = await companySubmissionIds(req.user.company.toString());
    const existing = await Ticket.findOne({ _id: req.params.id, feedback: { $in: submissionIds } });
    if (!existing) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    const isAssignee = existing.assignedTo && existing.assignedTo.toString() === req.user._id.toString();

    if (isWorkUpdate && isAdmin) {
      return res
        .status(403)
        .json({ message: 'Admins can view ticket status but only the assigned team member can change it' });
    }
    if (isWorkUpdate && !isAssignee) {
      return res.status(403).json({ message: 'You can only update tickets assigned to you' });
    }
    if (assignedTo !== undefined && !canAssign) {
      return res.status(403).json({ message: 'Only admins can assign tickets' });
    }

    const previousStatus = existing.status;

    const update = {};
    if (status) update.status = status;
    if (resolutionNotes !== undefined) update.resolutionNotes = resolutionNotes;
    if (assignedTo !== undefined && canAssign) update.assignedTo = assignedTo || null;

    const ticket = await Ticket.findByIdAndUpdate(req.params.id, update, { new: true }).populate([
      'feedback',
      'assignedTo',
    ]);

    // Every edit — not just the final "resolved" — is broadcast live so
    // whoever's watching (admins included) can see a ticket get picked up
    // ("seen", status open -> in-progress) or worked on (a note added),
    // not just find out once it's already done. The person who *made* the
    // edit is excluded — e.g. when a member updates a ticket, the admin
    // sees it but that same member's own bell doesn't, and vice versa.
    req.io
      .to(req.user.company.toString())
      .except(`user:${req.user._id}`)
      .emit('ticket-updated', {
        ticket,
        updatedBy: { id: req.user._id, name: req.user.name },
        previousStatus,
      });

    res.json({ ticket });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update ticket', error: error.message });
  }
};

module.exports = { createTicket, getTickets, updateTicket };
