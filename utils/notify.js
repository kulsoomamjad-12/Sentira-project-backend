const User = require('../models/User');
const { sendMail } = require('./mailer');

// Fire-and-forget email to the company admin for a high/critical review —
// never awaited by callers so a slow/broken mail server can't delay or fail
// the response. Shared by every path that creates a FeedbackSubmission
// (public form, external logging, social-media import).
const alertAdminIfUrgent = (companyId, submission, aiAnalysis) => {
  if (!['critical', 'high'].includes(aiAnalysis.urgency)) return;

  User.findOne({ company: companyId, role: 'admin' })
    .then((admin) => {
      if (!admin) return;
      const label = aiAnalysis.urgency === 'critical' ? 'Critical' : 'Urgent';
      return sendMail({
        to: admin.email,
        subject: `${label} review received from ${submission.customerName || 'a customer'}`,
        html: `
          <p><strong>${label} (${aiAnalysis.urgency}) feedback</strong> from ${submission.customerName || 'a customer'}:</p>
          <p>"${submission.comment}"</p>
          ${aiAnalysis.summary ? `<p><em>${aiAnalysis.summary}</em></p>` : ''}
        `,
      });
    })
    .catch((error) => console.error('Failed to send urgent-feedback alert email:', error.message));
};

// Real-time "new-feedback" push to the company's room, scoped so it never
// leaks across companies. Shared by every submission-creating path.
const emitNewFeedback = (io, form, submission, aiAnalysis) => {
  io.to(form.company.toString()).emit('new-feedback', {
    id: submission._id,
    comment: submission.comment,
    summary: aiAnalysis.summary,
    sentiment: aiAnalysis.sentiment,
    urgency: aiAnalysis.urgency,
    customerName: submission.customerName,
    createdAt: submission.createdAt,
  });
};

// Combines both — the two side effects every new submission triggers,
// beyond just saving it.
const notifyNewSubmission = (io, form, submission, aiAnalysis) => {
  emitNewFeedback(io, form, submission, aiAnalysis);
  alertAdminIfUrgent(form.company, submission, aiAnalysis);
};

module.exports = { alertAdminIfUrgent, emitNewFeedback, notifyNewSubmission };
