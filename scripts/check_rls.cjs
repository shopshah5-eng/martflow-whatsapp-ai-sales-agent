const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const adminClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function testUserQuery() {
  const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  
  // Set password so we can authenticate anonClient
  await adminClient.auth.admin.updateUserById('d32c26e9-8362-493d-90c6-397f420314d3', {
    password: 'TestPassword123!'
  });

  const { data: signin, error: sErr } = await anonClient.auth.signInWithPassword({
    email: 'shopshah5@gmail.com',
    password: 'TestPassword123!'
  });
  console.log('Sign in error:', sErr);

  if (signin?.session) {
    const { data: convs, error: cErr } = await anonClient
      .from('conversations')
      .select('*, leads(*)')
      .eq('org_id', '6fd354d9-3437-412d-856e-28bc19d44268');
    console.log('AUTHENTICATED USER CONVS count:', convs?.length, 'ERROR:', cErr);

    const { data: msgs, error: mErr } = await anonClient
      .from('messages')
      .select('*')
      .eq('org_id', '6fd354d9-3437-412d-856e-28bc19d44268');
    console.log('AUTHENTICATED USER MSGS count:', msgs?.length, 'ERROR:', mErr);

    const { data: leads, error: lErr } = await anonClient
      .from('leads')
      .select('*')
      .eq('org_id', '6fd354d9-3437-412d-856e-28bc19d44268');
    console.log('AUTHENTICATED USER LEADS count:', leads?.length, 'ERROR:', lErr);
  }
}
testUserQuery();
