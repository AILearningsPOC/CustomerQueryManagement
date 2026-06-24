const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const { scrapeAll, scrapeTarget } = require('../services/scraper');
const { processQuestion } = require('../services/enrichment');
const { restartScheduler } = require('../services/scheduler');

// POST /api/scrape/now — manual scrape all
router.post('/now', async (req, res) => {
  try {
    const { data: config } = await supabase.from('config').select('value').eq('key', 'scraping_config').single();
    const engine = config?.value?.engine || process.env.SCRAPING_ENGINE || 'scraperapi';

    const result = await scrapeAll(engine);

    // Process new pending questions
    const { data: pending } = await supabase
      .from('questions').select('id').eq('status', 'pending').is('processed_at', null).limit(50);

    let processed = 0;
    if (pending?.length) {
      for (const q of pending) { await processQuestion(q.id); processed++; }
    }

    res.json({ ...result, processed_questions: processed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scrape/target/:id — scrape single target
router.post('/target/:id', async (req, res) => {
  try {
    const { data: target } = await supabase.from('scrape_targets').select('*').eq('id', req.params.id).single();
    if (!target) return res.status(404).json({ error: 'Target not found' });

    const { data: config } = await supabase.from('config').select('value').eq('key', 'scraping_config').single();
    const engine = config?.value?.engine || 'scraperapi';

    const log = await scrapeTarget(target, engine);
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scrape/logs — recent scrape logs
router.get('/logs', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const { data, error } = await supabase
    .from('scrape_logs')
    .select('*')
    .order('scraped_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/scrape/config — update scraping config + restart scheduler
router.post('/config', async (req, res) => {
  try {
    const { auto_enabled, interval_minutes, engine } = req.body;

    await supabase.from('config').upsert({
      key: 'scraping_config',
      value: { auto_enabled, interval_minutes, engine }
    }, { onConflict: 'key' });

    await restartScheduler();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
