const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const supabase = require('../utils/supabase');

const upload = multer({ storage: multer.memoryStorage() });

// GET all scrape targets
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('scrape_targets')
    .select('*')
    .order('added_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST upload Excel
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const targets = rows
      .filter(r => r.retailer && r.product_name && r.url)
      .map(r => ({
        retailer: r.retailer.toString().toLowerCase().trim(),
        product_name: r.product_name.toString().trim(),
        url: r.url.toString().trim(),
        is_active: r.active?.toString().toLowerCase() !== 'no'
      }));

    if (targets.length === 0)
      return res.status(400).json({ error: 'No valid rows found. Check columns: retailer, product_name, url, active' });

    const { data, error } = await supabase
      .from('scrape_targets')
      .upsert(targets, { onConflict: 'retailer,url' })
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ inserted: data.length, targets: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET download Excel template
router.get('/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['retailer', 'product_name', 'url', 'active'],
    ['bestbuy', 'Hisense 55" U6 Series MiniLED TV', 'https://www.bestbuy.com/site/...', 'yes'],
    ['bestbuy', 'Hisense 65" U8 Series MiniLED TV', 'https://www.bestbuy.com/site/...', 'yes'],
    ['amazon',  'Hisense 55" U6 Series MiniLED TV', 'https://www.amazon.com/dp/...',    'yes'],
    ['amazon',  'Hisense 65" U8 Series MiniLED TV', 'https://www.amazon.com/dp/...',    'yes']
  ]);
  ws['!cols'] = [{ wch: 12 }, { wch: 40 }, { wch: 60 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Scrape Targets');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="cqm_scrape_targets_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// PATCH activate/deactivate/edit
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const { data, error } = await supabase
    .from('scrape_targets')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE target
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('scrape_targets').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
