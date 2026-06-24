const axios = require('axios');

const HF_URL = 'https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2';

async function generateEmbedding(text) {
  if (!process.env.HF_API_KEY) throw new Error('HF_API_KEY not configured');
  if (!text || !text.trim()) throw new Error('Text is required for embedding');

  const cleanText = text.replace(/\s+/g, ' ').trim().slice(0, 512);

  try {
    const response = await axios.post(
      HF_URL,
      { inputs: cleanText, options: { wait_for_model: true } },
      { headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` }, timeout: 30000 }
    );

    const embedding = response.data;
    if (!Array.isArray(embedding)) throw new Error(`Unexpected embedding format: ${typeof embedding}`);
    if (embedding.length !== 384) throw new Error(`Wrong embedding dimensions: got ${embedding.length}, expected 384`);
    return embedding;
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error || err.message;
    if (status === 401) throw new Error('HuggingFace API key is invalid or expired.');
    if (status === 503) throw new Error('HuggingFace model is loading. Try again in 20 seconds.');
    if (status === 429) throw new Error('HuggingFace rate limit reached.');
    throw new Error(`Embedding error: ${msg}`);
  }
}

module.exports = { generateEmbedding };
