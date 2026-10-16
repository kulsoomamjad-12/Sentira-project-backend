/**
 * AI Analysis utility.
 *
 * Instead of returning a single sentiment label, this asks the model for a
 * richer, structured breakdown of each piece of feedback:
 *   - sentiment (Positive / Neutral / Negative)
 *   - emotion (specific feeling, not just polarity)
 *   - intensity (1-10, how strongly the customer feels)
 *   - urgency (low / high / critical)
 *   - actionable (true/false - is there something the business can DO with this?)
 *   - tags (1-3 topic keywords)
 *   - summary (1-sentence executive takeaway)
 *
 * This richer output is what powers the trend-detection dashboard later.
 */

const PROVIDER = process.env.AI_PROVIDER || 'openai';
const AI_API_KEY = process.env.AI_API_KEY;

// Primary Gemini model, then a fallback tried if the primary keeps failing
// (Google regularly answers "503 high demand" for a few seconds at a time).
const GEMINI_MODELS = [process.env.GEMINI_MODEL || 'gemini-3.6-flash', 'gemini-flash-latest'];

const RATING_SCALE = { stars: 5, nps: 10 };

// Turns the custom questions' answers into extra context for the model, so a
// short comment like "ok" next to "Would you buy again? -> No" still reads
// as negative.
const formatResponsesForPrompt = (responses) =>
  (responses || [])
    .filter((r) => r && r.value != null && r.value !== '')
    .map((r) => `- ${r.label || 'Question'}: ${Array.isArray(r.value) ? r.value.join(', ') : r.value}`)
    .join('\n');

const buildPrompt = (comment, rating, { ratingType, responses } = {}) => {
  const scale = RATING_SCALE[ratingType];
  const ratingText = rating == null ? 'N/A' : scale ? `${rating} out of ${scale}` : `${rating} (scale unknown, 5 or 10)`;
  const answers = formatResponsesForPrompt(responses);

  return `
You are an expert customer experience analyst. Analyze the following customer
feedback and return ONLY a valid JSON object, with no extra text, no markdown
formatting, and no explanation outside the JSON.

Customer rating: ${ratingText}
Feedback text: """${comment}"""
${answers ? `Answers to the form's other questions:\n${answers}\n` : ''}
Classification rules - follow them strictly:
- sentiment:
  - "Negative" if the customer complains, criticises, reports a problem or
    defect (e.g. "poor quality", "damaged", "late", "rude staff", "too
    expensive", "not worth it"), or is unhappy in any way - even if the
    complaint is short, polite, or mixed with some praise.
  - "Positive" if the customer is clearly happy or praising, with no complaint.
  - "Neutral" ONLY for purely factual statements with no clear feeling.
    Never use Neutral for a complaint.
  - The written text matters most. If the rating and the text disagree,
    trust the text (people often mis-click the rating).
- urgency (only "low", "high" or "critical" - never "medium"):
  - "low": Positive or Neutral feedback, or a minor/cosmetic complaint.
  - "high": a real problem the customer experienced that the business should
    follow up on (bad quality, damaged or wrong item, delivery problems, poor
    service, billing issues, a bug).
  - "critical": severe issues - safety or health risk, injury, legal threat,
    fraud/scam, data or security breach, money taken wrongly, or an angry
    customer threatening to leave or go public.
- emotion must match the sentiment (a Negative review is never "neutral").

Return JSON in exactly this shape:
{
  "sentiment": "Positive" | "Neutral" | "Negative",
  "emotion": "delighted" | "satisfied" | "neutral" | "confused" | "disappointed" | "frustrated" | "angry",
  "intensity": <integer 1-10, how strongly the customer feels>,
  "urgency": "low" | "high" | "critical",
  "actionable": <true or false, whether the business can take a concrete action from this>,
  "tags": [<1 to 3 short topic tags, e.g. "Product Quality", "Shipping Damage", "Pricing">],
  "summary": "<one sentence executive summary of the key takeaway>"
}
`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POSTs JSON, retrying a couple of times on temporary errors (rate limit /
// "high demand" 503 / other 5xx / network blips) instead of giving up on the
// first hiccup. Permanent errors (bad key, unknown model) fail immediately.
async function postJsonWithRetry(url, { headers = {}, body }, label, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      });
    } catch (networkError) {
      lastError = networkError;
    }

    if (response) {
      if (response.ok) return response.json();
      lastError = new Error(`${label} API error: ${response.status} ${response.statusText}`);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;
    }

    if (attempt < attempts) await sleep(700 * attempt);
  }
  throw lastError;
}

async function callOpenAIRaw(prompt, { json, temperature }) {
  const data = await postJsonWithRetry(
    'https://api.openai.com/v1/chat/completions',
    {
      headers: { Authorization: `Bearer ${AI_API_KEY}` },
      body: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      },
    },
    'OpenAI'
  );
  return data.choices[0].message.content.trim();
}

async function callGeminiRaw(prompt, { json, temperature }) {
  let lastError;
  for (const model of GEMINI_MODELS) {
    try {
      const data = await postJsonWithRetry(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${AI_API_KEY}`,
        {
          body: {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
          },
        },
        `Gemini (${model})`
      );
      // Skip any "thought" parts newer models may include before the answer
      const parts = data.candidates?.[0]?.content?.parts || [];
      const text = parts
        .filter((p) => !p.thought && p.text)
        .map((p) => p.text)
        .join('');
      if (!text) throw new Error(`Gemini (${model}) returned an empty response`);
      return text.trim();
    } catch (error) {
      lastError = error;
      console.warn(`Gemini model ${model} failed: ${error.message}`);
    }
  }
  throw lastError;
}

