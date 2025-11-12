// --- GLOBAL CONFIGURATION ---
const CLIENT_DOMAIN = 'https://pay-dorothy-cole.pages.dev';

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
     * Routes requests to the correct handler function.
     */
    async fetch(request, env) {
        
        // Handle CORS preflight requests
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
// === HANDLER: DUPLICATE CHECK ====================================
// =================================================================

/**
 * Checks Stripe for existing Payment Intents associated with the invoice ID.
 * Filters results by status ('succeeded' or 'processing') in JavaScript.
 */
async function handleCheckDuplicateInvoice(request, env) {
    const { invoiceId } = await request.json();

    if (!invoiceId) {
        return new Response(JSON.stringify({ error: 'Invoice ID is required for check.' }), { status: 400, headers: corsHeaders });
    }

    // Simplified query: Search for the Invoice ID in metadata
    // NOTE: stripe.com/v1/payment_intents/search uses URL encoding rules for the query string.
    const query = `metadata["invoice_number"]:"${encodeURIComponent(invoiceId)}"`;

    const searchRes = await fetch(`https://api.stripe.com/v1/payment_intents/search?query=${query}`, {
        headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const searchData = await searchRes.json();

    if (searchRes.ok && searchData.data) {
        // Filter the results in JavaScript for the required statuses
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
        // Returns generic failure message
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
    // Search for an existing customer by email
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
        // Stripe payment methods are configured to prioritize us_bank_account, link, then card
        'payment_method_types[0]': 'us_bank_account',
        'payment_method_types[1]': 'link',
        'payment_method_types[2]': 'card',
        mode: mode,
        customer: customerId,
        client_reference_id: customerId,
        
        // Ensures name is collected if missing
        'customer_update[name]': 'auto',
        
        // Attach the Invoice ID as metadata on the Payment Intent
        'payment_intent_data[metadata][invoice_number]': invoiceId,
        
        // Success URL passes the amount, session ID, AND THE INVOICE ID
        success_url: `${CLIENT_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}&mode=${mode}&amount=${amount}&invoice_id=${encodeURIComponent(invoiceId)}`, 
        
        // Cancel URL now passes the original form data back to be pre-filled
        cancel_url: `${CLIENT_DOMAIN}/cancel.html?email=${encodeURIComponent(email)}&amount=${(amount / 100).toFixed(2)}&invoice_id=${encodeURIComponent(invoiceId)}`,
    };

    // Add line item details (Price Data)
    params['line_items[0][quantity]'] = '1';
    params['line_items[0][price_data][currency]'] = 'usd';
    
    // Use the invoice ID in the name for clarity
    params['line_items[0][price_data][product_data][name]'] = `Invoice #${invoiceId}`;
    
    // Add the descriptive message
    params['line_items[0][price_data][product_data][description]'] = PAYMENT_DESCRIPTION;

    // Use the amount in cents
    params['line_items[0][price_data][unit_amount]'] = amount.toString();
    
    // 3. CREATE SESSION
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
        // Provide a meaningful error message from Stripe if available
        return new Response(
            JSON.stringify({ error: sessionData.error ? (sessionData.error.message || 'Stripe API request failed.') : 'Internal server error' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
    }
}