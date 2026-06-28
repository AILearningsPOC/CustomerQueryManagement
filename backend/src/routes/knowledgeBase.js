const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../utils/supabase');
const { generateEmbedding } = require('../services/embedding');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// In-memory PDF cache for immediate serving after upload
const pdfCache = new Map();

// GET /api/knowledge-base
router.get('/', async (req, res) => {
  try {
    const { category, source, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase.from('knowledge_base')
      .select('id,title,content,category,source,created_at,has_pdf,pdf_filename,pdf_url', { count: 'exact' });
    if (category) query = query.eq('category', category);
    if (source)   query = query.eq('source', source);
    if (search)   query = query.ilike('content', `%${search}%`);

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ data: data || [], total: count || 0 });
  } catch (err) {
    console.error('[kb.GET /]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge-base/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('knowledge_base').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// DELETE /api/knowledge-base/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('knowledge_base').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-base/upload-pdf
router.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    const pdfParse = require('pdf-parse');
    let text = '';
    try {
      const parsed = await pdfParse(req.file.buffer);
      text = parsed.text.replace(/\s+/g, ' ').trim();
    } catch (parseErr) {
      return res.status(400).json({ error: 'Could not extract text from PDF. Ensure it is a text-based (not scanned) PDF.' });
    }

    if (text.length < 50) return res.status(400).json({ error: 'Could not extract meaningful text from PDF' });

    const filename = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    // ── STORAGE UPLOAD ─────────────────────────────────────────────
    let pdfUrl = null;
    let storageSuccess = false;

    try {
      console.log(`[KB] Uploading PDF to storage: ${filename}`);
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('manuals')
        .upload(filename, req.file.buffer, {
          contentType: 'application/pdf',
          upsert: true,
          cacheControl: '3600'
        });

      if (uploadError) {
        console.error('[KB] Storage upload error:', uploadError.message, uploadError);
      } else {
        console.log('[KB] Storage upload success:', uploadData);
        // Get public URL
        const { data: urlData } = supabase.storage.from('manuals').getPublicUrl(filename);
        pdfUrl = urlData?.publicUrl || null;
        storageSuccess = true;
        console.log('[KB] Public URL:', pdfUrl);
      }
    } catch (storageErr) {
      console.error('[KB] Storage exception:', storageErr.message);
    }

    // ── CACHE PDF BUFFER in memory for immediate streaming ─────────
    // This ensures preview works even if storage upload failed
    pdfCache.set(filename, {
      buffer: req.file.buffer,
      contentType: 'application/pdf',
      originalName: req.file.originalname,
      uploadedAt: Date.now()
    });
    console.log(`[KB] PDF cached in memory: ${filename} (${req.file.buffer.length} bytes)`);

    // Build preview URL — use storage URL if available, else backend stream
    const previewUrl = pdfUrl || null; // frontend will use /api/knowledge-base/pdf/:filename as fallback

    // ── CHUNK AND EMBED ────────────────────────────────────────────
    const chunkSize = 500;
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));

    const title = req.file.originalname.replace(/\.pdf$/i, '');
    const maxChunks = Math.min(chunks.length, 50);
    const inserted = [];

    for (let i = 0; i < maxChunks; i++) {
      let embedding = null;
      try { embedding = await generateEmbedding(chunks[i]); } catch (e) { console.error(`[KB] Chunk ${i} embedding failed:`, e.message); }

      const { data } = await supabase.from('knowledge_base').insert({
        title: `${title} (part ${i + 1}/${maxChunks})`,
        content: chunks[i],
        category: req.body.category || 'product_info',
        source: 'pdf_manual',
        embedding,
        has_pdf: true,
        pdf_filename: filename,
        pdf_url: previewUrl,
        created_at: new Date().toISOString()
      }).select('id').single();

      if (data) inserted.push(data.id);
    }

    res.json({
      success: true,
      chunks_stored: inserted.length,
      total_chars: text.length,
      pdf_url: previewUrl,
      filename,
      storage_used: storageSuccess,
      preview_endpoint: `/api/knowledge-base/pdf/${filename}`
    });
  } catch (err) {
    console.error('[kb.POST /upload-pdf]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge-base/pdf/:filename
// Serves PDF — tries in-memory cache first, then Supabase storage
router.get('/pdf/:filename', async (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  console.log(`[KB] PDF request: ${filename}`);

  // 1. Try in-memory cache first (fastest, works immediately after upload)
  const cached = pdfCache.get(filename);
  if (cached) {
    console.log(`[KB] Serving from memory cache: ${filename}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${cached.originalName}"`);
    res.setHeader('Content-Length', cached.buffer.length);
    return res.send(cached.buffer);
  }

  // 2. Try Supabase storage
  try {
    console.log(`[KB] Trying storage download: ${filename}`);
    const { data, error } = await supabase.storage.from('manuals').download(filename);

    if (error) {
      console.error('[KB] Storage download failed:', error.message);
      return res.status(404).json({
        error: 'PDF not found. The file may have expired from cache. Please re-upload the PDF.',
        hint: 'PDFs are cached temporarily. For permanent storage, ensure the Supabase "manuals" bucket is public.'
      });
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    console.log(`[KB] Serving from storage: ${filename} (${buffer.length} bytes)`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    console.error('[kb.GET /pdf/:filename]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-base/backfill-embeddings
router.post('/backfill-embeddings', async (req, res) => {
  try {
    const { data: entries } = await supabase
      .from('knowledge_base').select('id,content').is('embedding', null).limit(50);

    if (!entries?.length) return res.json({ message: 'All entries already have embeddings', done: 0, total: 0 });

    let done = 0;
    for (const entry of entries) {
      try {
        const embedding = await generateEmbedding(entry.content);
        await supabase.from('knowledge_base').update({ embedding }).eq('id', entry.id);
        done++;
      } catch (e) {
        console.error(`[KB] Backfill embedding failed for ${entry.id}:`, e.message);
      }
    }

    res.json({ done, total: entries.length, message: done === 0 ? 'HuggingFace API may be unavailable. Check HF_API_KEY.' : `${done}/${entries.length} embeddings generated` });
  } catch (err) {
    console.error('[kb.POST /backfill-embeddings]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// BUILD: v2.5.20260628202701
