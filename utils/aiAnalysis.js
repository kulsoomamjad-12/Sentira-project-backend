/**
 * AI Analysis utility.
 *
 * Instead of returning a single sentiment label, this asks the model for a
 * richer, structured breakdown of each piece of feedback:
 *   - sentiment (Positive / Neutral / Negative)
 *   - emotion (specific feeling, not just polarity)
 *   - intensity (1-10, how strongly the customer feels)
 *   - urgency (low / medium / high / critical)
 *   - actionable (true/false - is there something the business can DO with this?)
 *   - tags (2-3 topic keywords)
 *   - summary (1-sentence executive takeaway)
 *
 * This richer output is what powers the trend-detection dashboard later.
 */

const PROVIDER = process.env.AI_PROVIDER || 'openai';
const AI_API_KEY = process.env.AI_API_KEY;

const buildPrompt = (comment, rating) => `
You are an expert customer experience analyst. Analyze the following piece of
customer feedback and return ONLY a valid JSON object, with no extra text,
no markdown formatting, and no explanation outside the JSON.

Customer rating (if provided, out of 5 or 10, may be null): ${rating ?? 'N/A'}
Feedback text: """${comment}"""

Return JSON in exactly this shape:
{
  "sentiment": "Positive" | "Neutral" | "Negative",
  "emotion": "delighted" | "satisfied" | "neutral" | "confused" | "disappointed" | "frustrated" | "angry",
  "intensity": <integer 1-10, how strongly the customer feels>,
  "urgency": "low" | "medium" | "high" | "critical",
  "actionable": <true or false, whether the business can take a concrete action from this>,
  "tags": [<1 to 3 short topic tags, e.g. "Checkout Bug", "Pricing", "UI Speed">],
  "summary": "<one sentence executive summary of the key takeaway>"
}
`;

async function callOpenAI(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callGemini(prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${AI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// Plain-text variants of the two callers above (no JSON response-format
// forcing), for prompts like translation/response-drafting where we just
// want prose back, not a structured object.
async function callOpenAIText(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

async function callGeminiText(prompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${AI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4 },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text.trim();
}

// Fallback used if the AI call fails or is not configured yet, so the app
// keeps working end-to-end while you're still setting up API keys.
function fallbackAnalysis(comment) {
  const lower = comment.toLowerCase();
  const negativeWords = ['bad', 'crash', 'broken', 'worst', 'terrible', 'slow', 'bug', 'angry'];
  const positiveWords = ['great', 'love', 'excellent', 'amazing', 'fast', 'good', 'happy'];

  const isNegative = negativeWords.some((w) => lower.includes(w));
  const isPositive = positiveWords.some((w) => lower.includes(w));

  return {
    sentiment: isNegative ? 'Negative' : isPositive ? 'Positive' : 'Neutral',
    emotion: isNegative ? 'frustrated' : isPositive ? 'satisfied' : 'neutral',
    intensity: isNegative || isPositive ? 6 : 3,
    urgency: isNegative ? 'medium' : 'low',
    actionable: isNegative,
    tags: ['General Feedback'],
    summary: comment.length > 100 ? comment.slice(0, 97) + '...' : comment,
    analyzedAt: new Date(),
  };
}

async function analyzeFeedback(comment, rating) {
  if (!AI_API_KEY) {
    console.warn('AI_API_KEY not set - using fallback keyword-based analysis.');
    return fallbackAnalysis(comment);
  }

  try {
    const prompt = buildPrompt(comment, rating);
    const rawText = PROVIDER === 'gemini' ? await callGemini(prompt) : await callOpenAI(prompt);

    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      sentiment: parsed.sentiment,
      emotion: parsed.emotion,
      intensity: parsed.intensity,
      urgency: parsed.urgency,
      actionable: parsed.actionable,
      tags: parsed.tags || [],
      summary: parsed.summary,
      analyzedAt: new Date(),
    };
  } catch (error) {
    console.error('AI analysis failed, using fallback:', error.message);
    return fallbackAnalysis(comment);
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

module.exports = { analyzeFeedback, translateText, draftResponse, fallbackAnalysis };
