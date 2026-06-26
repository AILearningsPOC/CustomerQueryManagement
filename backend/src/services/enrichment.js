const supabase = require('../utils/supabase');
const { enrichQuestion } = require('./groq');
const { answerQuestion } = require('./rag');

async function autoAssignAgent(category) {
  try {
    const { data: agents, error } = await supabase
      .from('agents').select('*').eq('is_active', true).eq('role', 'agent').contains('skills', [category]);

    if (error) { console.error('[autoAssign] DB error:', error.message); return null; }
    if (!agents || agents.length === 0) return null;

    const counts = await Promise.all(agents.map(async (agent) => {
      try {
        const { count } = await supabase.from('questions')
          .select('*', { count: 'exact', head: true })
          .eq('assigned_to', agent.name).in('status', ['pending', 'review']);
        return { agent, count: count || 0 };
      } catch { return { agent, count: 0 }; }
    }));

    counts.sort((a, b) => a.count - b.count);
    return counts[0].agent.name;
  } catch (err) {
    console.error('[autoAssignAgent] Error:', err.message);
    return null;
  }
}

async function processQuestion(questionId) {
  let question;
  try {
    const { data, error } = await supabase.from('questions').select('*').eq('id', questionId).single();
    if (error || !data) {
      console.error(`[processQuestion] Question ${questionId} not found:`, error?.message);
      return { success: false, error: 'Question not found' };
    }
    question = data;
  } catch (err) {
    console.error(`[processQuestion] Fetch error for ${questionId}:`, err.message);
    return { success: false, error: err.message };
  }

  // Step 1: Enrich with Groq
  let enrichment = { language: 'English', category: 'other', sentiment: 'neutral', is_english: true };
  try {
    enrichment = await enrichQuestion(question.question_text);
  } catch (err) {
    console.error(`[processQuestion] Enrichment failed for ${questionId}:`, err.message);
    // Continue with defaults rather than failing entirely
  }

  // Step 2: Auto-assign agent
  let assignedTo = null;
  try {
    assignedTo = await autoAssignAgent(enrichment.category);
  } catch (err) {
    console.error(`[processQuestion] Agent assignment failed for ${questionId}:`, err.message);
  }

  // Step 3: RAG answer
  let answer = null;
  let confidence = 0;
  try {
    const result = await answerQuestion(question);
    answer = result.answer;
    confidence = result.confidence;
  } catch (err) {
    console.error(`[processQuestion] RAG failed for ${questionId}:`, err.message);
    // Route to review if RAG fails
    await supabase.from('questions').update({
      language: enrichment.language,
      category: enrichment.category,
      sentiment: enrichment.sentiment,
      assigned_to: assignedTo,
      status: 'review',
      review_reason: `AI answer generation failed: ${err.message}`,
      processed_at: new Date().toISOString()
    }).eq('id', questionId);
    return { success: false, error: err.message };
  }

  // Step 4: Decide auto-approve or review
  const now = new Date().toISOString();
  const isAutoApproved = confidence >= 70 && enrichment.is_english;

  try {
    await supabase.from('questions').update({
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
    }).eq('id', questionId);
  } catch (err) {
    console.error(`[processQuestion] DB update failed for ${questionId}:`, err.message);
    return { success: false, error: err.message };
  }

  // Step 5: Add to KB if auto-approved
  if (isAutoApproved) {
    try {
      await addApprovedAnswerToKB(question, answer, enrichment.category);
    } catch (err) {
      console.error(`[processQuestion] KB add failed for ${questionId} (non-fatal):`, err.message);
    }
  }

  return { success: true, auto_approved: isAutoApproved };
}

async function addApprovedAnswerToKB(question, answer, category) {
  const { generateEmbedding } = require('./embedding');
  const content = `Q: ${question.question_text}\nA: ${answer}`;
  let embedding = null;

  try {
    embedding = await generateEmbedding(content);
  } catch (e) {
    console.error('[addApprovedAnswerToKB] Embedding failed (non-fatal):', e.message);
  }

  const { error } = await supabase.from('knowledge_base').insert({
    title: question.question_text.slice(0, 100),
    content,
    category: category || 'other',
    source: 'approved_answer',
    embedding,
    created_at: new Date().toISOString()
  });

  if (error) console.error('[addApprovedAnswerToKB] DB insert failed:', error.message);
}

module.exports = { processQuestion, addApprovedAnswerToKB };
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.3.202606261143
