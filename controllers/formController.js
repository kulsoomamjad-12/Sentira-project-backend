const FeedbackForm = require('../models/FeedbackForm');
const FeedbackSubmission = require('../models/FeedbackSubmission');
const Ticket = require('../models/Ticket');

const CHOICE_TYPES = ['multiple_choice', 'checkboxes', 'dropdown'];

// Shared by createForm/updateForm: makes sure admin-authored custom
// questions are well-formed before they ever reach the public form or a
// customer's submission. Returns an error string, or null if valid.
const validateFields = (fields) => {
  if (fields === undefined) return null;
  if (!Array.isArray(fields)) return 'Fields must be an array';

  for (const field of fields) {
    if (!field || typeof field !== 'object') return 'Each field must be an object';
    if (!field.label || !field.label.trim()) return 'Every question needs a label';
    if (!FeedbackForm.CUSTOM_FIELD_TYPES.includes(field.type)) {
      return `Unsupported question type: ${field.type}`;
    }
    if (CHOICE_TYPES.includes(field.type)) {
      const options = (field.options || []).map((o) => (o || '').trim()).filter(Boolean);
      if (options.length < 2) {
        return `"${field.label}" needs at least 2 options`;
      }
    }
  }
  return null;
};

// Only lets through the customizable properties a form actually has —
// shared by createForm/updateForm so both stay in sync.
const pickFormFields = (body) => {
  const {
    title,
    description,
    ratingType,
    ratingLabel,
    commentLabel,
    collectName,
    collectEmail,
    nameRequired,
    emailRequired,
    fields,
  } = body;

  const payload = {
    title,
    description,
    ratingType,
    ratingLabel,
    commentLabel,
    collectName,
    collectEmail,
    nameRequired,
    emailRequired,
  };
  if (fields !== undefined) {
    // Options are kept for every question type, not just choice types:
    // for Multiple choice/Checkboxes/Dropdown they're the real answer
    // choices; for the free-text types they're optional quick-select
    // suggestions (validateFields only enforces the 2-minimum for choice
    // types, and submitFeedback never restricts a free-text answer to them).
    payload.fields = fields.map((f) => ({
      id: f.id,
      type: f.type,
      label: f.label,
      required: !!f.required,
      options: (f.options || []).map((o) => (o || '').trim()).filter(Boolean),
    }));
  }

  // Strip undefined keys so partial updates (updateForm) don't clobber
  // fields the caller didn't send.
  Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
  return payload;
};

// POST /api/forms  (protected)
const createForm = async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) {
      return res.status(400).json({ message: 'Title is required' });
    }

    const fieldsError = validateFields(req.body.fields);
    if (fieldsError) {
      return res.status(400).json({ message: fieldsError });
    }

    const form = await FeedbackForm.create({
      ...pickFormFields(req.body),
      createdBy: req.user._id,
      company: req.user.company,
      companyName: req.user.companyName,
    });

    res.status(201).json({ form });
  } catch (error) {
    res.status(500).json({ message: 'Failed to create form', error: error.message });
  }
};

// PUT /api/forms/:id  (protected, admin-only - lets the admin customize an
// existing form: relabel the built-in questions, toggle name/email
// collection, and add/edit/remove/reorder custom questions)
const updateForm = async (req, res) => {
  try {
    const form = await FeedbackForm.findOne({ _id: req.params.id, company: req.user.company });
    if (!form) {
      return res.status(404).json({ message: 'Form not found' });
    }

    if (req.body.title !== undefined && !req.body.title.trim()) {
      return res.status(400).json({ message: 'Title is required' });
    }

    const fieldsError = validateFields(req.body.fields);
    if (fieldsError) {
      return res.status(400).json({ message: fieldsError });
    }

    Object.assign(form, pickFormFields(req.body));
    await form.save();

    res.json({ form });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update form', error: error.message });
  }
};

// GET /api/forms  (protected - lists forms for the logged-in user's company)
const getForms = async (req, res) => {
  try {
    const forms = await FeedbackForm.find({ company: req.user.company }).sort({
      createdAt: -1,
    });
    res.json({ forms });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch forms', error: error.message });
  }
};

// GET /api/forms/public/:slug  (public - used to render the submission page)
const getPublicForm = async (req, res) => {
  try {
    const form = await FeedbackForm.findOne({ publicSlug: req.params.slug, isActive: true });
    if (!form) {
      return res.status(404).json({ message: 'Form not found or no longer active' });
    }
    res.json({ form });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch form', error: error.message });
  }
};

// DELETE /api/forms/:id  (protected, admin-only - also removes every
// review and ticket collected through this form, since they'd otherwise be
// orphaned and permanently invisible to every other query in the app)
const deleteForm = async (req, res) => {
  try {
    const form = await FeedbackForm.findOne({ _id: req.params.id, company: req.user.company });
    if (!form) {
      return res.status(404).json({ message: 'Form not found' });
    }

    const submissions = await FeedbackSubmission.find({ form: form._id }).select('_id');
    const submissionIds = submissions.map((s) => s._id);

    await Ticket.deleteMany({ feedback: { $in: submissionIds } });
    await FeedbackSubmission.deleteMany({ form: form._id });
    await form.deleteOne();

    res.json({ message: 'Form deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete form', error: error.message });
  }
};

module.exports = { createForm, updateForm, getForms, getPublicForm, deleteForm };
