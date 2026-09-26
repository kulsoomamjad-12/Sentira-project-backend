const FeedbackForm = require('../models/FeedbackForm');
const FeedbackSubmission = require('../models/FeedbackSubmission');
const Ticket = require('../models/Ticket');
const { analyzeFeedback, translateText, draftResponse } = require('../utils/aiAnalysis');
const { sendMail } = require('../utils/mailer');
const { notifyNewSubmission } = require('../utils/notify');

// Shared by translateFeedback/draftFeedbackResponse: loads a submission and
// verifies it belongs to the requesting user's company via its form.
const findOwnedSubmission = async (id, companyId) => {
  const submission = await FeedbackSubmission.findById(id).populate('form');
  if (!submission || submission.form?.company?.toString() !== companyId.toString()) {
    return null;
  }
  return submission;
};

// Shared by getFeedback/getAnalyticsSummary/getTopicTrends: the company's
// form IDs, optionally narrowed to one specific form (for the dashboard's
// per-form switcher) — never trusts a bare formId without checking it
// actually belongs to this company first.
const resolveFormIds = async (companyId, formId) => {
  const query = { company: companyId };
  if (formId) query._id = formId;
  const forms = await FeedbackForm.find(query).select('_id');
  return forms.map((f) => f._id);
};

// Validates a customer's answers against the form's admin-defined custom
// questions (required-ness, choice membership) and snapshots them into the
// shape stored on the submission. Returns { error } or { responses }.
const buildCustomResponses = (form, rawResponses) => {
  const answers = rawResponses && typeof rawResponses === 'object' ? rawResponses : {};
  const responses = [];

  for (const field of form.fields || []) {
    const value = answers[field.id];
    const isEmpty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);

    if (field.required && isEmpty) {
      return { error: `"${field.label}" is required` };
    }
    if (isEmpty) continue;

    if (field.type === 'checkboxes') {
      const values = Array.isArray(value) ? value : [value];
      if (values.some((v) => !field.options.includes(v))) {
        return { error: `Invalid selection for "${field.label}"` };
      }
      responses.push({ fieldId: field.id, label: field.label, type: field.type, value: values });
    } else if (['multiple_choice', 'dropdown'].includes(field.type)) {
      if (!field.options.includes(value)) {
        return { error: `Invalid selection for "${field.label}"` };
      }
      responses.push({ fieldId: field.id, label: field.label, type: field.type, value });
    } else {
      responses.push({ fieldId: field.id, label: field.label, type: field.type, value: String(value) });
    }
  }

  return { responses };
};

