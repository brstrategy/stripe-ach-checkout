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

    const url = new URL(request.url);
    const pathname = url.pathname;
    const jsonHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    try {
      if (pathname === '/create-checkout-session') {
        const { amount, email } = await request.json();

        if (!amount || amount <= 0) {
          return new Response(JSON.stringify({ error: 'Invalid amount provided.' }), {
            status: 400,
            headers: jsonHeaders,
          });
        }

        const params = new URLSearchParams();

        params.append('payment_method_types[]', 'us_bank_account');
        params.append('mode', 'payment');
        params.append('line_items[0][price_data][currency]', 'usd');
        params.append('line_items[0][price_data][unit_amount]', amount);
        params.append('line_items[0][price_data][product_data][name]', 'Client Payment');
        params.append('line_items[0][price_data][product_data][description]', 'Payment for professional services.');
        params.append('line_items[0][quantity]', '1');
        params.append('payment_intent_data[setup_future_usage]', 'off_session');

        // URLs
        params.append('success_url', `${new URL(request.url).origin}/success.html?session_id={CHECKOUT_SESSION_ID}`);
        params.append('cancel_url', `${new URL(request.url).origin}/cancel.html`);

        if (email) {
          params.append('customer_email', email);
        }

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
          throw new Error(session.error ? session.error.message : 'Stripe API error');
        }

        return new Response(JSON.stringify({ id: session.id }), {
          headers: jsonHeaders,
        });
      }
      // Updated API: create customer with check for existing
      else if (pathname === '/create-customer') {
        const { email } = await request.json();
        if (!email) {
          return new Response(JSON.stringify({ error: 'Email is required' }), {
            status: 400,
            headers: jsonHeaders,
          });
        }

        // Check for existing customer with this email
        const listResponse = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}`, {
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
          },
        });
        const listData = await listResponse.json();

        if (listResponse.ok && listData.data && listData.data.length > 0) {
          // Customer exists
          const existingCustomerId = listData.data[0].id;

          // Optionally: fetch existing payment methods
          const paymentMethodsResponse = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${existingCustomerId}&type=us_bank_account`, {
            headers: {
              'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            },
          });
          const paymentMethodsData = await paymentMethodsResponse.json();

          // Return existing customer ID and payment methods
          return new Response(JSON.stringify({
            customerId: existingCustomerId,
            paymentMethods: paymentMethodsData.data || [],
          }), {
            headers: jsonHeaders,
          });
        } else {
          // Create new customer
          const createResponse = await fetch('https://api.stripe.com/v1/customers', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ email }),
          });
          const createData = await createResponse.json();
          if (!createResponse.ok) {
            throw new Error(createData.error ? createData.error.message : 'Stripe API error');
          }
          // Return new customer ID, no existing payment methods
          return new Response(JSON.stringify({ customerId: createData.id, paymentMethods: [] }), {
            headers: jsonHeaders,
          });
        }
      }
      // create setup intent
      else if (pathname === '/create-setup-intent') {
        const { customerId } = await request.json();
        if (!customerId) {
          return new Response(JSON.stringify({ error: 'Customer ID is required' }), {
            status: 400,
            headers: jsonHeaders,
          });
        }

        const response = await fetch('https://api.stripe.com/v1/setup_intents', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            'customer': customerId,
            'payment_method_types[]': 'us_bank_account',
          }),
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error ? data.error.message : 'Stripe API error');
        }

        return new Response(JSON.stringify({ clientSecret: data.client_secret }), {
          headers: jsonHeaders,
        });
      }
      // charge using stored payment method
      else if (pathname === '/charge') {
        const { customerId, paymentMethodId, amount } = await request.json();
        if (!customerId || !paymentMethodId || !amount || amount <= 0) {
          return new Response(JSON.stringify({ error: 'Missing or invalid parameters' }), {
            status: 400,
            headers: jsonHeaders,
          });
        }

        const response = await fetch('https://api.stripe.com/v1/payment_intents', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            'amount': amount,
            'currency': 'usd',
            'customer': customerId,
            'payment_method': paymentMethodId,
            'off_session': 'true',
            'confirm': 'true',
          }),
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error ? data.error.message : 'Stripe API error');
        }

        return new Response(JSON.stringify({ success: true, paymentIntentId: data.id }), {
          headers: jsonHeaders,
        });
      } else {
        return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: jsonHeaders,
      });
    }
  },
};