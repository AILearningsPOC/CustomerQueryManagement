const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

router.get('/', async (req, res) => {
  try {
    const [{ count: questions }, { count: kb }, { count: review }, { count: targets }] = await Promise.all([
      supabase.from('questions').select('*', { count: 'exact', head: true }),
      supabase.from('knowledge_base').select('*', { count: 'exact', head: true }),
      supabase.from('questions').select('*', { count: 'exact', head: true }).eq('status', 'review'),
      supabase.from('scrape_targets').select('*', { count: 'exact', head: true })
    ]);
    res.json({
      status: 'ok', version: '2.4.0', db_connected: true,
      ai_configured: !!process.env.GROQ_API_KEY,
      hf_configured: !!process.env.HF_API_KEY,
      scraperapi_configured: !!process.env.SCRAPERAPI_KEY,
      apify_configured: !!process.env.APIFY_API_KEY,
      counts: { questions: questions || 0, answered: 0, review: review || 0, kb_entries: kb || 0, scrape_targets: targets || 0 }
    });
  } catch (err) {
    res.json({ status: 'ok', version: '2.4.0', db_connected: false, error: err.message });
  }
});

module.exports = router;
// BUILD: v2.5.20260628210502
