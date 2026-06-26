const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = supabase;
// CQM v2.0 - 2026-06-25 - Build: final
// BUILD: v2.1.202606261112
