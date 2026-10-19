// --- GLOBAL CONFIGURATION ---
// CLIENT_DOMAIN is the primary domain, used for the success/cancel redirect URLs.
const CLIENT_DOMAIN = 'https://pay.dorothycole.com';
// Every origin allowed to call this Worker (CORS).
const ALLOWED_ORIGINS = [
    'https://pay.dorothycole.com',
    'https://pay-dorothy-cole.pages.dev',
];
// IMPORTANT: WORKER_BASE_URL is the domain where this Worker is deployed.
const WORKER_BASE_URL = 'https://custom-stripe-checkout-worker.brigham.workers.dev';
const EXPIRATION_IN_MINUTES = 30; 

// Base CORS headers. The Allow-Origin value is set per request in the fetch handler.
const corsHeaders = {
    'Access-Control-Allow-Origin': CLIENT_DOMAIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
// ----------------------------

// Message to display on Stripe Checkout beneath the payment amount
const PAYMENT_DESCRIPTION = `
To minimize processing costs for Dorothy Cole, please select the 'US bank account' option instead of using a credit card.
`.trim();


export default {
    /**
     * Main Cloudflare Worker fetch handler.
     * Adds the correct CORS headers (based on the request's Origin)
     * to every response, then routes to the right handler.
     */
    async fetch(request, env) {
        const origin = request.headers.get('Origin');
        const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : CLIENT_DOMAIN;
        const cors = {
            ...corsHeaders,
            'Access-Control-Allow-Origin': allowOrigin,
            'Vary': 'Origin',
        };

        // Handle CORS preflight requests
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }

        const response = await handleRequest(request, env);

        // Stamp the per-request CORS headers onto whatever the handler returned
        const headers = new Headers(response.headers);
        for (const [key, value] of Object.entries(cors)) {
            headers.set(key, value);
        }
        return new Response(response.body, { status: response.status, headers });
    }
};

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
        // --- Router to handle API endpoints ---
        if (pathname === '/create-checkout-session' && request.method === 'POST') {
            return await handleCreateCheckoutSession(request, env);
        }
        if (pathname === '/check-duplicate-invoice' && request.method === 'POST') {
            return await handleCheckDuplicateInvoice(request, env);
        }
        if (pathname === '/get-receipt-details' && request.method === 'POST') {
            return await handleGetReceiptDetails(request, env);
        }

        return new Response('Not Found', { status: 404 });

    } catch (e) {
        console.error('Error in fetch handler:', e);
        return new Response(
            JSON.stringify({ error: e.message }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
}

// =================================================================
// === HANDLER: GET RECEIPT DETAILS (FINAL PRODUCTION) ==============
// =================================================================

async function handleGetReceiptDetails(request, env) {
    const { sessionId } = await request.json();

    if (!sessionId) {
        return new Response(JSON.stringify({ error: 'Session ID is required.' }), { status: 400, headers: corsHeaders });
    }

    try {
        // 1. Fetch the Checkout Session and EXPAND the payment_intent
        const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=payment_intent`, {
            headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        const session = await sessionRes.json();

        if (!sessionRes.ok || session.error) {
            throw new Error(`Failed to retrieve session data from Stripe. HTTP Status: ${sessionRes.status}`);
        }
        
        // Check 1: Verify payment status. Accept 'paid' or 'unpaid' (for initiated ACH)
        const acceptedStatuses = ['paid', 'unpaid'];
        const isPaymentVerified = acceptedStatuses.includes(session.payment_status);

        if (!isPaymentVerified) {
            const status = session.payment_status || 'not found';
            throw new Error(`Session status must be paid or unpaid to retrieve receipt. Current Status: ${status}`);
        }

        const paymentIntent = session.payment_intent;
        
        // 2. Extract Required Payment Method Details
        let paymentMethodDetails = {
            brand: 'N/A',
            last4: 'N/A',
            method: 'N/A',
        };
        
        let foundDetails = false;

        // Try Case 1: Details from the finalized Charge object (best source)
        if (paymentIntent && paymentIntent.charges && paymentIntent.charges.data && paymentIntent.charges.data.length > 0) {
            const charge = paymentIntent.charges.data[0];
            const details = charge.payment_method_details;
            
            if (details) {
                paymentMethodDetails.method = details.type;
                if (details.card) {
                    paymentMethodDetails.brand = details.card.brand;
                    paymentMethodDetails.last4 = details.card.last4;
                } else if (details.us_bank_account) {
                    paymentMethodDetails.brand = details.us_bank_account.bank_name || 'US Bank Account';
                    paymentMethodDetails.last4 = details.us_bank_account.last4;
                } else if (details.link) {
                    const card = details.link.card;
                    paymentMethodDetails.method = 'Link';
                    if (card) {
                        paymentMethodDetails.brand = card.brand;
                        paymentMethodDetails.last4 = card.last4;
                    }
                }
                foundDetails = true;
            }
        } 
        
        // Try Case 2: Details from the Payment Intent (common for pending ACH)
        if (!foundDetails && paymentIntent && paymentIntent.payment_method_details) { 
            const details = paymentIntent.payment_method_details;
            paymentMethodDetails.method = details.type || 'N/A';

            if (details.us_bank_account) {
                paymentMethodDetails.brand = details.us_bank_account.bank_name || 'US Bank Account (Pending)';
                paymentMethodDetails.last4 = details.us_bank_account.last4;
                foundDetails = true;
            } else if (details.card) {
                paymentMethodDetails.brand = details.card.brand;
                paymentMethodDetails.last4 = details.card.last4;
                foundDetails = true;
            }
        }
        
        // Try Case 3: Fetch the PaymentMethod object using its ID (most reliable for pending ACH tests)
        if (!foundDetails && paymentIntent && paymentIntent.payment_method) {
            const paymentMethodId = paymentIntent.payment_method;
            const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodId}`, {
                headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
            });
            const pm = await pmRes.json();
            
            if (pmRes.ok && pm.type) {
                paymentMethodDetails.method = pm.type;
                if (pm.us_bank_account) {
                    paymentMethodDetails.brand = pm.us_bank_account.bank_name || 'US Bank Account (Pending)';
                    paymentMethodDetails.last4 = pm.us_bank_account.last4;
                    foundDetails = true;
                } else if (pm.card) {
                    paymentMethodDetails.brand = pm.card.brand;
                    paymentMethodDetails.last4 = pm.card.last4;
                    foundDetails = true;
                }
            }
        }
        // ----------------------------------------------------------------------------------

        // 3. Compile final receipt data
        const receiptData = {
            name: session.customer_details?.name || 'N/A',
            email: session.customer_details?.email || 'N/A',
            timestamp: session.created, // Unix timestamp of session creation
            method: paymentMethodDetails.method,
            brand: paymentMethodDetails.brand,
            last4: paymentMethodDetails.last4,
        };

        return new Response(
            JSON.stringify(receiptData),
            { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );

    } catch (e) {
        console.error('Receipt Details Error:', e.message);
        return new Response(
            JSON.stringify({ error: 'Failed to retrieve receipt details: ' + e.message }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
    }
}


// =================================================================
// === HANDLER: DUPLICATE CHECK (FINAL) ============================
// =================================================================

async function handleCheckDuplicateInvoice(request, env) {
    const { invoiceId } = await request.json();

    if (!invoiceId) {
        return new Response(JSON.stringify({ error: 'Invoice ID is required for check.' }), { status: 400, headers: corsHeaders });
    }

    const query = `metadata["invoice_number"]:"${encodeURIComponent(invoiceId)}"`;

    const searchRes = await fetch(`https://api.stripe.com/v1/payment_intents/search?query=${query}`, {
        headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const searchData = await searchRes.json();

    if (searchRes.ok && searchData.data) {
        const duplicatePayments = searchData.data.filter(pi => 
            pi.status === 'succeeded' || 
            pi.status === 'processing' ||
            pi.status === 'requires_action' ||
            pi.status === 'requires_confirmation' 
        );
        
        const isDuplicate = duplicatePayments.length > 0;
        
        return new Response(
            JSON.stringify({ isDuplicate: isDuplicate }),
            { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
    } else {
        console.error('Stripe search error:', searchData);
        return new Response(
            JSON.stringify({ error: 'Failed to perform duplicate check.' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
    }
}

// =================================================================
// === HANDLER: CREATE SESSION =====================================
// =================================================================

async function handleCreateCheckoutSession(request, env) {
    const { amount, email, invoiceId } = await request.json();

    if (!email || !amount || amount <= 0 || !invoiceId) {
        return new Response(JSON.stringify({ error: 'Missing required field: Email, Amount, or Invoice ID.' }), { status: 400, headers: corsHeaders });
    }

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
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const expires_at = nowInSeconds + (EXPIRATION_IN_MINUTES * 60);

    const params = {
        'payment_method_types[0]': 'us_bank_account',
        'payment_method_types[1]': 'link',
        'payment_method_types[2]': 'card',
        mode: mode,
        customer: customerId,
        client_reference_id: customerId,
        expires_at: expires_at.toString(), 
        'customer_update[name]': 'auto',
        'payment_intent_data[metadata][invoice_number]': invoiceId,
        success_url: `${CLIENT_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}&mode=${mode}&amount=${amount}&invoice_id=${encodeURIComponent(invoiceId)}`, 
        cancel_url: `${CLIENT_DOMAIN}/cancel.html?email=${encodeURIComponent(email)}&amount=${(amount / 100).toFixed(2)}&invoice_id=${encodeURIComponent(invoiceId)}`,
    };

    params['line_items[0][quantity]'] = '1';
    params['line_items[0][price_data][currency]'] = 'usd';
    params['line_items[0][price_data][product_data][name]'] = `Invoice #${invoiceId}`;
    params['line_items[0][price_data][product_data][description]'] = PAYMENT_DESCRIPTION;
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
            JSON.stringify({ error: sessionData.error ? (sessionData.error.message || 'Stripe API request failed.') : 'Internal server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
    }
}
