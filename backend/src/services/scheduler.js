const cron = require('node-cron');
const supabase = require('../utils/supabase');
const { scrapeAll } = require('./scraper');
const { processQuestion } = require('./enrichment');

let scrapeJob = null;

async function getConfig() {
  try {
    const { data } = await supabase.from('config').select('value').eq('key', 'scraping_config').single();
    return data?.value || { auto_enabled: true, interval_minutes: 10, engine: 'scraperapi' };
  } catch (err) {
    console.warn('[scheduler] getConfig failed, using defaults:', err.message);
    return { auto_enabled: true, interval_minutes: 10, engine: 'scraperapi' };
  }
}

async function runScrapeAndEnrich() {
  try {
    const config = await getConfig();
    if (!config.auto_enabled) return;

    console.log(`[Scheduler] Running scrape with engine: ${config.engine}`);

    let result;
    try {
      result = await scrapeAll(config.engine);
      const newCount = result.logs?.reduce((s, l) => s + (l.new_count || 0), 0) || 0;
      console.log(`[Scheduler] Scraped ${result.scraped || 0} targets, ${newCount} new questions`);
    } catch (scrapeErr) {
      console.error('[Scheduler] Scrape failed:', scrapeErr.message);
      return;
    }

    // Process pending questions
    try {
      const { data: pending } = await supabase
        .from('questions').select('id').eq('status', 'pending').is('processed_at', null).limit(20);

      if (pending && pending.length > 0) {
        console.log(`[Scheduler] Processing ${pending.length} pending questions`);
        for (const q of pending) {
          try {
            await processQuestion(q.id);
          } catch (pErr) {
            console.error(`[Scheduler] processQuestion failed for ${q.id}:`, pErr.message);
          }
        }
      }
    } catch (processErr) {
      console.error('[Scheduler] Processing step failed:', processErr.message);
    }
  } catch (err) {
    console.error('[Scheduler] runScrapeAndEnrich top-level error:', err.message);
  }
}

async function startScheduler() {
  try {
    const config = await getConfig();
    const interval = Math.max(config.interval_minutes || 10, 5);

    if (scrapeJob) {
      try { scrapeJob.stop(); } catch (e) {}
    }

    scrapeJob = cron.schedule(`*/${interval} * * * *`, () => {
      runScrapeAndEnrich().catch(err => console.error('[Scheduler] Cron job error:', err.message));
    });

    console.log(`[Scheduler] Started — every ${interval} minutes`);
  } catch (err) {
    console.error('[Scheduler] startScheduler failed:', err.message);
  }
}

async function restartScheduler() {
  await startScheduler();
}

// Start on boot
startScheduler().catch(err => console.error('[Scheduler] Boot start failed:', err.message));

// Process pending questions on startup (5s delay)
setTimeout(async () => {
  try {
    const { data: pending } = await supabase
      .from('questions').select('id').eq('status', 'pending').is('processed_at', null).limit(20);

    if (pending && pending.length > 0) {
      console.log(`[Startup] Processing ${pending.length} pending questions`);
      for (const q of pending) {
        try {
          await processQuestion(q.id);
        } catch (err) {
          console.error(`[Startup] processQuestion failed for ${q.id}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[Startup] Pending question processing failed:', err.message);
  }
}, 5000);

module.exports = { restartScheduler, runScrapeAndEnrich };
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.1.202606261112
