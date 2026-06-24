const supabase = require('../utils/supabase');
const { enrichQuestion } = require('./groq');
const { answerQuestion } = require('./rag');

async function autoAssignAgent(question, category) {
  const { data: agents } = await supabase
    .from('agents')
    .select('*')
    .eq('is_active', true)
    .eq('role', 'agent')
    .contains('skills', [category]);

  if (!agents || agents.length === 0) return null;

  // Simple round-robin: pick agent with fewest assigned open questions
  const counts = await Promise.all(
    agents.map(async (agent) => {
      const { count } = await supabase
        .from('questions')
        .select('*', { count: 'exact', head: true })
        .eq('assigned_to', agent.name)
        .in('status', ['pending', 'review']);
      return { agent, count: count || 0 };
    })
  );

  counts.sort((a, b) => a.count - b.count);
  return counts[0].agent.name;
}

async function processQuestion(questionId) {
  const { data: question, error } = await supabase
    .from('questions')
    .select('*')
    .eq('id', questionId)
    .single();

  if (error || !question) return;

  try {
    // Step 1: Enrich with Groq
    const enrichment = await enrichQuestion(question.question_text);

    // Step 2: Auto-assign agent
    const assignedTo = await autoAssignAgent(question, enrichment.category);

    // Step 3: RAG answer
    const { answer, confidence } = await answerQuestion(question);

    const now = new Date().toISOString();
    const isAutoApproved = confidence >= 70 && enrichment.is_english;

    await supabase
      .from('questions')
      .update({
        language: enrichment.language,
        category: enrichment.category,
        sentiment: enrichment.sentiment,
        assigned_to: assignedTo,
        ai_answer: answer,
        confidence: confidence,
        status: isAutoApproved ? 'answered' : 'review',
        review_reason: !enrichment.is_english
          ? 'Non-English question — requires human review'
          : confidence < 70
          ? `Low confidence (${confidence}%) — requires human review`
          : null,
        date_answered: isAutoApproved ? now : null,
        processed_at: now
      })
      .eq('id', questionId);

    // If auto-approved, add to KB
    if (isAutoApproved) {
      await addApprovedAnswerToKB(question, answer, enrichment.category);
    }

    return { success: true, auto_approved: isAutoApproved };
  } catch (err) {
    console.error(`Enrichment failed for question ${questionId}:`, err.message);
    await supabase
      .from('questions')
      .update({ status: 'review', review_reason: `Processing error: ${err.message}` })
      .eq('id', questionId);
    return { success: false, error: err.message };
  }
}

async function addApprovedAnswerToKB(question, answer, category) {
  const { generateEmbedding } = require('./embedding');
  const content = `Q: ${question.question_text}\nA: ${answer}`;
  let embedding = null;

  try {
    embedding = await generateEmbedding(content);
  } catch (e) {
    console.error('Embedding failed for KB entry:', e.message);
  }

  await supabase.from('knowledge_base').insert({
    title: question.question_text.slice(0, 100),
    content,
    category: category || 'other',
    source: 'approved_answer',
    embedding,
    created_at: new Date().toISOString()
  });
}

module.exports = { processQuestion, addApprovedAnswerToKB };