const callOpenAI = (prompt) => callOpenAIRaw(prompt, { json: true, temperature: 0.2 });
const callGemini = (prompt) => callGeminiRaw(prompt, { json: true, temperature: 0.2 });

// Plain-text variants of the two callers above (no JSON response-format
// forcing), for prompts like translation/response-drafting where we just
// want prose back, not a structured object.
const callOpenAIText = (prompt) => callOpenAIRaw(prompt, { json: false, temperature: 0.4 });
const callGeminiText = (prompt) => callGeminiRaw(prompt, { json: false, temperature: 0.4 });

// Urgency has three levels: low / high / critical. "medium" was removed —
// older submissions (and any model that still answers "medium") are treated
// as "high" so a real issue never silently drops to "low".
const URGENCY_LEVELS = ['low', 'high', 'critical'];
function normalizeUrgency(urgency) {
  if (urgency === 'medium') return 'high';
  return URGENCY_LEVELS.includes(urgency) ? urgency : 'low';
}

const SENTIMENTS = ['Positive', 'Neutral', 'Negative'];
const EMOTIONS = ['delighted', 'satisfied', 'neutral', 'confused', 'disappointed', 'frustrated', 'angry'];

// --- Keyword fallback ---
// Used if the AI call fails or isn't configured, so the app keeps working
// end-to-end. Deliberately broad on complaints: a missed complaint shown as
// "Neutral" is worse than the occasional false alarm.
const NEGATIVE_WORDS = [
  'bad', 'poor', 'poorly', 'worst', 'terrible', 'horrible', 'awful', 'pathetic', 'useless', 'disgusting',
  'crash', 'crashes', 'crashing', 'broken', 'broke', 'bug', 'buggy', 'error', 'fail', 'failed', 'faulty',
  'defective', 'damaged', 'damage', 'torn', 'cracked', 'leaking', 'missing', 'wrong', 'incorrect',
  'slow', 'late', 'delayed', 'delay', 'never arrived', 'not received', 'lost',
  'rude', 'unprofessional', 'ignored', 'unhelpful', 'careless',
  'expensive', 'overpriced', 'waste', 'rip off', 'ripoff',
  'angry', 'annoyed', 'frustrated', 'frustrating', 'disappointed', 'disappointing', 'unhappy', 'upset',
  'hate', 'complaint', 'complain', 'problem', 'issue', 'refund', 'dirty', 'stale', 'mistake',
  'allergy', 'rash', 'itching', 'sick', 'unresponsive', "doesn't work", 'not working', 'stopped working',
];
const POSITIVE_WORDS = [
  'great', 'love', 'loved', 'excellent', 'amazing', 'fast', 'good', 'happy', 'awesome', 'perfect',
  'fantastic', 'wonderful', 'best', 'nice', 'satisfied', 'recommend', 'helpful', 'friendly', 'thank',
  'thanks', 'impressed', 'smooth', 'easy', 'quick', 'beautiful', 'delicious', 'worth',
];
const CRITICAL_WORDS = [
  'scam', 'fraud', 'lawsuit', 'lawyer', 'sue', 'police', 'unsafe', 'dangerous', 'injury', 'injured',
  'poison', 'food poisoning', 'allergy', 'allergic', 'burn', 'burned', 'fire', 'hospital', 'hacked',
  'stolen', 'stole', 'data breach',
  'charged twice', 'double charged', 'consumer court',
];
const ANGRY_WORDS = ['angry', 'furious', 'worst', 'hate', 'disgusting', 'pathetic', 'scam', 'fraud'];
const MINOR_WORDS = ['minor', 'slight', 'slightly', 'small', 'little bit', 'a bit'];
const NEGATORS = ['not', 'no', 'never', "isn't", "wasn't", "aren't", "don't", "didn't", "doesn't", 'hardly'];

