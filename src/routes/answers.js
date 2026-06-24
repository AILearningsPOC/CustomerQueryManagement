const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET answered questions (audit trail)
router.get('/', async (req, res) => {
  const { retailer, category, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = supabase.from('questions')
    .select('*', { count: 'exact' })
    .eq('status', 'answered');

  if (retailer)  query = query.eq('retailer', retailer);
  if (category)  query = query.eq('category', category);

  const { data, error, count } = await query
    .order('date_answered', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count });
});

module.exports = router;
