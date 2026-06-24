const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

router.get('/', async (req, res) => {
  try {
    const [
      { count: questions },
      { count: answered },
      { count: review },
      { count: kb_entries },
      { count: scrape_targets }
    ] = await Promise.all([
      supabase.from('questions').select('*', { count: 'exact', head: true }),
      supabase.from('questions').select('*', { count: 'exact', head: true }).eq('status', 'answered'),
      supabase.from('questions').select('*', { count: 'exact', head: true }).eq('status', 'review'),
      supabase.from('knowledge_base').select('*', { count: 'exact', head: true }),
      supabase.from('scrape_targets').select('*', { count: 'exact', head: true })
    ]);

    res.json({
      status: 'ok',
      version: '2.0.0',
      db_connected: true,
      ai_configured: !!process.env.GROQ_API_KEY,
      hf_configured: !!process.env.HF_API_KEY,
      scraperapi_configured: !!process.env.SCRAPERAPI_KEY,
      apify_configured: !!process.env.APIFY_API_KEY,
      counts: { questions, answered, review, kb_entries, scrape_targets }
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, db_connected: false });
  }
});

module.exports = router;
