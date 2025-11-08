export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // Or your specific domain
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      // Handle preflight CORS request
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/create-checkout-session') {
        const { amount, email } = await request.json();

        const bodyParams = new URLSearchParams({
          payment_method_types: 'us_bank_account,card',
          mode: 'setup',
          line_items: JSON.stringify([{
            price_data: {
              currency: 'usd',
              product_data: { name: 'Client Payment' },
              unit_amount: amount,
            },
            quantity: 1,
          }]),
          customer_email: email,
          success_url: `${url.origin}/success.html`,
          cancel_url: `${url.origin}/cancel.html`,
        }).toString();

        const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: bodyParams,
        });

        const sessionData = await response.json();

        if (response.ok && sessionData.id) {
          return new Response(
            JSON.stringify({ id: sessionData.id }),
            { headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        } else {
          console.error('Stripe API error:', sessionData);
          return new Response(
            JSON.stringify({ error: sessionData.error || 'Stripe error' }),
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