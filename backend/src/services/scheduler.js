const cron = require('node-cron');
const supabase = require('../utils/supabase');
const { scrapeAll } = require('./scraper');
const { processQuestion } = require('./enrichment');

let scrapeJob = null;

async function getConfig() {
  const { data } = await supabase
    .from('config')
    .select('value')
    .eq('key', 'scraping_config')
    .single();
  return data?.value || { auto_enabled: true, interval_minutes: 10, engine: 'scraperapi' };
}

async function runScrapeAndEnrich() {
  const config = await getConfig();
  if (!config.auto_enabled) return;

  console.log(`[Scheduler] Running scrape with engine: ${config.engine}`);
  const result = await scrapeAll(config.engine);
  console.log(`[Scheduler] Scraped ${result.scraped || 0} targets, found ${result.logs?.reduce((s, l) => s + l.new_count, 0) || 0} new questions`);

  // Process pending questions
  const { data: pending } = await supabase
    .from('questions')
    .select('id')
    .eq('status', 'pending')
    .is('processed_at', null)
    .limit(20);

  if (pending && pending.length > 0) {
    console.log(`[Scheduler] Processing ${pending.length} pending questions`);
    for (const q of pending) {
      await processQuestion(q.id);
    }
  }
}

async function startScheduler() {
  const config = await getConfig();
  const interval = Math.max(config.interval_minutes || 10, 5);

  if (scrapeJob) scrapeJob.stop();

  scrapeJob = cron.schedule(`*/${interval} * * * *`, runScrapeAndEnrich);
  console.log(`[Scheduler] Started — every ${interval} minutes`);
}

async function restartScheduler() {
  await startScheduler();
}

// Start on boot
startScheduler().catch(console.error);

// Also process any pending questions on startup
setTimeout(async () => {
  const { data: pending } = await supabase
    .from('questions')
    .select('id')
    .eq('status', 'pending')
    .is('processed_at', null)
    .limit(20);

  if (pending && pending.length > 0) {
    console.log(`[Startup] Processing ${pending.length} pending questions`);
    for (const q of pending) {
      await processQuestion(q.id);
    }
  }
}, 5000);

module.exports = { restartScheduler, runScrapeAndEnrich };
