const test = require('node:test');
const assert = require('node:assert/strict');
const { fallbackAnalysis } = require('./aiAnalysis');

// fallbackAnalysis is the deterministic keyword-based sentiment classifier
// used whenever no AI_API_KEY is configured, or the AI call itself fails —
// it's the one piece of aiAnalysis.js that's pure and safe to unit test
// without mocking network calls or environment variables.

test('classifies a comment with a negative keyword as Negative/frustrated/medium urgency', () => {
  const result = fallbackAnalysis('The app keeps crashing every time I open it.');
  assert.equal(result.sentiment, 'Negative');
  assert.equal(result.emotion, 'frustrated');
  assert.equal(result.intensity, 6);
  assert.equal(result.urgency, 'medium');
  assert.equal(result.actionable, true);
});

test('classifies a comment with a positive keyword as Positive/satisfied/low urgency', () => {
  const result = fallbackAnalysis('I love this app, the checkout is great.');
  assert.equal(result.sentiment, 'Positive');
  assert.equal(result.emotion, 'satisfied');
  assert.equal(result.intensity, 6);
  assert.equal(result.urgency, 'low');
  assert.equal(result.actionable, false);
});

test('classifies a comment with no matching keywords as Neutral', () => {
  const result = fallbackAnalysis('The delivery arrived on Tuesday afternoon.');
  assert.equal(result.sentiment, 'Neutral');
  assert.equal(result.emotion, 'neutral');
  assert.equal(result.intensity, 3);
  assert.equal(result.urgency, 'low');
  assert.equal(result.actionable, false);
});

test('treats a mixed comment (both negative and positive keywords) as Negative', () => {
  // The implementation checks isNegative first, so any negative keyword
  // wins over a positive one in the same comment.
  const result = fallbackAnalysis('The design is great but it is broken on mobile.');
  assert.equal(result.sentiment, 'Negative');
  assert.equal(result.emotion, 'frustrated');
});

test('keyword matching is case-insensitive', () => {
  const result = fallbackAnalysis('This is AMAZING, best purchase ever.');
  assert.equal(result.sentiment, 'Positive');
});

test('always tags the review as General Feedback', () => {
  const result = fallbackAnalysis('Anything at all.');
  assert.deepEqual(result.tags, ['General Feedback']);
});

test('summary is left untouched when the comment is 100 characters or fewer', () => {
  const comment = 'Short comment about the product.';
  const result = fallbackAnalysis(comment);
  assert.equal(result.summary, comment);
});

test('summary is truncated to 97 characters plus an ellipsis when the comment is over 100 characters', () => {
  const comment = 'x'.repeat(150);
  const result = fallbackAnalysis(comment);
  assert.equal(result.summary.length, 100);
  assert.equal(result.summary, 'x'.repeat(97) + '...');
});

test('stamps analyzedAt with a real Date', () => {
  const result = fallbackAnalysis('Some feedback.');
  assert.ok(result.analyzedAt instanceof Date);
});
