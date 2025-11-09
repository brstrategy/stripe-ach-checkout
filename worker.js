export default {
  async fetch(request, env) {
    const CLIENT_DOMAIN = 'https://stripe-ach-checkout.pages.dev';
    const corsHeaders = {
      'Access-Control-Allow-Origin': CLIENT_DOMAIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      // --- NEW STEP: CHECK FOR SAVED METHODS (The Router) ---
      if (pathname === '/check-saved-methods' && request.method === 'POST') {
        return handleCheckSavedMethods(request, env, corsHeaders);
      }
        
      // --- STEP A: CREATE CHECKOUT SESSION (For New Customers) ---
      else if (pathname === '/create-checkout-session' && request.method === 'POST') {
        return handleCreateCheckoutSession(request, env, corsHeaders);
      }
        
      // --- STEP B: PROCESS SAVED PAYMENT (Off-Session Charge) ---
      else if (pathname === '/process-saved-payment' && request.method === 'POST') {
        return handleProcessSavedPayment(request, env, corsHeaders);
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
// === HANDLER FUNCTIONS ===========================================
// =================================================================

/**
 * NEW: Checks for existing customer and verified ACH payment methods.
 * This determines whether to send the user to the custom selection page or Stripe Checkout.
 */
async function handleCheckSavedMethods(request, env, corsHeaders) {
  const { email, amount } = await request.json(); // amount in cents

  if (!email || !amount || amount <= 0) {
    return new Response(JSON.stringify({ error: 'Missing email or amount' }), { status: 400, headers: corsHeaders });
  }

  // 1. SEARCH/CREATE STRIPE CUSTOMER (Only searching now, creation happens in Checkout if needed)
  const searchRes = await fetch(`https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const searchData = await searchRes.json();
    
  if (searchData.data && searchData.data.length > 0) {
    const customerId = searchData.data[0].id;

    // 2. CHECK FOR SAVED VERIFIED ACH METHOD
    const pmsRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=us_bank_account&limit=100`, {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const pmsData = await pmsRes.json();
        
    // Filter for verified ACH accounts and map to a simpler object
    const savedMethods = pmsData.data
      .filter(pm => pm.us_bank_account.status === 'verified')
      .map(pm => ({
        id: pm.id,
        bank_name: pm.us_bank_account.bank_name,
        last4: pm.us_bank_account.last4,
        // Add a simple display line for the front-end
        display: `${pm.us_bank_account.bank_name} (****${pm.us_bank_account.last4})`
      }));
            
    if (savedMethods.length > 0) {
      // Found saved methods, send list to custom selection page
      return new Response(
        JSON.stringify({ status: 'SAVED_FOUND', customerId, savedMethods }), 
        { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    } else {
      // Customer exists, but no verified ACH method
      return new Response(
        JSON.stringify({ status: 'NO_SAVED', customerId }), 
        { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  } else {
    // New customer, send to Stripe Checkout for setup/payment
    return new Response(
      JSON.stringify({ status: 'NEW_CUSTOMER' }), 
      { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}


/**
 * HANDLES CREATING A NEW CHECKOUT SESSION (Original Logic for New Customers)
 * This function should *not* be called if saved methods were found.
 */
async function handleCreateCheckoutSession(request, env, corsHeaders) {
  const { amount, email } = await request.json();

  // The customer is either new or has no saved methods, so we proceed to Checkout.
    
  // We must get/create the customer ID here so the new method can be saved to them.
  let customerId;
  let isReturningCustomer = false;

  // 1. SEARCH/CREATE STRIPE CUSTOMER (Copied from your original logic)
  const searchRes = await fetch(`https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const searchData = await searchRes.json();
    
  if (searchData.data && searchData.data.length > 0) {
    customerId = searchData.data[0].id;
    isReturningCustomer = true;
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

  // Since the /check-saved-methods logic already determined NO saved verified methods exist, 
  // we use 'payment' mode to collect a payment AND save the method.
  let mode = 'payment'; 
    
  // 3. BUILD SESSION PARAMS
  const params = {
    'payment_method_types[0]': 'us_bank_account', // Enforce ACH only
    mode: mode,
    customer: customerId,
    client_reference_id: customerId,
    // The success_url will guide the client to the bank verification step
    success_url: `${CLIENT_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}&mode=${mode}&amount=${amount}`, 
    cancel_url: `${CLIENT_DOMAIN}/cancel.html`,
  };

  // Add line item for payment mode
  params['payment_intent_data[setup_future_usage]'] = 'off_session'; // Save new method
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
 * HANDLES OFF-SESSION CHARGE (Your existing logic, used by payment_selection.html)
 */
async function handleProcessSavedPayment(request, env, corsHeaders) {
  const { customerId, paymentMethodId, amount } = await request.json();

  // 1. CREATE PAYMENT INTENT
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
    // Send status back to the front-end for redirect
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