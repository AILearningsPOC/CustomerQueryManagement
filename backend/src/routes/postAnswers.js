const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET post-answers config
router.get('/config', async (req, res) => {
  const { data } = await supabase.from('config').select('value').eq('key', 'posting_enabled').single();
  res.json({ posting_enabled: data?.value === true });
});

// POST toggle posting on/off
router.post('/toggle', async (req, res) => {
  const { enabled } = req.body;
  await supabase.from('config').upsert({ key: 'posting_enabled', value: enabled }, { onConflict: 'key' });
  res.json({ posting_enabled: enabled });
});

// POST post a single answer back to retailer
router.post('/:id', async (req, res) => {
  const { data: config } = await supabase.from('config').select('value').eq('key', 'posting_enabled').single();
  if (config?.value !== true) {
    return res.status(403).json({ error: 'Posting to retailer sites is currently disabled. Enable it in Configuration.' });
  }

  const { data: question } = await supabase.from('questions').select('*').eq('id', req.params.id).single();
  if (!question) return res.status(404).json({ error: 'Question not found' });
  if (question.status !== 'answered') return res.status(400).json({ error: 'Question must be answered before posting' });

  // TODO: Implement actual posting via ScraperAPI / Apify automation
  // For now: mark as posted and log
  await supabase.from('questions').update({
    posted_to_retailer: true,
    posted_at: new Date().toISOString()
  }).eq('id', req.params.id);

  res.json({ success: true, message: 'Marked as posted (automation not yet implemented for PoC)' });
});

module.exports = router;
