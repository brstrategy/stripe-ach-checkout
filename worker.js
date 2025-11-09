// --- GLOBAL CONFIGURATION (Unchanged) ---
const CLIENT_DOMAIN = 'https://stripe-ach-checkout.pages.dev';

const corsHeaders = {
  'Access-Control-Allow-Origin': CLIENT_DOMAIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
// ------------------------------------------------

export default {
  async fetch(request, env) {
    
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      // *** MINIMAL CHANGE: Removed /check-saved-methods and /process-saved-payment routes ***
      
      // --- STEP A: CREATE CHECKOUT SESSION (The ONLY public endpoint) ---
      if (pathname === '/create-checkout-session' && request.method === 'POST') {
        return handleCreateCheckoutSession(request, env); 
      }
      
      // Not found route
      return new Response('Not Found', {
        status: 404,
        headers: corsHeaders,
      });

    } catch (e) {
      console.error('Error in fetch handler:', e);
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  }
};

// =================================================================
// === HANDLER FUNCTIONS (Kept for reference, but unreachable) =======
// =================================================================

/**
 * Checks for existing customer and verified ACH payment methods.
 * (Now Unreachable via public Worker route, but kept for future use)
 */
async function handleCheckSavedMethods(request, env) {
  const { email, amount } = await request.json(); // amount in cents

  if (!email || !amount || amount <= 0) {
    return new Response(JSON.stringify({ error: 'Missing email or amount' }), { status: 400, headers: corsHeaders });
  }
  // ... (rest of the function logic is UNCHANGED) ...
  // Note: The function body is unchanged from your current worker.js
  const searchRes = await fetch(`https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const searchData = await searchRes.json();
    
  if (searchData.data && searchData.data.length > 0) {
    const customerId = searchData.data[0].id;

    const pmsRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=us_bank_account&limit=100`, {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const pmsData = await pmsRes.json();
      
    const savedMethods = pmsData.data
      .filter(pm => pm.us_bank_account.status === 'verified')
      .map(pm => ({
        id: pm.id,
        bank_name: pm.us_bank_account.bank_name,
        last4: pm.us_bank_account.last4,
        display: `${pm.us_bank_account.bank_name} (****${pm.us_bank_account.last4})`
      }));
          
    if (savedMethods.length > 0) {
      return new Response(
        JSON.stringify({ status: 'SAVED_FOUND', customerId, savedMethods }), 
        { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    } else {
      return new Response(
        JSON.stringify({ status: 'NO_SAVED', customerId }), 
        { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  } else {
    return new Response(
      JSON.stringify({ status: 'NEW_CUSTOMER' }), 
      { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}


/**
 * HANDLES CREATING A NEW CHECKOUT SESSION 
 * (Unchanged, this is the function the index.html now calls directly)
 */
async function handleCreateCheckoutSession(request, env) {
  const { amount, email } = await request.json();

  // 1. SEARCH/CREATE STRIPE CUSTOMER
  let customerId;
  const searchRes = await fetch(`https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const searchData = await searchRes.json();
    
  if (searchData.data && searchData.data.length > 0) {
    customerId = searchData.data[0].id;
  } else {
    const createRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }).toString(),
    });
    const createData = await createRes.json();
    if (!createRes.ok || !createData.id) throw new Error('Failed to create Stripe customer.');
    customerId = createData.id;
  }

  let mode = 'payment'; 
    
  // 2. BUILD SESSION PARAMS
  const params = {
    'payment_method_types[0]': 'us_bank_account', // Enforce ACH only
    mode: mode,
    customer: customerId,
    client_reference_id: customerId,
    // Crucial parameter for saving the payment method for Link re-use
    'payment_intent_data[setup_future_usage]': 'off_session', 
    success_url: `${CLIENT_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}&mode=${mode}&amount=${amount}`, 
    cancel_url: `${CLIENT_DOMAIN}/cancel.html`,
  };

  // Add line item for payment mode
  params['line_items[0][quantity]'] = '1';
  params['line_items[0][price_data][currency]'] = 'usd';
  params['line_items[0][price_data][product_data][name]'] = 'Client Payment';
  params['line_items[0][price_data][unit_amount]'] = amount.toString();
    
  const sessionRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  const sessionData = await sessionRes.json();

  if (sessionRes.ok && sessionData.id) {
    return new Response(
      JSON.stringify({ id: sessionData.id }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } else {
    console.error('Stripe API error:', sessionData);
    return new Response(
      JSON.stringify({ error: sessionData.error ? (sessionData.error.message || 'Stripe error') : 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}


/**
 * HANDLES OFF-SESSION CHARGE 
 * (Now Unreachable via public Worker route, but kept for future use)
 */
async function handleProcessSavedPayment(request, env) {
  const { customerId, paymentMethodId, amount } = await request.json();

  // ... (rest of the function logic is UNCHANGED) ...
  // Note: The function body is unchanged from your current worker.js
  const intentParams = new URLSearchParams({
    amount: amount,
    currency: 'usd',
    customer: customerId,
    payment_method: paymentMethodId,
    confirm: 'true',
    off_session: 'true',
    'payment_method_types[0]': 'us_bank_account',
    description: `Client Payment via saved ACH method`,
  }).toString();

  const intentRes = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: intentParams,
  });

  const intentData = await intentRes.json();
    
  if (intentRes.ok) {
    return new Response(
      JSON.stringify({ status: intentData.status, paymentIntentId: intentData.id }),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } else {
    console.error('Payment Intent error:', intentData);
    return new Response(
      JSON.stringify({ error: intentData.error ? intentData.error.message : 'Failed to process saved payment.' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}