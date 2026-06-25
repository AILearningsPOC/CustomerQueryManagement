const axios = require('axios');
const supabase = require('../utils/supabase');
const crypto = require('crypto');

// ── SCRAPERAPI ENGINE ──────────────────────────────────────────────
async function scrapeWithScraperAPI(url, options = {}) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) throw new Error('SCRAPERAPI_KEY not configured');

  // BestBuy requires premium=true to bypass bot protection
  const isBestBuy = url.includes('bestbuy.com');
  const params = new URLSearchParams({
    api_key: key,
    url: url,
    render: 'true',
    keep_headers: 'true',
    country_code: 'us'
  });
  if (options.premium || isBestBuy) params.append('premium', 'true');

  const apiUrl = `http://api.scraperapi.com?${params.toString()}`;
  const response = await axios.get(apiUrl, {
    timeout: 90000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  return response.data;
}

// ── BESTBUY Q&A PARSER ─────────────────────────────────────────────
function parseBestBuyQA(html) {
  const questions = [];
  if (!html || html.length < 100) return questions;

  // Strategy 1: __NEXT_DATA__ embedded JSON (React SSR)
  try {
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) {
      const data = JSON.parse(m[1]);
      const found = extractQAFromJSON(data);
      if (found.length > 0) { console.log(`[BestBuy] Found ${found.length} via __NEXT_DATA__`); return found; }
    }
  } catch (e) {}

  // Strategy 2: Embedded question JSON strings
  try {
    const qMatches = [...html.matchAll(/"questionText"\s*:\s*"([^"]{10,500})"/g)];
    const aMatches = [...html.matchAll(/"answerText"\s*:\s*"([^"]{5,500})"/g)];
    if (qMatches.length > 0) {
      qMatches.forEach((m, i) => {
        const q = decodeStr(m[1]);
        const a = aMatches[i] ? decodeStr(aMatches[i][1]) : null;
        if (q.length > 5) questions.push({ question_text: q, existing_answer: a, answer_status: a ? 'answered' : 'unanswered', date_asked: null, customer_name: null });
      });
      if (questions.length > 0) { console.log(`[BestBuy] Found ${questions.length} via questionText JSON`); return questions; }
    }
  } catch (e) {}

  // Strategy 3: React data-testid attributes
  const testidBlocks = html.match(/data-testid="question[^"]*"[^>]*>([\s\S]{5,500}?)<\/[^>]+>/gi) || [];
  for (const block of testidBlocks) {
    const text = stripTags(block).trim();
    if (text.length > 5) questions.push({ question_text: text, existing_answer: null, answer_status: 'unanswered', date_asked: null, customer_name: null });
  }
  if (questions.length > 0) { console.log(`[BestBuy] Found ${questions.length} via data-testid`); return questions; }

  // Strategy 4: Legacy CSS classes
  const classPatterns = ['ugc-question', 'c-question-answer', 'question-body'];
  for (const cls of classPatterns) {
    const rx = new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]{10,500}?)<\\/div>`, 'gi');
    const matches = [...html.matchAll(rx)];
    for (const m of matches) {
      const text = stripTags(m[1]).trim();
      if (text.length > 5) questions.push({ question_text: text, existing_answer: null, answer_status: 'unanswered', date_asked: null, customer_name: null });
    }
  }
  if (questions.length > 0) console.log(`[BestBuy] Found ${questions.length} via legacy classes`);

  return questions.filter(q => q.question_text.length > 5).slice(0, 50);
}

// ── AMAZON Q&A PARSER ──────────────────────────────────────────────
function parseAmazonQA(html) {
  const questions = [];
  if (!html || html.length < 100) return questions;

  // Strategy 1: data-hook attribute (Amazon standard)
  const hookMatches = [...html.matchAll(/data-hook="ask-btf-question-text"[^>]*>([\s\S]{5,500}?)<\/span>/gi)];
  if (hookMatches.length > 0) {
    const answerHooks = [...html.matchAll(/data-hook="ask-btf-answer-text"[^>]*>([\s\S]{5,500}?)<\/span>/gi)];
    hookMatches.forEach((m, i) => {
      const q = stripTags(m[1]).trim();
      const a = answerHooks[i] ? stripTags(answerHooks[i][1]).trim() : null;
      if (q.length > 5) questions.push({ question_text: q, existing_answer: a, answer_status: a ? 'answered' : 'unanswered', date_asked: null, customer_name: null });
    });
    if (questions.length > 0) { console.log(`[Amazon] Found ${questions.length} via data-hook`); return questions; }
  }

  // Strategy 2: JSON embedded in page
  try {
    const jsonMatches = [...html.matchAll(/"questionText"\s*:\s*\{"displayValue"\s*:\s*"([^"]{10,500})"/g)];
    const answerMatches = [...html.matchAll(/"answerText"\s*:\s*\{"displayValue"\s*:\s*"([^"]{5,500})"/g)];
    if (jsonMatches.length > 0) {
      jsonMatches.forEach((m, i) => {
        const q = decodeStr(m[1]);
        const a = answerMatches[i] ? decodeStr(answerMatches[i][1]) : null;
        if (q.length > 5) questions.push({ question_text: q, existing_answer: a, answer_status: a ? 'answered' : 'unanswered', date_asked: null, customer_name: null });
      });
      if (questions.length > 0) { console.log(`[Amazon] Found ${questions.length} via JSON`); return questions; }
    }
  } catch (e) {}

  // Strategy 3: a-text-bold spans ending in ?
  const boldSpans = [...html.matchAll(/class="[^"]*a-text-bold[^"]*"[^>]*>([\s\S]{10,300}?)<\/span>/gi)];
  for (const m of boldSpans) {
    const text = stripTags(m[1]).trim();
    if (text.endsWith('?') && text.length > 10) {
      questions.push({ question_text: text, existing_answer: null, answer_status: 'unanswered', date_asked: null, customer_name: null });
    }
  }
  if (questions.length > 0) { console.log(`[Amazon] Found ${questions.length} via a-text-bold`); return questions; }

  // Strategy 4: askQuestion divs
  const askDivs = html.match(/<div[^>]*id="[^"]*askQuestion[^"]*"[^>]*>([\s\S]{10,500}?)<\/div>/gi) || [];
  for (const block of askDivs) {
    const qm = block.match(/class="[^"]*a-size-base[^"]*"[^>]*>([\s\S]{5,300}?)<\/span>/i);
    const am = block.match(/class="[^"]*askAnswer[^"]*"[^>]*>([\s\S]{5,300}?)<\/span>/i);
    if (qm) {
      const q = stripTags(qm[1]).trim();
      if (q.length > 5) questions.push({ question_text: q, existing_answer: am ? stripTags(am[1]).trim() : null, answer_status: am ? 'answered' : 'unanswered', date_asked: null, customer_name: null });
    }
  }
  if (questions.length > 0) console.log(`[Amazon] Found ${questions.length} via askQuestion`);

  return questions.filter(q => q.question_text.length > 5).slice(0, 50);
}

// ── APIFY ENGINE ───────────────────────────────────────────────────
async function scrapeWithApify(url, retailer) {
  const key = process.env.APIFY_API_KEY;
  if (!key) throw new Error('APIFY_API_KEY not configured');

  const actorId = 'apify/web-scraper';
  const pageFunction = `
    async function pageFunction(context) {
      const { page } = context;
      await page.waitForTimeout(4000);
      const questions = [];
      // BestBuy
      document.querySelectorAll('[data-testid*="question"], .ugc-question, [class*="question-text"]').forEach(el => {
        const t = el.innerText.trim();
        if (t.length > 5) questions.push({ question_text: t, existing_answer: null });
      });
      // Amazon
      document.querySelectorAll('[data-hook="ask-btf-question-text"]').forEach(el => {
        const t = el.innerText.trim();
        if (t.length > 5) questions.push({ question_text: t, existing_answer: null });
      });
      // Generic fallback - any ? ending text
      if (questions.length === 0) {
        document.querySelectorAll('span, p, div').forEach(el => {
          if (el.children.length === 0) {
            const t = el.innerText.trim();
            if (t.endsWith('?') && t.length > 15 && t.length < 300) {
              questions.push({ question_text: t, existing_answer: null });
            }
          }
        });
      }
      return [...new Map(questions.map(q => [q.question_text, q])).values()].slice(0, 30);
    }`;

  const startRes = await axios.post(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${key}`,
    { startUrls: [{ url }], pageFunction, maxRequestsPerCrawl: 1, maxConcurrency: 1 },
    { timeout: 30000 }
  );

  const runId = startRes.data.data.id;
  for (let i = 0; i < 18; i++) {
    await sleep(10000);
    const s = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}?token=${key}`);
    if (s.data.data.status === 'SUCCEEDED') break;
    if (s.data.data.status === 'FAILED') throw new Error('Apify run failed');
  }

  const res = await axios.get(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${key}`);
  return (res.data || [])
    .filter(item => item.question_text && item.question_text.length > 5)
    .map(item => ({ question_text: item.question_text, existing_answer: item.existing_answer || null, answer_status: item.existing_answer ? 'answered' : 'unanswered', date_asked: null, customer_name: null }));
}

