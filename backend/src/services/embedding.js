const axios = require('axios');

// Primary: HuggingFace inference API
const HF_URL = 'https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2';

// Fallback: HuggingFace dedicated inference endpoint (more reliable)
const HF_URL_ALT = 'https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2';

async function generateEmbedding(text) {
  if (!process.env.HF_API_KEY) throw new Error('HF_API_KEY not configured');
  if (!text || !text.trim()) throw new Error('Text is required for embedding');

  const cleanText = text.replace(/\s+/g, ' ').trim().slice(0, 512);

  // Try primary endpoint first
  for (const url of [HF_URL, HF_URL_ALT]) {
    try {
      const response = await axios.post(
        url,
        { inputs: cleanText, options: { wait_for_model: true, use_cache: true } },
        {
          headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` },
          timeout: 60000  // 60s - model may need to load
        }
      );

      const raw = response.data;

      // HF returns different shapes depending on endpoint
      // pipeline/feature-extraction returns flat array [384]
      // models endpoint returns [[384]] nested
      let embedding = raw;
      if (Array.isArray(raw) && Array.isArray(raw[0])) {
        embedding = raw[0]; // unwrap nested array
      }
      if (Array.isArray(embedding) && Array.isArray(embedding[0])) {
        embedding = embedding[0]; // unwrap double-nested
      }

      if (!Array.isArray(embedding)) {
        throw new Error(`Unexpected embedding format: ${typeof embedding}`);
      }

      if (embedding.length !== 384) {
        throw new Error(`Wrong dimensions: got ${embedding.length}, expected 384`);
      }

      return embedding;
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.error || err.message;

      if (status === 401) throw new Error('HuggingFace API key is invalid or expired.');
      if (status === 429) {
        console.warn('[embedding] Rate limited, waiting 10s...');
        await sleep(10000);
        continue;
      }
      if (status === 503) {
        console.warn(`[embedding] Model loading (503), retrying in 20s... url: ${url}`);
        await sleep(20000);
        continue;
      }
      console.warn(`[embedding] Failed on ${url}: ${msg}`);
      // Try next URL
    }
  }

  throw new Error('HuggingFace embedding failed on all endpoints. Check HF_API_KEY and model availability.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { generateEmbedding };
// BUILD: v2.3.202606261143
