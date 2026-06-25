const axios = require('axios');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

async function callGroq(systemPrompt, userPrompt, maxTokens = 500) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

  try {
    const response = await axios.post(
      GROQ_URL,
      { model: MODEL, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: maxTokens, temperature: 0.1 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 30000 }
    );
    return response.data.choices[0].message.content;
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    if (status === 429) throw new Error('Groq rate limit reached. Try again in a moment.');
    if (status === 401) throw new Error('Groq API key is invalid or expired.');
    if (status === 503) throw new Error('Groq service is temporarily unavailable.');
    throw new Error(`Groq API error: ${msg}`);
  }
}

async function enrichQuestion(questionText) {
  if (!questionText || !questionText.trim()) {
    return { language: 'English', category: 'other', sentiment: 'neutral', is_english: true };
  }

  const prompt = `Analyze this customer question and return ONLY valid JSON (no markdown, no explanation).

Question: "${questionText.slice(0, 500)}"

Return exactly:
{"language":"English","category":"product_info","sentiment":"neutral","is_english":true}

category must be one of: product_info, pricing, warranty, compatibility, usage, complaints, returns, other
sentiment must be one of: positive, neutral, negative`;

  try {
    const raw = await callGroq('You are a JSON-only responder. Return only valid JSON, nothing else.', prompt, 200);
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    // Validate required fields
    return {
      language: parsed.language || 'English',
      category: ['product_info','pricing','warranty','compatibility','usage','complaints','returns','other'].includes(parsed.category) ? parsed.category : 'other',
      sentiment: ['positive','neutral','negative'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
      is_english: parsed.is_english !== false
    };
  } catch (err) {
    console.error('[enrichQuestion] Failed:', err.message);
    return { language: 'English', category: 'other', sentiment: 'neutral', is_english: true };
  }
}

async function generateRagAnswer(question, kbContext, productInfo) {
  const systemPrompt = `You are a Hisense customer support specialist. Answer customer questions using the provided knowledge base context. Be concise, accurate, and helpful. Always end your response with exactly: CONFIDENCE: [number 0-100]`;

  const userPrompt = `Product Information:\n${productInfo}\n\nKnowledge Base Context:\n${kbContext}\n\nCustomer Question: ${question}\n\nProvide a helpful answer, then on the last line write:\nCONFIDENCE: [number between 0 and 100]`;

  try {
    const raw = await callGroq(systemPrompt, userPrompt, 600);
    const confidenceMatch = raw.match(/CONFIDENCE:\s*(\d+)/i);
    const confidence = confidenceMatch ? Math.min(100, Math.max(0, parseInt(confidenceMatch[1]))) : 50;
    const answer = raw.replace(/CONFIDENCE:\s*\d+/i, '').trim();
    if (!answer) throw new Error('Empty answer from Groq');
    return { answer, confidence };
  } catch (err) {
    console.error('[generateRagAnswer] Failed:', err.message);
    throw err; // Re-throw so enrichment pipeline can handle routing
  }
}

module.exports = { callGroq, enrichQuestion, generateRagAnswer };
// CQM v2.0 - 2026-06-25 - Build: final