const TOPIC_TAGS = [
  ['Product Quality', ['quality', 'poor', 'defective', 'faulty', 'cheap', 'broken', 'material']],
  ['Shipping & Packaging', ['ship', 'shipped', 'shipping', 'deliver', 'delivery', 'package', 'packaging', 'packed', 'paked', 'courier', 'arrived', 'damaged']],
  ['Pricing', ['price', 'expensive', 'overpriced', 'cost', 'refund', 'charged', 'money', 'worth']],
  ['Customer Service', ['service', 'staff', 'support', 'rude', 'agent', 'helpful', 'friendly']],
  ['App / Website', ['app', 'website', 'crash', 'bug', 'login', 'checkout']],
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Also matches simple plurals / past tense ("issues", "crashed")
const hasTerm = (text, term) => new RegExp(`\\b${escapeRegex(term)}(?:s|es|ed|d)?\\b`, 'i').test(text);
const countTerms = (text, terms) => terms.filter((t) => hasTerm(text, t)).length;

// "not good" / "wasn't happy" flip a positive word into a complaint, and
// "not bad" softens a negative one. Allows one word in between ("not very good").
const negatedTerms = (text, terms) =>
  terms.filter((t) =>
    NEGATORS.some((n) => new RegExp(`\\b${escapeRegex(n)}\\s+(?:\\w+\\s+)?${escapeRegex(t)}\\b`, 'i').test(text))
  ).length;

function fallbackAnalysis(comment, rating, { ratingType, responses } = {}) {
  const answers = (responses || [])
    .map((r) => (Array.isArray(r.value) ? r.value.join(' ') : String(r.value ?? '')))
    .join(' ');
  const text = `${comment} ${answers}`.toLowerCase();

  const negatedPositive = negatedTerms(text, POSITIVE_WORDS);
  const negatedNegative = negatedTerms(text, NEGATIVE_WORDS);
  const negativeScore = countTerms(text, NEGATIVE_WORDS) - negatedNegative + negatedPositive;
  const positiveScore = countTerms(text, POSITIVE_WORDS) - negatedPositive + negatedNegative;
  const isCritical = CRITICAL_WORDS.some((w) => hasTerm(text, w));

  // Any complaint wins over praise in the same comment; only when the text
  // carries no feeling at all does the rating decide.
  let sentiment = 'Neutral';
  if (negativeScore > 0 || isCritical) sentiment = 'Negative';
  else if (positiveScore > 0) sentiment = 'Positive';
  else if (rating != null && RATING_SCALE[ratingType]) {
    const ratio = rating / RATING_SCALE[ratingType];
    if (ratio <= 0.4) sentiment = 'Negative';
    else if (ratio >= 0.8) sentiment = 'Positive';
  }

  const isNegative = sentiment === 'Negative';
  const isPositive = sentiment === 'Positive';
  const isAngry = isNegative && (isCritical || ANGRY_WORDS.some((w) => hasTerm(text, w)));

  const tags = TOPIC_TAGS.filter(([, words]) => words.some((w) => hasTerm(text, w)))
    .map(([tag]) => tag)
    .slice(0, 3);

  return {
    sentiment,
    emotion: isAngry ? 'angry' : isNegative ? 'frustrated' : isPositive ? 'satisfied' : 'neutral',
    intensity: isAngry ? 8 : isNegative || isPositive ? 6 : 3,
    // A complaint the customer calls minor ("minor issues") doesn't need urgent follow-up
    urgency: isCritical ? 'critical' : isNegative && !MINOR_WORDS.some((w) => hasTerm(text, w)) ? 'high' : 'low',
    actionable: isNegative,
    tags: tags.length ? tags : ['General Feedback'],
    summary: comment.length > 100 ? comment.slice(0, 97) + '...' : comment,
    method: 'fallback',
    analyzedAt: new Date(),
  };
}

// `context` is optional: { ratingType: 'stars' | 'nps', responses: [...] }
// (the custom questions' answers) — both make the analysis more accurate.
async function analyzeFeedback(comment, rating, context = {}) {
  if (!AI_API_KEY) {
    console.warn('AI_API_KEY not set - using fallback keyword-based analysis.');
    return fallbackAnalysis(comment, rating, context);
  }

  try {
    const prompt = buildPrompt(comment, rating, context);
    const rawText = PROVIDER === 'gemini' ? await callGemini(prompt) : await callOpenAI(prompt);

    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!SENTIMENTS.includes(parsed.sentiment)) {
      throw new Error(`AI returned an invalid sentiment: ${parsed.sentiment}`);
    }
    const isNegative = parsed.sentiment === 'Negative';

    return {
      sentiment: parsed.sentiment,
      emotion: EMOTIONS.includes(parsed.emotion) ? parsed.emotion : isNegative ? 'disappointed' : 'neutral',
      intensity: Math.min(10, Math.max(1, Math.round(Number(parsed.intensity) || 5))),
      urgency: normalizeUrgency(parsed.urgency),
      actionable: Boolean(parsed.actionable),
      tags: Array.isArray(parsed.tags) && parsed.tags.length ? parsed.tags.slice(0, 3) : ['General Feedback'],
      summary: parsed.summary,
      method: 'ai',
      analyzedAt: new Date(),
    };
  } catch (error) {
    console.error('AI analysis failed, using fallback:', error.message);
    return fallbackAnalysis(comment, rating, context);
  }
}

