export default {
  async fetch(request, env) {
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

    const url = new URL(request.url);
    const pathname = url.pathname;
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    try {
      if (pathname === '/create-checkout-session') {
        const { amount, email } = await request.json();

        const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            payment_method_types: 'us_bank_account,card',
            mode: 'setup', // Link bank account without charge
            line_items: JSON.stringify([{
              price_data: {
                currency: 'usd',
                product_data: { name: 'Client Payment' },
                unit_amount: amount,
              },
              quantity: 1,
            }]),
            customer_email: email,
            success_url: `${new URL(request.url).origin}/success.html`,
            cancel_url: `${new URL(request.url).origin}/cancel.html`,
          }),
        });

        const sessionData = await response.json();

        // Debugging: log the Stripe response
        console.log('Stripe session data:', sessionData);

        if (sessionData.id) {
          return new Response(JSON.stringify({ id: sessionData.id }), { headers });
        } else {
          console.error('Stripe API error:', sessionData);
          return new Response(JSON.stringify({ error: 'Failed to create session' }), { status: 500, headers });
        }
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      console.error('Error in fetch handler:', e);
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }
};