// ── MAIN SCRAPE ────────────────────────────────────────────────────
async function scrapeTarget(target, engine) {
  const log = {
    target_id: target.id, retailer: target.retailer,
    product_name: target.product_name, url: target.url,
    engine_used: engine, scraped_at: new Date().toISOString(),
    found_count: 0, new_count: 0, error: null
  };

  try {
    let rawQuestions = [];

    if (engine === 'apify') {
      rawQuestions = await scrapeWithApify(target.url, target.retailer).catch(err => {
        log.error = `Apify: ${err.message}`; return [];
      });
    } else {
      // ScraperAPI with retry
      let html = null;
      try {
        html = await scrapeWithScraperAPI(target.url);
        console.log(`[scrapeTarget] ScraperAPI fetched ${html?.length || 0} chars for ${target.product_name}`);
      } catch (err) {
        // Retry with premium
        try {
          console.log(`[scrapeTarget] Retrying with premium for ${target.product_name}`);
          html = await scrapeWithScraperAPI(target.url, { premium: true });
        } catch (err2) {
          log.error = err2.message;
          console.error(`[scrapeTarget] ScraperAPI failed both attempts:`, err2.message);
        }
      }

      if (html) {
        if (target.retailer === 'amazon') {
          rawQuestions = parseAmazonQA(html);
        } else if (target.retailer === 'target') {
          const targetResult = parseTargetQA(html);
          // Check if BV API extraction is needed
          if (targetResult.length === 1 && targetResult[0]._bv_passkey) {
            rawQuestions = await fetchTargetBazaarvoiceQA(targetResult[0]._bv_passkey, targetResult[0]._bv_tcin);
          } else {
            rawQuestions = targetResult;
          }
        } else {
          rawQuestions = parseBestBuyQA(html);
        }
        console.log(`[scrapeTarget] Parsed ${rawQuestions.length} questions from ${target.retailer}`);
      }
    }

    log.found_count = rawQuestions.length;

    // Deduplicate + insert
    let newCount = 0;
    for (const q of rawQuestions) {
      if (!q.question_text || q.question_text.trim().length < 5) continue;
      const hash = crypto.createHash('md5').update(q.question_text.toLowerCase().trim()).digest('hex');
      const { data: existing } = await supabase.from('questions').select('id').eq('content_hash', hash).single();
      if (existing) continue;

      const { error: insertErr } = await supabase.from('questions').insert({
        question_text: q.question_text.trim(),
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
      if (insertErr) { console.error('[scrapeTarget] Insert error:', insertErr.message); }
      else newCount++;
    }

    log.new_count = newCount;

    try {
      await supabase.from('scrape_targets').update({
        last_scraped_at: new Date().toISOString(),
        questions_found_total: (target.questions_found_total || 0) + newCount
      }).eq('id', target.id);
    } catch(e) { console.error('[scrapeTarget] Update target failed:', e.message); }

  } catch (err) {
    log.error = err.message;
    console.error(`[scrapeTarget] Top-level error for ${target.product_name}:`, err.message);
  }

  try {
    await supabase.from('scrape_logs').insert(log);
  } catch(e) { console.error('[scrapeTarget] Log insert failed:', e.message); }
  return log;
}

async function scrapeAll(engine) {
  const { data: targets, error } = await supabase.from('scrape_targets').select('*').eq('is_active', true);
  if (error) throw new Error(`Failed to fetch scrape targets: ${error.message}`);
  if (!targets || targets.length === 0) return { message: 'No active scrape targets', scraped: 0, logs: [] };

  const logs = [];
  for (const target of targets) {
    try {
      const log = await scrapeTarget(target, engine);
      logs.push(log);
    } catch (err) {
      console.error(`[scrapeAll] Failed for ${target.product_name}:`, err.message);
      logs.push({ target_id: target.id, product_name: target.product_name, error: err.message, new_count: 0, found_count: 0 });
    }
  }
  return { scraped: targets.length, logs };
}

// ── JSON RECURSIVE EXTRACTOR ───────────────────────────────────────
function extractQAFromJSON(obj, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return [];
  const results = [];
  if (Array.isArray(obj)) {
    for (const item of obj) results.push(...extractQAFromJSON(item, depth + 1));
  } else {
    const text = obj.questionText || obj.question || obj.text || obj.body;
    if (text && typeof text === 'string' && text.length > 5) {
      const ans = obj.answerText || obj.answer || obj.answers?.[0]?.answerText || obj.answers?.[0]?.text;
      results.push({
        question_text: text.trim(),
        existing_answer: ans ? ans.trim() : null,
        answer_status: ans ? 'answered' : 'unanswered',
        date_asked: obj.submissionTime ? new Date(obj.submissionTime).toISOString() : null,
        customer_name: obj.userNickname || obj.author || null
      });
    }
    for (const key of Object.keys(obj)) {
      if (!['__typename','__ref','extensions','headers'].includes(key)) {
        results.push(...extractQAFromJSON(obj[key], depth + 1));
      }
    }
  }
  return results;
}

// ── HELPERS ────────────────────────────────────────────────────────
function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
}
function decodeStr(str) {
  return (str||'').replace(/\\u([0-9a-fA-F]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16))).replace(/\\n/g,' ').replace(/\\"/g,'"').replace(/\\\\/g,'\\').trim();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scrapeAll, scrapeTarget };

// ── TARGET Q&A PARSER ──────────────────────────────────────────────
// Target uses Bazaarvoice for Q&A. Strategy:
// 1. Extract TCIN + BV passkey from rendered HTML
// 2. Call Bazaarvoice API directly
// 3. Fallback: parse embedded __NEXT_DATA__ or PRELOADED_QUERIES
function parseTargetQA(html) {
  const questions = [];
  if (!html || html.length < 100) return questions;

  // Strategy 1: Bazaarvoice API extraction
  // Find BV passkey embedded in page
  const passkeyMatch = html.match(/["']passkey["']\s*[:=]\s*["']([A-Za-z0-9]{20,60})["']/);
  const tcinMatch = html.match(/"tcin"\s*:\s*"(\d{7,9})"/);

  if (passkeyMatch && tcinMatch) {
    console.log(`[Target] Found BV passkey and TCIN: ${tcinMatch[1]}`);
    // Return marker for async BV API call - handled in scrapeTarget
    return [{ _bv_passkey: passkeyMatch[1], _bv_tcin: tcinMatch[1] }];
  }

  // Strategy 2: __NEXT_DATA__ embedded Q&A
  try {
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (m) {
      const data = JSON.parse(m[1]);
      const found = extractQAFromJSON(data);
      if (found.length > 0) { console.log(`[Target] Found ${found.length} via __NEXT_DATA__`); return found; }
    }
  } catch (e) {}

  // Strategy 3: PRELOADED_QUERIES (React Query)
  try {
    const preloadMatch = html.match(/window\.__PRELOADED_QUERIES__\s*=\s*(\[[\s\S]*?\]);/);
    if (preloadMatch) {
      const data = JSON.parse(preloadMatch[1]);
      const found = extractQAFromJSON(data);
      if (found.length > 0) { console.log(`[Target] Found ${found.length} via PRELOADED_QUERIES`); return found; }
    }
  } catch (e) {}

  // Strategy 4: data-testid Q&A elements
  const qaMatches = [...html.matchAll(/data-testid="[^"]*(?:question|qa)[^"]*"[^>]*>([\s\S]{5,500}?)<\/[^>]+>/gi)];
  for (const m of qaMatches) {
    const text = stripTags(m[1]).trim();
    if (text.length > 5) questions.push({ question_text: text, existing_answer: null, answer_status: 'unanswered', date_asked: null, customer_name: null });
  }
  if (questions.length > 0) console.log(`[Target] Found ${questions.length} via data-testid`);

  // Strategy 5: BazaarVoice embedded JSON
  try {
    const bvJson = html.match(/BV\s*\.\s*Questions\s*=\s*(\{[\s\S]*?\});/);
    if (bvJson) {
      const data = JSON.parse(bvJson[1]);
      const found = extractQAFromJSON(data);
      if (found.length > 0) { console.log(`[Target] Found ${found.length} via BV embedded JSON`); return found; }
    }
  } catch (e) {}

  return questions.filter(q => q.question_text && q.question_text.length > 5).slice(0, 50);
}

// Fetch Target Q&A via Bazaarvoice API
async function fetchTargetBazaarvoiceQA(passkey, tcin) {
  const url = `https://api.bazaarvoice.com/data/questions.json?passkey=${passkey}&apiversion=5.4&filter=ProductId:${tcin}&include=Answers&limit=20&offset=0`;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 15000
    });
    const results = res.data?.Results || [];
    console.log(`[Target BV] ${results.length} questions for TCIN ${tcin}`);
    return results.map(q => ({
      question_text: q.QuestionSummary || q.QuestionDetails || '',
      existing_answer: q.Answers?.[0]?.AnswerText || null,
      answer_status: q.Answers?.length > 0 ? 'answered' : 'unanswered',
      date_asked: q.SubmissionTime ? new Date(q.SubmissionTime).toISOString() : null,
      customer_name: q.UserNickname || null
    })).filter(q => q.question_text.length > 5);
  } catch (err) {
    console.warn('[Target BV] API failed:', err.message);
    return [];
  }
}
