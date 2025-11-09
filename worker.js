// --- GLOBAL CONFIGURATION ---
const CLIENT_DOMAIN = 'https://stripe-ach-checkout.pages.dev';

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
            // --- THE ONLY PUBLIC ENDPOINT ---
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
// === HANDLER FUNCTION (UPDATED) ==================================
// =================================================================


/**
 * HANDLES CREATING A NEW CHECKOUT SESSION 
 */
async function handleCreateCheckoutSession(request, env) {
    // UPDATED: Read invoiceId from the request body
    const { amount, email, invoiceId } = await request.json();

    if (!email || !amount || amount <= 0) {
        return new Response(JSON.stringify({ error: 'Missing email or amount' }), { status: 400, headers: corsHeaders });
    }

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
        
        // ADDED: Request customer name if missing from Stripe record
        'customer_update[name]': 'auto', 
        
        // ADDED: Associate the Invoice ID as metadata on the Payment Intent
        'payment_intent_data[metadata][invoice_number]': invoiceId || '', // Use invoiceId or empty string
        
        // Removed: 'payment_intent_data[setup_future_usage]': 'off_session' (Fixes duplicate PM creation)
        
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