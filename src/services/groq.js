const axios = require('axios');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

async function callGroq(systemPrompt, userPrompt, maxTokens = 500) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

  const response = await axios.post(
    GROQ_URL,
    {
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ],
      max_tokens: maxTokens,
      temperature: 0.1
    },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
  );

  return response.data.choices[0].message.content;
}

async function enrichQuestion(questionText) {
  const prompt = `Analyze this customer question and return ONLY valid JSON.

Question: "${questionText}"

Return exactly this JSON structure:
{
  "language": "English",
  "category": "product_info",
  "sentiment": "neutral",
  "is_english": true
}

category must be one of: product_info, pricing, warranty, compatibility, usage, complaints, returns, other
sentiment must be one of: positive, neutral, negative
is_english: true if language is English, false otherwise`;

  const raw = await callGroq('You are a JSON-only responder. Never add explanation.', prompt, 200);
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function generateRagAnswer(question, kbContext, productInfo) {
  const systemPrompt = `You are a Hisense customer support specialist. Answer customer questions using the provided knowledge base context. Be concise, accurate, and helpful. Always end with a confidence score.`;

  const userPrompt = `Product Information:
${productInfo || 'No product info available'}

Knowledge Base Context:
${kbContext || 'No relevant context found'}

Customer Question: ${question}

Provide a helpful answer. Then on the last line write exactly:
CONFIDENCE: [number between 0 and 100]`;

  const raw = await callGroq(systemPrompt, userPrompt, 600);

  const confidenceMatch = raw.match(/CONFIDENCE:\s*(\d+)/i);
  const confidence = confidenceMatch ? parseInt(confidenceMatch[1]) : 50;
  const answer = raw.replace(/CONFIDENCE:\s*\d+/i, '').trim();

  return { answer, confidence };
}

module.exports = { callGroq, enrichQuestion, generateRagAnswer };
