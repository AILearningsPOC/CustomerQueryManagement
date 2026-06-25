const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../utils/supabase');
const { generateEmbedding } = require('../services/embedding');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// GET /api/knowledge-base
router.get('/', async (req, res) => {
  const { category, source, search, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase.from('knowledge_base').select('id,title,content,category,source,created_at,has_pdf,pdf_filename', { count: 'exact' });
  if (category) query = query.eq('category', category);
  if (source)   query = query.eq('source', source);
  if (search)   query = query.ilike('content', `%${search}%`);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count });
});

// GET /api/knowledge-base/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('knowledge_base').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// POST /api/knowledge-base — manual entry
router.post('/', async (req, res) => {
  try {
    const { title, content, category, source } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });

    let embedding = null;
    try { embedding = await generateEmbedding(content); } catch (e) { console.error('Embedding error:', e.message); }

    const { data, error } = await supabase.from('knowledge_base').insert({
      title, content, category: category || 'other',
      source: source || 'manual', embedding,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/knowledge-base/:id
router.put('/:id', async (req, res) => {
  try {
    const { title, content, category } = req.body;
    let embedding = null;
    if (content) {
      try { embedding = await generateEmbedding(content); } catch (e) {}
    }

    const updates = { title, content, category, updated_at: new Date().toISOString() };
    if (embedding) updates.embedding = embedding;

    const { data, error } = await supabase.from('knowledge_base').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/knowledge-base/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('knowledge_base').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /api/knowledge-base/upload-pdf
router.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(req.file.buffer);
    const text = parsed.text.replace(/\s+/g, ' ').trim();

    if (text.length < 50) return res.status(400).json({ error: 'Could not extract text from PDF' });

    // Upload PDF to Supabase Storage
    const filename = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error: uploadError } = await supabase.storage
      .from('manuals')
      .upload(filename, req.file.buffer, { contentType: 'application/pdf' });

    let pdfUrl = null;
    if (!uploadError) {
      const { data: urlData } = supabase.storage.from('manuals').getPublicUrl(filename);
      pdfUrl = urlData?.publicUrl;
    }

    // Chunk and embed (chunks of ~500 chars)
    const chunks = [];
    const chunkSize = 500;
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }

    const title = req.file.originalname.replace(/\.pdf$/i, '');
    const inserted = [];

    for (let i = 0; i < Math.min(chunks.length, 50); i++) {
      let embedding = null;
      try { embedding = await generateEmbedding(chunks[i]); } catch (e) {}

      const { data } = await supabase.from('knowledge_base').insert({
        title: `${title} (part ${i + 1}/${Math.min(chunks.length, 50)})`,
        content: chunks[i],
        category: req.body.category || 'product_info',
        source: 'pdf_manual',
        embedding,
        has_pdf: true,
        pdf_filename: filename,
        pdf_url: pdfUrl,
        created_at: new Date().toISOString()
      }).select('id').single();
      if (data) inserted.push(data.id);
    }

    res.json({
      success: true,
      chunks_stored: inserted.length,
      total_chars: text.length,
      pdf_url: pdfUrl,
      filename
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/knowledge-base/pdf/:filename — stream PDF for preview
router.get('/pdf/:filename', async (req, res) => {
  try {
    const { data, error } = await supabase.storage
      .from('manuals')
      .download(req.params.filename);
    if (error) return res.status(404).json({ error: 'PDF not found' });

    const buffer = Buffer.from(await data.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${req.params.filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-base/backfill-embeddings — generate missing embeddings
router.post('/backfill-embeddings', async (req, res) => {
  const { data: entries } = await supabase
    .from('knowledge_base').select('id,content').is('embedding', null).limit(50);

  if (!entries?.length) return res.json({ message: 'No entries need embeddings', count: 0 });

  let done = 0;
  for (const entry of entries) {
    try {
      const embedding = await generateEmbedding(entry.content);
      await supabase.from('knowledge_base').update({ embedding }).eq('id', entry.id);
      done++;
    } catch (e) { console.error(`Embedding failed for KB ${entry.id}:`, e.message); }
  }

  res.json({ done, total: entries.length });
});

module.exports = router;
// CQM v2.0 - 2026-06-25 - Build: final
