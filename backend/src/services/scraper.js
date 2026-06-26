const axios = require('axios');
const supabase = require('../utils/supabase');
const crypto = require('crypto');

// ── SCRAPERAPI PROXY ───────────────────────────────────────────────
// Used to proxy requests through ScraperAPI's rotating IP pool
async function proxyRequest(targetUrl, asJson = false) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) throw new Error('SCRAPERAPI_KEY not configured');

  const params = new URLSearchParams({
    api_key: key,
    url: targetUrl,
    country_code: 'us',
    keep_headers: 'true'
  });
  // Only use render=true for HTML pages (costs more credits)
  // For JSON API endpoints, no render needed
  if (!asJson) params.append('render', 'true');

  const response = await axios.get(`http://api.scraperapi.com?${params.toString()}`, {
    timeout: 60000,
    headers: {
      'Accept': asJson ? 'application/json' : 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    },
    decompress: true
  });
  return response.data;
}

// ── BESTBUY SCRAPER ────────────────────────────────────────────────
// Uses BestBuy's internal UGC JSON API — much more reliable than HTML scraping
async function scrapeBestBuy(url) {
  // Extract SKU from URL: /site/questions/product-name/6621482 -> 6621482
  const skuMatch = url.match(/\/(\d{7,8})(?:\/|$|\?|#)/);
  if (!skuMatch) throw new Error(`Cannot extract SKU from BestBuy URL: ${url}`);
  const sku = skuMatch[1];

  const bbApiUrl = `https://www.bestbuy.com/ugc/v2/questions?page=1&pageSize=30&sku=${sku}&sort=MOST_RECENT&source=pr`;
  console.log(`[BestBuy] Fetching Q&A for SKU ${sku} via ScraperAPI`);

  let data;
  try {
    // Try direct JSON API first (no render needed = cheaper & faster)
    data = await proxyRequest(bbApiUrl, true);
    if (typeof data === 'string') data = JSON.parse(data);
  } catch (err) {
    console.warn(`[BestBuy] JSON API failed: ${err.message}, trying HTML fallback`);
    // Fall back to rendering the Q&A page
    const html = await proxyRequest(url, false);
    return parseBestBuyHTML(html);
  }

  const questions = data?.questions || data?.topics || [];
  console.log(`[BestBuy] Found ${questions.length} questions for SKU ${sku}`);

  return questions.map(q => ({
    question_text: (q.questionText || q.question || '').trim(),
    existing_answer: q.answers?.[0]?.answerText || null,
    answer_status: (q.answers?.length > 0) ? 'answered' : 'unanswered',
    date_asked: q.submissionTime ? new Date(q.submissionTime).toISOString() : null,
    customer_name: q.userNickname || q.authorId || null
  })).filter(q => q.question_text.length > 5);
}

// HTML fallback parser for BestBuy
function parseBestBuyHTML(html) {
  const questions = [];
  if (!html || html.length < 100) return questions;

  // Try __NEXT_DATA__ JSON
  try {
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) {
      const found = extractQAFromJSON(JSON.parse(m[1]));
      if (found.length > 0) return found;
    }
  } catch (e) {}

  // Try embedded questionText JSON
  const qMatches = [...html.matchAll(/"questionText"\s*:\s*"([^"]{10,500})"/g)];
  const aMatches = [...html.matchAll(/"answerText"\s*:\s*"([^"]{5,500})"/g)];
  if (qMatches.length > 0) {
    return qMatches.map((m, i) => ({
      question_text: decodeStr(m[1]),
      existing_answer: aMatches[i] ? decodeStr(aMatches[i][1]) : null,
      answer_status: aMatches[i] ? 'answered' : 'unanswered',
      date_asked: null, customer_name: null
    })).filter(q => q.question_text.length > 5);
  }

  return questions;
}

// ── AMAZON SCRAPER ─────────────────────────────────────────────────
// Amazon Q&A page: /ask/questions/asin/{ASIN}
async function scrapeAmazon(url) {
  // Extract ASIN
  const asinMatch = url.match(/\/(?:dp|asin|ask\/questions\/asin)\/([A-Z0-9]{10})/);
  if (!asinMatch) throw new Error(`Cannot extract ASIN from Amazon URL: ${url}`);
  const asin = asinMatch[1];

  const amazonQAUrl = `https://www.amazon.com/ask/questions/asin/${asin}/1?isAnswered=false`;
  console.log(`[Amazon] Fetching Q&A for ASIN ${asin}`);

  const html = await proxyRequest(amazonQAUrl, false);
  return parseAmazonHTML(html, asin);
}

function parseAmazonHTML(html, asin) {
  const questions = [];
  if (!html || html.length < 100) return questions;

  // data-hook="ask-btf-question-text"
  const hookMatches = [...html.matchAll(/data-hook="ask-btf-question-text"[^>]*>([\s\S]{5,500}?)<\/span>/gi)];
  if (hookMatches.length > 0) {
    const answerHooks = [...html.matchAll(/data-hook="ask-btf-answer-text"[^>]*>([\s\S]{5,500}?)<\/span>/gi)];
    const dateHooks = [...html.matchAll(/data-hook="ask-btf-question-date"[^>]*>([\s\S]{5,100}?)<\/span>/gi)];
    const authorHooks = [...html.matchAll(/data-hook="ask-btf-answer-author"[^>]*>([\s\S]{5,100}?)<\/span>/gi)];

    hookMatches.forEach((m, i) => {
      const q = stripTags(m[1]).trim();
      if (q.length > 5) {
        questions.push({
          question_text: q,
          existing_answer: answerHooks[i] ? stripTags(answerHooks[i][1]).trim() : null,
          answer_status: answerHooks[i] ? 'answered' : 'unanswered',
          date_asked: dateHooks[i] ? parseDate(stripTags(dateHooks[i][1]).trim()) : null,
          customer_name: authorHooks[i] ? stripTags(authorHooks[i][1]).trim() : null
        });
      }
    });
    if (questions.length > 0) return questions;
  }

  // Fallback: JSON in page
  const qJsonMatches = [...html.matchAll(/"questionText"\s*:\s*"([^"]{10,500})"/g)];
  return qJsonMatches.map(m => ({
    question_text: decodeStr(m[1]),
    existing_answer: null,
    answer_status: 'unanswered',
    date_asked: null,
    customer_name: null
  })).filter(q => q.question_text.length > 5);
}

// ── TARGET SCRAPER ─────────────────────────────────────────────────
async function scrapeTarget(url) {
  const tcinMatch = url.match(/A-(\d{7,9})(?:\/|$|\?|#)/);
  if (!tcinMatch) throw new Error(`Cannot extract TCIN from Target URL: ${url}`);
  const tcin = tcinMatch[1];
  console.log(`[Target] Fetching Q&A for TCIN ${tcin}`);

  const html = await proxyRequest(url, false);
  return parseTargetHTML(html, tcin);
}

function parseTargetHTML(html, tcin) {
  if (!html || html.length < 100) return [];

  // Try BazaarVoice passkey extraction + API call
  const passkeyMatch = html.match(/["']passkey["']\s*[:=]\s*["']([A-Za-z0-9]{20,60})["']/);
  if (passkeyMatch) return [{ _bv_passkey: passkeyMatch[1], _bv_tcin: tcin }];

  // Try __NEXT_DATA__
  try {
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) {
      const found = extractQAFromJSON(JSON.parse(m[1]));
      if (found.length > 0) return found;
    }
  } catch (e) {}

  // data-testid Q&A
  const qaMatches = [...html.matchAll(/data-testid="[^"]*(?:question|qa)[^"]*"[^>]*>([\s\S]{5,500}?)<\/[^>]+>/gi)];
  return qaMatches.map(m => ({
    question_text: stripTags(m[1]).trim(),
    existing_answer: null, answer_status: 'unanswered', date_asked: null, customer_name: null
  })).filter(q => q.question_text.length > 5);
}

async function fetchTargetBV(passkey, tcin) {
  const url = `https://api.bazaarvoice.com/data/questions.json?passkey=${passkey}&apiversion=5.4&filter=ProductId:${tcin}&include=Answers&limit=20`;
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
    return (res.data?.Results || []).map(q => ({
      question_text: q.QuestionSummary || '',
      existing_answer: q.Answers?.[0]?.AnswerText || null,
      answer_status: q.Answers?.length > 0 ? 'answered' : 'unanswered',
      date_asked: q.SubmissionTime ? new Date(q.SubmissionTime).toISOString() : null,
      customer_name: q.UserNickname || null
    })).filter(q => q.question_text.length > 5);
  } catch (err) {
    console.warn('[Target BV] failed:', err.message);
    return [];
  }
}

// ── APIFY ENGINE ───────────────────────────────────────────────────
// Uses apify~web-scraper (FREE tier) - runs real browser, bypasses bot detection
// puppeteer-scraper requires paid plan (causes 403)
async function scrapeWithApify(url, retailer) {
  const key = process.env.APIFY_API_KEY;
  if (!key) throw new Error('APIFY_API_KEY not configured');

  const actorId = 'apify~web-scraper'; // FREE actor with browser rendering

  const pageFn = `async function pageFunction(context) {
    await new Promise(r => setTimeout(r, 5000));
    const results = [];
    const bbSelectors = ['[data-testid="question-text"]','.ugc-question .question-text','[class*="question-body"]'];
    for (const sel of bbSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        els.forEach(el => { const t = el.innerText.trim(); if (t.length > 5) results.push({ question_text: t, existing_answer: null, answer_status: 'unanswered', date_asked: null, customer_name: null }); });
        break;
      }
    }
    document.querySelectorAll('[data-hook="ask-btf-question-text"]').forEach(el => {
      const t = el.innerText.trim();
      if (t.length > 5) results.push({ question_text: t, existing_answer: null, answer_status: 'unanswered', date_asked: null, customer_name: null });
    });
    if (results.length === 0) {
      document.querySelectorAll('span,p,div').forEach(el => {
        if (el.children.length === 0) { const t = (el.innerText||'').trim(); if (t.endsWith('?') && t.length > 15 && t.length < 400) results.push({ question_text: t, existing_answer: null, answer_status: 'unanswered', date_asked: null, customer_name: null }); }
      });
    }
    return [...new Map(results.map(q => [q.question_text, q])).values()].slice(0, 30);
  }`;

  console.log('[Apify] Starting web-scraper for ' + url);

  const startRes = await axios.post(
    'https://api.apify.com/v2/acts/' + actorId + '/runs',
    { startUrls: [{ url }], maxRequestsPerCrawl: 1, maxConcurrency: 1, pageFunction: pageFn },
    { params: { token: key }, headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const runId = startRes.data.data.id;
  console.log('[Apify] Run started: ' + runId);

  for (let i = 0; i < 18; i++) {
    await sleep(10000);
    const s = await axios.get('https://api.apify.com/v2/actor-runs/' + runId, { params: { token: key } });
    const status = s.data.data.status;
    console.log('[Apify] Status: ' + status);
    if (status === 'SUCCEEDED') break;
    if (['FAILED','ABORTED','TIMED-OUT'].includes(status)) throw new Error('Apify run ' + status);
  }

  const res = await axios.get('https://api.apify.com/v2/actor-runs/' + runId + '/dataset/items', { params: { token: key } });
  const items = res.data || [];
  console.log('[Apify] Got ' + items.length + ' items');
  return items.filter(q => q.question_text && q.question_text.length > 5);
}

// ── MAIN SCRAPE FUNCTION ───────────────────────────────────────────
async function scrapeTargetItem(target, engine) {
  const log = {
    target_id: target.id, retailer: target.retailer,
    product_name: target.product_name, url: target.url,
    engine_used: engine, scraped_at: new Date().toISOString(),
    found_count: 0, new_count: 0, error: null
  };

  try {
    let rawQuestions = [];

    if (engine === 'apify') {
      rawQuestions = await scrapeWithApify(target.url, target.retailer).catch(e => { log.error = e.message; return []; });
    } else {
      // ScraperAPI path
      try {
        if (target.retailer === 'bestbuy') {
          rawQuestions = await scrapeBestBuy(target.url);
        } else if (target.retailer === 'amazon') {
          rawQuestions = await scrapeAmazon(target.url);
        } else if (target.retailer === 'target') {
          const result = await scrapeTarget(target.url);
          if (result.length === 1 && result[0]._bv_passkey) {
            rawQuestions = await fetchTargetBV(result[0]._bv_passkey, result[0]._bv_tcin);
          } else {
            rawQuestions = result;
          }
        }
      } catch (err) {
        log.error = err.message;
        console.error(`[scrapeTargetItem] ${target.retailer} scrape failed:`, err.message);
      }
    }

    log.found_count = rawQuestions.length;
    console.log(`[scrapeTargetItem] ${target.product_name}: found ${rawQuestions.length} questions`);

    // Deduplicate + insert
    let newCount = 0;
    for (const q of rawQuestions) {
      if (!q.question_text || q.question_text.trim().length < 5) continue;
      const hash = crypto.createHash('md5').update(q.question_text.toLowerCase().trim()).digest('hex');
      const { data: existing } = await supabase.from('questions').select('id').eq('content_hash', hash).single();
      if (existing) continue;

      const { error: insertErr } = await supabase.from('questions').insert({
        question_text: q.question_text.trim(),
        existing_answer: q.existing_answer || null,
        date_asked: q.date_asked || null,
        customer_name: q.customer_name || null,
        answer_status: q.answer_status || 'unanswered',
        retailer: target.retailer,
        product_name: target.product_name,
        product_url: target.url,
        content_hash: hash,
        status: 'pending',
        source: 'scraper'   // ALWAYS scraper — never manual
      });
      if (insertErr) console.error('[scrapeTargetItem] Insert error:', insertErr.message);
      else newCount++;
    }

    log.new_count = newCount;

    try {
      await supabase.from('scrape_targets').update({
        last_scraped_at: new Date().toISOString(),
        questions_found_total: (target.questions_found_total || 0) + newCount
      }).eq('id', target.id);
    } catch (e) { console.error('[scrapeTargetItem] Update target failed:', e.message); }

  } catch (err) {
    log.error = err.message;
    console.error(`[scrapeTargetItem] Top-level error:`, err.message);
  }

  try { await supabase.from('scrape_logs').insert(log); } catch (e) {}
  return log;
}

async function scrapeAll(engine) {
  const { data: targets, error } = await supabase.from('scrape_targets').select('*').eq('is_active', true);
  if (error) throw new Error(`Failed to fetch scrape targets: ${error.message}`);
  if (!targets || targets.length === 0) return { message: 'No active scrape targets', scraped: 0, logs: [] };

  const logs = [];
  for (const target of targets) {
    try {
      const log = await scrapeTargetItem(target, engine);
      logs.push(log);
    } catch (err) {
      console.error(`[scrapeAll] Failed for ${target.product_name}:`, err.message);
      logs.push({ product_name: target.product_name, error: err.message, new_count: 0, found_count: 0 });
    }
  }
  return { scraped: targets.length, logs };
}

// Export with correct name
module.exports = { scrapeAll, scrapeTarget: scrapeTargetItem };

// ── HELPERS ────────────────────────────────────────────────────────
function extractQAFromJSON(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return [];
  const results = [];
  if (Array.isArray(obj)) {
    for (const item of obj) results.push(...extractQAFromJSON(item, depth + 1));
  } else {
    const text = obj.questionText || obj.question || obj.text || obj.body;
    if (text && typeof text === 'string' && text.length > 5) {
      results.push({
        question_text: text.trim(),
        existing_answer: obj.answerText || obj.answer || obj.answers?.[0]?.answerText || null,
        answer_status: obj.answers?.length > 0 ? 'answered' : 'unanswered',
        date_asked: obj.submissionTime ? new Date(obj.submissionTime).toISOString() : null,
        customer_name: obj.userNickname || obj.author || null
      });
    }
    for (const key of Object.keys(obj)) {
      if (!['__typename','__ref','extensions','headers','styles'].includes(key)) {
        results.push(...extractQAFromJSON(obj[key], depth + 1));
      }
    }
  }
  return results;
}

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
}
function decodeStr(str) {
  return (str||'').replace(/\\u([0-9a-fA-F]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16))).replace(/\\n/g,' ').replace(/\\"/g,'"').replace(/\\\\/g,'\\').trim();
}
function parseDate(str) { try { return new Date(str).toISOString(); } catch { return null; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// BUILD: v2.3.202606261143
