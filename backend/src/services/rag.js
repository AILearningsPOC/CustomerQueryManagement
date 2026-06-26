const supabase = require('../utils/supabase');
const { generateEmbedding } = require('./embedding');
const { generateRagAnswer } = require('./groq');

async function searchKB(questionText, topK = 5) {
  // Try vector search first
  try {
    const embedding = await generateEmbedding(questionText);
    const { data, error } = await supabase.rpc('search_kb_vector', {
      query_embedding: embedding,
      match_count: topK
    });
    if (error) throw new Error(`pgvector search failed: ${error.message}`);
    if (data && data.length > 0) return data;
    // Fall through to keyword search if no vector results
  } catch (err) {
    console.warn('[searchKB] Vector search failed, trying keyword fallback:', err.message);
  }

  // Keyword fallback
  try {
    const keywords = questionText.split(' ').filter(w => w.length > 3).slice(0, 3).join(' | ');
    if (!keywords) return [];
    const { data, error } = await supabase
      .from('knowledge_base')
      .select('content, category, title')
      .textSearch('content', keywords)
      .limit(topK);
    if (error) throw new Error(`Keyword search failed: ${error.message}`);
    return data || [];
  } catch (err) {
    console.warn('[searchKB] Keyword fallback also failed:', err.message);
    return []; // Return empty — RAG will answer without context
  }
}

async function answerQuestion(question) {
  let kbResults = [];
  try {
    kbResults = await searchKB(question.question_text);
  } catch (err) {
    console.warn('[answerQuestion] KB search failed, answering without context:', err.message);
  }

  const kbContext = kbResults.length > 0
    ? kbResults.map((r, i) => `[${i + 1}] ${r.title || r.category}: ${r.content}`).join('\n\n')
    : 'No relevant context found in knowledge base.';

  const productInfo = [
    question.product_name && `Product: ${question.product_name}`,
    question.retailer && `Retailer: ${question.retailer}`
  ].filter(Boolean).join('\n') || 'No product info available';

  const { answer, confidence } = await generateRagAnswer(question.question_text, kbContext, productInfo);
  return { answer, confidence };
}

module.exports = { searchKB, answerQuestion };
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.1.202606261112
