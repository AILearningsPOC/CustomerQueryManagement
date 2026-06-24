const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { processQuestion } = require('../services/enrichment');

// GET /api/questions
router.get('/', async (req, res) => {
  const { status, retailer, category, sentiment, assigned_to, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase.from('questions').select('*', { count: 'exact' });
  if (status)      query = query.eq('status', status);
  if (retailer)    query = query.eq('retailer', retailer);
  if (category)    query = query.eq('category', category);
  if (sentiment)   query = query.eq('sentiment', sentiment);
  if (assigned_to) query = query.eq('assigned_to', assigned_to);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// GET /api/questions/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('questions').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// POST /api/questions — manual add
router.post('/', async (req, res) => {
  try {
    const { question_text, retailer, product_name, product_url, customer_name } = req.body;
    if (!question_text) return res.status(400).json({ error: 'question_text required' });

    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(question_text.toLowerCase()).digest('hex');

    const { data: existing } = await supabase.from('questions').select('id').eq('content_hash', hash).single();
    if (existing) return res.status(409).json({ error: 'Duplicate question', id: existing.id });

    const { data, error } = await supabase.from('questions').insert({
      question_text, retailer, product_name, product_url, customer_name,
      content_hash: hash, status: 'pending', source: 'manual',
      created_at: new Date().toISOString()
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });

    // Process async
    processQuestion(data.id).catch(console.error);
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/questions/:id/approve
router.patch('/:id/approve', async (req, res) => {
  const { answer, add_to_kb } = req.body;
  const now = new Date().toISOString();

  const { data: question } = await supabase.from('questions').select('*').eq('id', req.params.id).single();
  if (!question) return res.status(404).json({ error: 'Not found' });

  const finalAnswer = answer || question.ai_answer;

  const { data, error } = await supabase.from('questions').update({
    ai_answer: finalAnswer,
    status: 'answered',
    date_answered: now,
    review_reason: null
  }).eq('id', req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });

  if (add_to_kb) {
    const { addApprovedAnswerToKB } = require('../services/enrichment');
    await addApprovedAnswerToKB(question, finalAnswer, question.category);
  }

  res.json(data);
});

// PATCH /api/questions/:id/assign
router.patch('/:id/assign', async (req, res) => {
  const { assigned_to } = req.body;
  const { data, error } = await supabase
    .from('questions').update({ assigned_to }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/questions/:id/draft
router.patch('/:id/draft', async (req, res) => {
  const { answer } = req.body;
  const { data, error } = await supabase
    .from('questions').update({ ai_answer: answer }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/questions/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('questions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/questions/export/csv
router.get('/export/csv', async (req, res) => {
  const { data } = await supabase.from('questions').select('*').order('created_at', { ascending: false });
  if (!data) return res.status(500).json({ error: 'No data' });

  const XLSX = require('xlsx');
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Questions');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename="cqm_questions_export.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