// POST /api/feedback/:slug  (public - customer submits feedback)
const submitFeedback = async (req, res) => {
  try {
    const { slug } = req.params;
    const { customerName, customerEmail, rating, comment, responses } = req.body;

    if (!comment || comment.trim().length < 3) {
      return res.status(400).json({ message: 'Feedback comment is required' });
    }

    const form = await FeedbackForm.findOne({ publicSlug: slug, isActive: true });
    if (!form) {
      return res.status(404).json({ message: 'Feedback form not found' });
    }

    if (form.collectName && form.nameRequired && !customerName?.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }
    if (form.collectEmail && form.emailRequired && !customerEmail?.trim()) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const { error: responsesError, responses: builtResponses } = buildCustomResponses(form, responses);
    if (responsesError) {
      return res.status(400).json({ message: responsesError });
    }

    // Run the multi-dimensional AI analysis (see server/utils/aiAnalysis.js)
    const aiAnalysis = await analyzeFeedback(comment, rating);

    const submission = await FeedbackSubmission.create({
      form: form._id,
      customerName: form.collectName ? customerName : undefined,
      customerEmail: form.collectEmail ? customerEmail : undefined,
      rating,
      ratingType: form.ratingType,
      comment,
      responses: builtResponses,
      aiAnalysis,
    });

    // Real-time notification for every submission, scoped to this company's
    // room only — the bell decides how to word/highlight it based on urgency.
    notifyNewSubmission(req.io, form, submission, aiAnalysis);

    res.status(201).json({
      message: 'Thank you for your feedback!',
      submissionId: submission._id,
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to submit feedback', error: error.message });
  }
};

// POST /api/feedback/external  (protected - staff manually logs a review they
// found elsewhere, e.g. on a marketplace or social post, instead of it coming
// through the public form link)
const logExternalFeedback = async (req, res) => {
  try {
    const { formId, customerName, sourceUrl, rating, comment, responses } = req.body;

    if (!comment || comment.trim().length < 3) {
      return res.status(400).json({ message: 'Feedback comment is required' });
    }
    if (!customerName || !customerName.trim()) {
      return res.status(400).json({ message: 'Customer name is required' });
    }

    const form = await FeedbackForm.findOne({ _id: formId, company: req.user.company });
    if (!form) {
      return res.status(404).json({ message: 'Form not found' });
    }

    const { error: responsesError, responses: builtResponses } = buildCustomResponses(form, responses);
    if (responsesError) {
      return res.status(400).json({ message: responsesError });
    }

    const aiAnalysis = await analyzeFeedback(comment, rating);

    const submission = await FeedbackSubmission.create({
      form: form._id,
      customerName,
      rating,
      ratingType: form.ratingType,
      comment,
      responses: builtResponses,
      source: 'external',
      sourceUrl,
      aiAnalysis,
    });

    notifyNewSubmission(req.io, form, submission, aiAnalysis);

    res.status(201).json({ submission });
  } catch (error) {
    res.status(500).json({ message: 'Failed to log feedback', error: error.message });
  }
};

// GET /api/feedback  (protected - list feedback for the company's forms)
const getFeedback = async (req, res) => {
  try {
    const { sentiment, urgency, tag, startDate, endDate, formId } = req.query;

    const formIds = await resolveFormIds(req.user.company, formId);

    const filter = { form: { $in: formIds } };
    if (sentiment) filter['aiAnalysis.sentiment'] = sentiment;
    if (urgency) filter['aiAnalysis.urgency'] = urgency;
    if (tag) filter['aiAnalysis.tags'] = tag;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const feedback = await FeedbackSubmission.find(filter).sort({ createdAt: -1 }).limit(200);
    res.json({ feedback });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch feedback', error: error.message });
  }
};

// GET /api/feedback/analytics/summary  (protected - CSAT/NPS + sentiment breakdown)
const getAnalyticsSummary = async (req, res) => {
  try {
    const formIds = await resolveFormIds(req.user.company, req.query.formId);

    const summary = await FeedbackSubmission.aggregate([
      { $match: { form: { $in: formIds } } },
      {
        $group: {
          _id: '$aiAnalysis.sentiment',
          count: { $sum: 1 },
          avgRating: { $avg: '$rating' },
        },
      },
    ]);

    const total = summary.reduce((sum, s) => sum + s.count, 0);

    // CSAT: average star rating (1-5), computed only from stars-scale submissions.
    const csatAgg = await FeedbackSubmission.aggregate([
      { $match: { form: { $in: formIds }, ratingType: 'stars', rating: { $ne: null } } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    const csat = csatAgg.length
      ? { average: Number(csatAgg[0].avg.toFixed(1)), count: csatAgg[0].count }
      : null;

    // NPS: %promoters (9-10) minus %detractors (0-6), computed only from
    // nps-scale submissions. Passives (7-8) count toward the total but not
    // the promoter/detractor split, per standard NPS methodology.
    const npsAgg = await FeedbackSubmission.aggregate([
      { $match: { form: { $in: formIds }, ratingType: 'nps', rating: { $ne: null } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          promoters: { $sum: { $cond: [{ $gte: ['$rating', 9] }, 1, 0] } },
          detractors: { $sum: { $cond: [{ $lte: ['$rating', 6] }, 1, 0] } },
        },
      },
    ]);
    const nps = npsAgg.length
      ? {
          score: Math.round(((npsAgg[0].promoters - npsAgg[0].detractors) / npsAgg[0].total) * 100),
          count: npsAgg[0].total,
        }
      : null;

    res.json({
      totalFeedback: total,
      csat,
      nps,
      breakdown: summary.map((s) => ({
        sentiment: s._id || 'Unclassified',
        count: s.count,
        percentage: total ? Math.round((s.count / total) * 100) : 0,
        avgRating: s.avgRating ? Number(s.avgRating.toFixed(2)) : null,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to compute analytics', error: error.message });
  }
};

// GET /api/feedback/analytics/trends  (protected - the "unique" trend-over-time feature)
// Returns, per topic tag, how many mentions occurred per week, so the
// dashboard can plot "complaints about X rose/fell over time".
const getTopicTrends = async (req, res) => {
  try {
    const formIds = await resolveFormIds(req.user.company, req.query.formId);

    const trends = await FeedbackSubmission.aggregate([
      { $match: { form: { $in: formIds } } },
      { $unwind: '$aiAnalysis.tags' },
      {
        $group: {
          _id: {
            tag: '$aiAnalysis.tags',
            week: { $dateTrunc: { date: '$createdAt', unit: 'week' } },
          },
          count: { $sum: 1 },
          avgIntensity: { $avg: '$aiAnalysis.intensity' },
        },
      },
      { $sort: { '_id.week': 1 } },
      {
        $group: {
          _id: '$_id.tag',
          weeklyCounts: {
            $push: {
              week: '$_id.week',
              count: '$count',
              avgIntensity: { $round: ['$avgIntensity', 1] },
            },
          },
          totalMentions: { $sum: '$count' },
        },
      },
      { $sort: { totalMentions: -1 } },
      { $limit: 10 },
    ]);

    res.json({ trends });
  } catch (error) {
    res.status(500).json({ message: 'Failed to compute trends', error: error.message });
  }
};

// POST /api/feedback/:id/translate  (protected - on-demand, one item at a time)
const translateFeedback = async (req, res) => {
  try {
    const submission = await findOwnedSubmission(req.params.id, req.user.company);
    if (!submission) {
      return res.status(404).json({ message: 'Feedback not found' });
    }

    const result = await translateText(submission.comment);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Failed to translate feedback', error: error.message });
  }
};

// POST /api/feedback/:id/draft-response  (protected - on-demand AI reply draft)
const draftFeedbackResponse = async (req, res) => {
  try {
    const submission = await findOwnedSubmission(req.params.id, req.user.company);
    if (!submission) {
      return res.status(404).json({ message: 'Feedback not found' });
    }

    const result = await draftResponse(submission.comment, submission.aiAnalysis?.sentiment);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Failed to draft response', error: error.message });
  }
};

// POST /api/feedback/:id/send-reply  (protected - emails the (usually
// AI-drafted) reply straight to the customer who left this review, using
// whichever email they gave when submitting. Only possible when the
// customer actually provided one — external/anonymous reviews have none.)
const sendFeedbackReply = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'A reply message is required' });
    }

    const submission = await findOwnedSubmission(req.params.id, req.user.company);
    if (!submission) {
      return res.status(404).json({ message: 'Feedback not found' });
    }
    if (!submission.customerEmail) {
      return res.status(400).json({ message: 'This customer did not leave an email address' });
    }

    await sendMail({
      to: submission.customerEmail,
      subject: `Re: your feedback`,
      html: `
        <p>Hi ${submission.customerName || 'there'},</p>
        <p>${message.trim().replace(/\n/g, '<br>')}</p>
      `,
    });

    res.json({ message: 'Reply sent' });
  } catch (error) {
    console.error('Failed to send reply:', error.message);
    res.status(500).json({ message: `Failed to send reply: ${error.message}` });
  }
};

// DELETE /api/feedback/all  (admin-only - permanently wipes every review for
// the company, plus any tickets built on them, so the account can start
// fresh. Password-confirmed, same pattern as deleting your own account.)
const deleteAllFeedback = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ message: 'Password confirmation is required' });
    }

    const isMatch = await req.user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Password is incorrect' });
    }

    const formIds = await resolveFormIds(req.user.company);
    const submissions = await FeedbackSubmission.find({ form: { $in: formIds } }).select('_id');
    const submissionIds = submissions.map((s) => s._id);

    await Ticket.deleteMany({ feedback: { $in: submissionIds } });
    const result = await FeedbackSubmission.deleteMany({ form: { $in: formIds } });

    res.json({ message: 'All reviews deleted', deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete reviews', error: error.message });
  }
};

// DELETE /api/feedback/:id  (admin-only - deletes one review, plus any
// ticket built on it, same cascade pattern as deleteAllFeedback/deleteForm)
const deleteFeedback = async (req, res) => {
  try {
    const submission = await findOwnedSubmission(req.params.id, req.user.company);
    if (!submission) {
      return res.status(404).json({ message: 'Feedback not found' });
    }

    await Ticket.deleteMany({ feedback: submission._id });
    await submission.deleteOne();

    res.json({ message: 'Review deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete review', error: error.message });
  }
};

module.exports = {
  submitFeedback,
  logExternalFeedback,
  getFeedback,
  getAnalyticsSummary,
  getTopicTrends,
  translateFeedback,
  draftFeedbackResponse,
  sendFeedbackReply,
  deleteAllFeedback,
  deleteFeedback,
};
