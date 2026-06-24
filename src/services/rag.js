const supabase = require('../utils/supabase');
const { generateEmbedding } = require('./embedding');
const { generateRagAnswer } = require('./groq');

async function searchKB(questionText, topK = 5) {
  try {
    const embedding = await generateEmbedding(questionText);

    const { data, error } = await supabase.rpc('search_kb_vector', {
      query_embedding: embedding,
      match_count: topK
    });

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Vector search error:', err.message);
    // Fallback: keyword search
    const { data } = await supabase
      .from('knowledge_base')
      .select('content, category, title')
      .textSearch('content', questionText.split(' ').slice(0, 3).join(' | '))
      .limit(topK);
    return data || [];
  }
}

async function answerQuestion(question) {
  const kbResults = await searchKB(question.question_text);
  const kbContext = kbResults.map((r, i) => `[${i + 1}] ${r.title || r.category}: ${r.content}`).join('\n\n');

  const productInfo = [
    question.product_name && `Product: ${question.product_name}`,
    question.retailer && `Retailer: ${question.retailer}`
  ].filter(Boolean).join('\n');

  const { answer, confidence } = await generateRagAnswer(question.question_text, kbContext, productInfo);

  return { answer, confidence };
}

module.exports = { searchKB, answerQuestion };