// Translates a single piece of feedback to English on demand (called only
// when a staff member clicks "Translate" on a specific item — not run
// automatically on every submission, to avoid doubling AI cost on feedback
// nobody ever looks at).
async function translateText(text) {
  if (!AI_API_KEY) {
    return { translation: text, translated: false, note: 'AI_API_KEY not set — showing original text.' };
  }

  const prompt = `Translate the following customer feedback to English. If it is already in English, return it completely unchanged. Return ONLY the translated text with no explanation, no quotes, and no extra commentary.\n\nFeedback: """${text}"""`;

  try {
    const translation =
      PROVIDER === 'gemini' ? await callGeminiText(prompt) : await callOpenAIText(prompt);
    return { translation, translated: true };
  } catch (error) {
    console.error('Translation failed:', error.message);
    return { translation: text, translated: false, note: 'Translation failed — showing original text.' };
  }
}

// Drafts a short, empathetic customer-service reply to a piece of feedback,
// on demand (one-click, per item — never sent automatically).
async function draftResponse(comment, sentiment) {
  const fallback =
    "Thank you for taking the time to share this with us. We've received your feedback and a member of our team will follow up shortly.";

  if (!AI_API_KEY) {
    return { draft: fallback, generated: false };
  }

  const prompt = `You are a customer support agent. Write a short (2-4 sentence), warm, professional reply to the following ${sentiment || ''} customer feedback. Acknowledge their specific point, and if the feedback is negative, apologize briefly and note the issue is being looked into. Return ONLY the reply text, no subject line, no signature, no explanation.\n\nFeedback: """${comment}"""`;

  try {
    const draft = PROVIDER === 'gemini' ? await callGeminiText(prompt) : await callOpenAIText(prompt);
    return { draft, generated: true };
  } catch (error) {
    console.error('Draft response failed:', error.message);
    return { draft: fallback, generated: false };
  }
}

module.exports = { analyzeFeedback, translateText, draftResponse, fallbackAnalysis, normalizeUrgency };
