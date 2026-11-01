const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
  const { data: user, error: uErr } = await supabase.auth.admin.getUserById('d32c26e9-8362-493d-90c6-397f420314d3');
  console.log('USER:', user?.user?.email, 'Metadata:', user?.user?.user_metadata);
}
test();

