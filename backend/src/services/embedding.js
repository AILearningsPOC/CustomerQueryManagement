const axios = require('axios');

const HF_URL = 'https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2';

async function generateEmbedding(text) {
  if (!process.env.HF_API_KEY) throw new Error('HF_API_KEY not configured');

  const cleanText = text.replace(/\s+/g, ' ').trim().slice(0, 512);

  const response = await axios.post(
    HF_URL,
    { inputs: cleanText, options: { wait_for_model: true } },
    { headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` } }
  );

  const embedding = response.data;
  if (!Array.isArray(embedding) || embedding.length !== 384) {
    throw new Error(`Unexpected embedding shape: ${JSON.stringify(embedding).slice(0, 100)}`);
  }
  return embedding;
}

module.exports = { generateEmbedding };
