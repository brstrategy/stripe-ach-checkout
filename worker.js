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
                // --- STEP A: CREATE CHECKOUT SESSION ---
                if (pathname === '/create-checkout-session') {
                    const { amount, email } = await request.json();
    
                    let customerId;
                    let isReturningCustomer = false;
                    
                    // 1. SEARCH/CREATE STRIPE CUSTOMER
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
    
                    // 2. CHECK FOR SAVED VERIFIED ACH METHOD
                    // We fetch the Customer's payment methods to decide the Checkout mode.
                    const pmsRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=us_bank_account`, {
                        headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
                    });
                    const pmsData = await pmsRes.json();
                    
                    // We assume any verified bank account is sufficient to trigger the setup flow.
                    const hasVerifiedAch = pmsData.data.some(pm => pm.us_bank_account.status === 'verified');
                    
                    let mode = 'payment'; // Default for new customers (immediate charge + save)
                    
                    // If returning customer AND they have a verified ACH, use 'setup' to show saved method.
                    if (isReturningCustomer && hasVerifiedAch) {
                        mode = 'setup'; 
                    }
    
                    // 3. BUILD SESSION PARAMS
                    const params = {
                        'payment_method_types[0]': 'us_bank_account',
                        mode: mode,
                        customer: customerId,
                        client_reference_id: customerId,
                        success_url: `${CLIENT_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}&mode=${mode}&amount=${amount}`, // Pass mode and amount
                        cancel_url: `${CLIENT_DOMAIN}/cancel.html`,
                    };
    
                    // Add line item ONLY if mode is 'payment'
                    if (mode === 'payment') {
                        params['payment_intent_data[setup_future_usage]'] = 'off_session'; // Save new method
                        params['line_items[0][quantity]'] = '1';
                        params['line_items[0][price_data][currency]'] = 'usd';
                        params['line_items[0][price_data][product_data][name]'] = 'Client Payment';
                        params['line_items[0][price_data][unit_amount]'] = amount.toString();
                    } 
                    
                    // Add setup intent data ONLY if mode is 'setup'
                    else if (mode === 'setup') {
                        params['setup_intent_data[usage]'] = 'off_session'; // Must be set for setup mode
                        // We also need to save the amount in the session metadata to use it later for charging.
                        params['metadata[amount]'] = amount.toString(); 
                    }
    
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
                
                // --- STEP B: PROCESS SAVED PAYMENT ---
                else if (pathname === '/process-saved-payment' && request.method === 'POST') {
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