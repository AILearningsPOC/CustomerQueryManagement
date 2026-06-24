const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');

// GET all agents
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('agents').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST create agent
router.post('/', async (req, res) => {
  const { name, role, skills, retailer_ids } = req.body;
  const { data, error } = await supabase.from('agents').insert({
    name, role: role || 'agent',
    skills: skills || [],
    retailer_ids: retailer_ids || [],
    is_active: true
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH update agent
router.patch('/:id', async (req, res) => {
  const { data, error } = await supabase.from('agents').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE agent
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('agents').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET agent workload summary
router.get('/workload', async (req, res) => {
  const { data: agents } = await supabase.from('agents').select('*').eq('is_active', true);
  if (!agents) return res.json([]);

  const workloads = await Promise.all(agents.map(async (agent) => {
    const [{ count: open }, { count: answered_today }] = await Promise.all([
      supabase.from('questions').select('*', { count: 'exact', head: true })
        .eq('assigned_to', agent.name).in('status', ['pending', 'review']),
      supabase.from('questions').select('*', { count: 'exact', head: true })
        .eq('assigned_to', agent.name).eq('status', 'answered')
        .gte('date_answered', new Date(Date.now() - 86400000).toISOString())
    ]);

    // SLA: questions pending > 24hrs
    const { data: sla_breached } = await supabase.from('questions')
      .select('id').eq('assigned_to', agent.name).in('status', ['pending', 'review'])
      .lt('created_at', new Date(Date.now() - 86400000).toISOString());

    return { ...agent, open_questions: open || 0, answered_today: answered_today || 0, sla_breached: sla_breached?.length || 0 };
  }));

  res.json(workloads);
});

module.exports = router;
