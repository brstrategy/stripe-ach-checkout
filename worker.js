// worker.js

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Only handle POST to /create-checkout-session
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/create-checkout-session') {
      return new Response('Not Found', { status: 404 });
    }

    const jsonHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    try {
      const { amount, email } = await request.json();

      if (!amount || amount <= 0) {
        return new Response(JSON.stringify({ error: 'Invalid amount provided.' }), {
          status: 400,
          headers: jsonHeaders,
        });
      }

      // Prepare form data for Stripe API
      const params = new URLSearchParams();

      // Payment method types
      params.append('payment_method_types[]', 'us_bank_account');
      
      // Mode
      params.append('mode', 'payment');

      // Line item
      params.append('line_items[0][price_data][currency]', 'usd');
      params.append('line_items[0][price_data][unit_amount]', amount);
      params.append('line_items[0][price_data][product_data][name]', 'Client Payment');
      params.append('line_items[0][price_data][product_data][description]', 'Payment for professional services.');
      params.append('line_items[0][quantity]', '1');

      // Payment intent data
      params.append('payment_intent_data[setup_future_usage]', 'off_session');

      // URLs
      params.append('success_url', `${new URL(request.url).origin}/success.html?session_id={CHECKOUT_SESSION_ID}`);
      params.append('cancel_url', `${new URL(request.url).origin}/cancel.html`);
      
      // Include customer_email if email provided
      if (email) {
        params.append('customer_email', email);
      }

      // Call Stripe API
      const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const session = await stripeResponse.json();

      if (!stripeResponse.ok) {
        // Stripe returned an error
        throw new Error(session.error ? session.error.message : 'Stripe API error');
      }

      // Return the session ID
      return new Response(JSON.stringify({ id: session.id }), {
        headers: jsonHeaders,
      });
    } catch (error) {
      console.error('Stripe API Error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: jsonHeaders,
      });
    }
  },
};