const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('config').select('*');
  if (error) return res.status(500).json({ error: error.message });
  const config = {};
  (data || []).forEach(row => { config[row.key] = row.value; });
  res.json(config);
});

router.post('/', async (req, res) => {
  const { key, value } = req.body;
  const { data, error } = await supabase.from('config')
    .upsert({ key, value }, { onConflict: 'key' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
