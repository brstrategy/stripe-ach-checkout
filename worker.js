// --- GLOBAL CONFIGURATION ---
const CLIENT_DOMAIN = 'https://pay-dorothy-cole.pages.dev';

const corsHeaders = {
    'Access-Control-Allow-Origin': CLIENT_DOMAIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
// ----------------------------

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
            // --- Router to handle both API endpoints ---
            if (pathname === '/create-checkout-session' && request.method === 'POST') {
                return handleCreateCheckoutSession(request, env); 
            }
            if (pathname === '/check-duplicate-invoice' && request.method === 'POST') {
                return handleCheckDuplicateInvoice(request, env); 
            }
            
            return new Response('Not Found', {
                status: 404,
                headers: corsHeaders,
            });

        } catch (e) {
            console.error('Error in fetch handler:', e);
            // General catch-all error response
            return new Response(
                JSON.stringify({ error: e.message }),
                { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
        }
    }
};

// =================================================================
// === HANDLER: DUPLICATE CHECK (CORRECTED LOGIC) ==================
// =================================================================

/**
 * Checks Stripe for existing Payment Intents associated with the invoice ID.
 * Uses simple metadata search and filters by status in JavaScript to avoid Stripe query syntax errors.
 */
async function handleCheckDuplicateInvoice(request, env) {
    const { invoiceId } = await request.json();

    if (!invoiceId) {
        return new Response(JSON.stringify({ error: 'Invoice ID is required for check.' }), { status: 400, headers: corsHeaders });
    }

    // SIMPLIFIED QUERY: Only search for the Invoice ID in metadata. 
    // This avoids the confusing AND/OR mix that caused the previous error.
    const query = `metadata["invoice_number"]:"${encodeURIComponent(invoiceId)}"`;

    const searchRes = await fetch(`https://api.stripe.com/v1/payment_intents/search?query=${query}`, {
        headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const searchData = await searchRes.json();

    if (searchRes.ok && searchData.data) {
        // Filter the results in JavaScript for the required statuses: succeeded or processing.
        const duplicatePayments = searchData.data.filter(pi => 
            pi.status === 'succeeded' || pi.status === 'processing'
        );
        
        const isDuplicate = duplicatePayments.length > 0;
        
        return new Response(
            JSON.stringify({ isDuplicate: isDuplicate }),
            { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
    } else {
        console.error('Stripe search error:', searchData);
        // Returns generic failure message as requested by client-side error handling
        return new Response(
            JSON.stringify({ error: 'Failed to perform duplicate check.' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
    }
}

// =================================================================
// === HANDLER: CREATE SESSION =====================================
// =================================================================

/**
 * HANDLES CREATING A NEW STRIPE CHECKOUT SESSION 
 */
async function handleCreateCheckoutSession(request, env) {
    const { amount, email, invoiceId } = await request.json();

    if (!email || !amount || amount <= 0 || !invoiceId) {
        return new Response(JSON.stringify({ error: 'Missing required field: Email, Amount, or Invoice ID.' }), { status: 400, headers: corsHeaders });
    }

    // 1. SEARCH/CREATE STRIPE CUSTOMER
    let customerId;
    const searchRes = await fetch(`https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'`, {
        headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const searchData = await searchRes.json();
    
    if (searchData.data && searchData.data.length > 0) {
        // Customer found, use existing ID
        customerId = searchData.data[0].id;
    } else {
        // Customer not found, create a new one
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
        
        // Ensures name is collected if missing
        'customer_update[name]': 'auto', 
        
        // Attach the Invoice ID as metadata on the Payment Intent
        'payment_intent_data[metadata][invoice_number]': invoiceId, 
        
        // ACH payments require success/cancel URLs for redirects
        success_url: `${CLIENT_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}&mode=${mode}&amount=${amount}`, 
        cancel_url: `${CLIENT_DOMAIN}/cancel.html`,
    };

    // Add line item
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