const FeedbackForm = require('../models/FeedbackForm');
const SocialImportSource = require('../models/SocialImportSource');
const { PLATFORMS } = require('../utils/apifyService');
const { importComments, runSource } = require('../utils/socialImportRunner');

// Shared by every handler here: confirms the given form belongs to the
// requesting admin's company before doing anything with it.
const loadOwnedForm = async (formId, companyId) => FeedbackForm.findOne({ _id: formId, company: companyId });

// POST /api/social-import/fetch  (admin-only - one-off "Fetch & analyze"
// for a URL that isn't necessarily saved anywhere)
const fetchNow = async (req, res) => {
  try {
    const { formId, platform, url } = req.body;

    if (!formId || !platform || !url?.trim()) {
      return res.status(400).json({ message: 'formId, platform, and url are all required' });
    }
    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({ message: `Unsupported platform — expected one of: ${PLATFORMS.join(', ')}` });
    }

    const form = await loadOwnedForm(formId, req.user.company);
    if (!form) {
      return res.status(404).json({ message: 'Form not found' });
    }

    const result = await importComments({ io: req.io, form, platform, url: url.trim() });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch comments', error: error.message });
  }
};

// POST /api/social-import/sources  (admin-only - saves a link for future
// manual re-runs, and optionally for the scheduler to auto-recheck)
const createSource = async (req, res) => {
  try {
    const { formId, platform, url, label, isActive } = req.body;

    if (!formId || !platform || !url?.trim()) {
      return res.status(400).json({ message: 'formId, platform, and url are all required' });
    }
    if (!PLATFORMS.includes(platform)) {
      return res.status(400).json({ message: `Unsupported platform — expected one of: ${PLATFORMS.join(', ')}` });
    }

    const form = await loadOwnedForm(formId, req.user.company);
    if (!form) {
      return res.status(404).json({ message: 'Form not found' });
    }

    const source = await SocialImportSource.create({
      company: req.user.company,
      form: form._id,
      createdBy: req.user._id,
      platform,
      url: url.trim(),
      label,
      isActive: !!isActive,
    });
    res.status(201).json({ source });
  } catch (error) {
    res.status(500).json({ message: 'Failed to save source', error: error.message });
  }
};

// GET /api/social-import/sources  (protected - lists saved sources for the company)
const getSources = async (req, res) => {
  try {
    const sources = await SocialImportSource.find({ company: req.user.company }).sort({ createdAt: -1 });
    res.json({ sources });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch sources', error: error.message });
  }
};

// PATCH /api/social-import/sources/:id  (admin-only - edit label/url or
// toggle automatic re-checking on/off)
const updateSource = async (req, res) => {
  try {
    const source = await SocialImportSource.findOne({ _id: req.params.id, company: req.user.company });
    if (!source) {
      return res.status(404).json({ message: 'Source not found' });
    }

    const { label, url, isActive } = req.body;
    if (label !== undefined) source.label = label;
    if (url !== undefined) source.url = url.trim();
    if (isActive !== undefined) source.isActive = !!isActive;
    await source.save();

    res.json({ source });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update source', error: error.message });
  }
};

// DELETE /api/social-import/sources/:id  (admin-only)
const deleteSource = async (req, res) => {
  try {
    const source = await SocialImportSource.findOne({ _id: req.params.id, company: req.user.company });
    if (!source) {
      return res.status(404).json({ message: 'Source not found' });
    }
    await source.deleteOne();
    res.json({ message: 'Source deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete source', error: error.message });
  }
};

// POST /api/social-import/sources/:id/run  (admin-only - manually re-run a
// saved source right now, same code path the scheduler uses)
const runSourceNow = async (req, res) => {
  try {
    const source = await SocialImportSource.findOne({ _id: req.params.id, company: req.user.company });
    if (!source) {
      return res.status(404).json({ message: 'Source not found' });
    }
    const result = await runSource(source, req.io);
    res.json({ source, result });
  } catch (error) {
    res.status(500).json({ message: 'Failed to run source', error: error.message });
  }
};

// GET /api/social-import/cron-run  (called by Vercel's own Cron Jobs
// scheduler — see vercel.json's "crons" entry — since node-cron can't stay
// running between serverless invocations. Vercel automatically sends
// `Authorization: Bearer <CRON_SECRET>` on cron-triggered requests when
// CRON_SECRET is set as an env var; that's checked here instead of a normal
// user JWT, since there's no logged-in admin making this request.
// Harmless if you're NOT on Vercel (node-cron still runs there instead) —
// this route just sits unused in that case.
const cronRunAll = async (req, res) => {
  // Fail closed, not open: without CRON_SECRET configured this endpoint
  // would otherwise be a public, unauthenticated trigger that spends real
  // Apify usage on every hit — refuse everything until it's set, rather
  // than silently allowing anyone who finds the URL to run it.
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const sources = await SocialImportSource.find({ isActive: true });
  const results = [];
  for (const source of sources) {
    try {
      const result = await runSource(source, req.io);
      results.push({ sourceId: source._id, ...result });
    } catch (error) {
      results.push({ sourceId: source._id, error: error.message });
    }
  }
  res.json({ checked: sources.length, results });
};

module.exports = { fetchNow, createSource, getSources, updateSource, deleteSource, runSourceNow, cronRunAll };
