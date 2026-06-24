const axios = require('axios');
const supabase = require('../utils/supabase');
const crypto = require('crypto');

// ── SCRAPERAPI ENGINE ──────────────────────────────────────────────

async function scrapeWithScraperAPI(url) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) throw new Error('SCRAPERAPI_KEY not configured');

  const apiUrl = `http://api.scraperapi.com?api_key=${key}&url=${encodeURIComponent(url)}&render=true`;
  const response = await axios.get(apiUrl, { timeout: 60000 });
  return response.data;
}

function parseQAFromHTML(html, retailer) {
  const questions = [];

  if (retailer === 'bestbuy') {
    // BestBuy Q&A pattern
    const qaBlocks = html.match(/<div[^>]*class="[^"]*ugc-question[^"]*"[^>]*>([\s\S]*?)<\/div>/gi) || [];
    for (const block of qaBlocks) {
      const qMatch = block.match(/class="[^"]*question-text[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
      const aMatch = block.match(/class="[^"]*answer-text[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
      const dateMatch = block.match(/class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
      const nameMatch = block.match(/class="[^"]*author[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);

      if (qMatch) {
        questions.push({
          question_text: stripTags(qMatch[1]).trim(),
          existing_answer: aMatch ? stripTags(aMatch[1]).trim() : null,
          date_asked: dateMatch ? parseDate(stripTags(dateMatch[1])) : null,
          customer_name: nameMatch ? stripTags(nameMatch[1]).trim() : null,
          answer_status: aMatch ? 'answered' : 'unanswered'
        });
      }
    }
  } else if (retailer === 'amazon') {
    // Amazon Q&A pattern
    const qaBlocks = html.match(/<div[^>]*id="[^"]*question[^"]*"[^>]*>([\s\S]*?)<\/div>/gi) || [];
    for (const block of qaBlocks) {
      const qMatch = block.match(/class="[^"]*a-size-base[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const aMatch = block.match(/class="[^"]*askAnswer[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const dateMatch = block.match(/class="[^"]*a-color-tertiary[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

      if (qMatch) {
        questions.push({
          question_text: stripTags(qMatch[1]).trim(),
          existing_answer: aMatch ? stripTags(aMatch[1]).trim() : null,
          date_asked: dateMatch ? parseDate(stripTags(dateMatch[1])) : null,
          customer_name: null,
          answer_status: aMatch ? 'answered' : 'unanswered'
        });
      }
    }
  }

  return questions.filter(q => q.question_text && q.question_text.length > 5);
}

// ── APIFY ENGINE ───────────────────────────────────────────────────

async function scrapeWithApify(url, retailer) {
  const key = process.env.APIFY_API_KEY;
  if (!key) throw new Error('APIFY_API_KEY not configured');

  // Use appropriate Apify actor
  const actorId = retailer === 'amazon'
    ? 'junglee/amazon-product-scraper'
    : 'drobnikj/bestbuy-products-scraper';

  // Start actor run
  const startRes = await axios.post(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${key}`,
    { startUrls: [{ url }], maxItems: 50 },
    { timeout: 30000 }
  );

  const runId = startRes.data.data.id;

  // Poll for completion (max 3 min)
  for (let i = 0; i < 18; i++) {
    await sleep(10000);
    const statusRes = await axios.get(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${key}`
    );
    if (statusRes.data.data.status === 'SUCCEEDED') break;
    if (statusRes.data.data.status === 'FAILED') throw new Error('Apify run failed');
  }

  // Fetch results
  const datasetRes = await axios.get(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${key}`
  );

  return normalizeApifyResults(datasetRes.data, retailer);
}

function normalizeApifyResults(items, retailer) {
  return items
    .filter(item => item.question || item.questionText)
    .map(item => ({
      question_text: item.question || item.questionText || '',
      existing_answer: item.answer || item.answerText || null,
      date_asked: item.date || item.datePosted || null,
      customer_name: item.author || item.userName || null,
      answer_status: (item.answer || item.answerText) ? 'answered' : 'unanswered'
    }))
    .filter(q => q.question_text && q.question_text.length > 5);
}

// ── MAIN SCRAPE FUNCTION ───────────────────────────────────────────

async function scrapeTarget(target, engine) {
  const log = {
    target_id: target.id,
    retailer: target.retailer,
    product_name: target.product_name,
    url: target.url,
    engine_used: engine,
    scraped_at: new Date().toISOString(),
    found_count: 0,
    new_count: 0,
    error: null
  };

  try {
    let rawQuestions = [];

    if (engine === 'apify') {
      rawQuestions = await scrapeWithApify(target.url, target.retailer);
    } else {
      const html = await scrapeWithScraperAPI(target.url);
      rawQuestions = parseQAFromHTML(html, target.retailer);
    }

    log.found_count = rawQuestions.length;

    // Deduplicate + insert
    let newCount = 0;
    for (const q of rawQuestions) {
      const hash = crypto.createHash('md5').update(q.question_text.toLowerCase()).digest('hex');

      const { data: existing } = await supabase
        .from('questions')
        .select('id')
        .eq('content_hash', hash)
        .single();

      if (existing) continue;

      await supabase.from('questions').insert({
        question_text: q.question_text,
        existing_answer: q.existing_answer,
        date_asked: q.date_asked,
        customer_name: q.customer_name,
        answer_status: q.answer_status || 'unanswered',
        retailer: target.retailer,
        product_name: target.product_name,
        product_url: target.url,
        content_hash: hash,
        status: 'pending',
        source: 'scraper'
      });
      newCount++;
    }

    log.new_count = newCount;

    // Update last_scraped_at
    await supabase
      .from('scrape_targets')
      .update({
        last_scraped_at: new Date().toISOString(),
        questions_found_total: (target.questions_found_total || 0) + newCount
      })
      .eq('id', target.id);

  } catch (err) {
    log.error = err.message;
    console.error(`Scrape error [${target.retailer}/${target.product_name}]:`, err.message);
  }

  // Save scrape log
  await supabase.from('scrape_logs').insert(log);
  return log;
}

async function scrapeAll(engine) {
  const { data: targets } = await supabase
    .from('scrape_targets')
    .select('*')
    .eq('is_active', true);

  if (!targets || targets.length === 0) return { message: 'No active scrape targets', logs: [] };

  const logs = [];
  for (const target of targets) {
    const log = await scrapeTarget(target, engine);
    logs.push(log);
  }

  return { scraped: targets.length, logs };
}

// ── HELPERS ────────────────────────────────────────────────────────

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseDate(str) {
  try { return new Date(str).toISOString(); } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrapeAll, scrapeTarget };
