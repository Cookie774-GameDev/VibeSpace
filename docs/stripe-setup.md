# Stripe Setup (Test Mode)

Use **test mode** only until launch. No live charges during setup/testing.

## 1. Create products + recurring prices

In the Stripe dashboard (test mode) → Products, create three monthly prices:

| Plan | Price | Note |
|------|-------|------|
| Starter | $10.00 / month | 2,500 AI message credits + 25 call min |
| Pro | $50.00 / month | 12,500 credits + 125 call min |
| Ultra | $100.00 / month | 25,000 credits + 250 call min |

Copy each **Price ID** (`price_...`).

## 2. Set Supabase secrets

```powershell
npx supabase secrets set STRIPE_SECRET_KEY="sk_test_..."
npx supabase secrets set STRIPE_STARTER_PRICE_ID="price_..."
npx supabase secrets set STRIPE_PRO_PRICE_ID="price_..."
npx supabase secrets set STRIPE_ULTRA_PRICE_ID="price_..."
npx supabase secrets set APP_BASE_URL="https://vibespaceos.com"
```

## 3. Create the webhook endpoint

Stripe dashboard → Developers → Webhooks → Add endpoint:

```
https://tipeobvisjqvpbzcpckh.supabase.co/functions/v1/stripe-webhook
```

Select events:
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_succeeded`, `invoice.payment_failed`.

Copy the signing secret and set it:

```powershell
npx supabase secrets set STRIPE_WEBHOOK_SECRET="whsec_..."
```

## 4. Deploy

```powershell
npx supabase functions deploy create-checkout-session create-customer-portal
npx supabase functions deploy stripe-webhook --no-verify-jwt
```

## 5. Test (test mode)

- Use Stripe CLI to forward events: `stripe listen --forward-to <webhook url>`.
- Use test card `4242 4242 4242 4242`.
- The app sends only a **plan name** (`starter`/`pro`/`ultra`); the price is
  resolved server-side. Frontend-supplied prices are ignored.

## Security guarantees (implemented)

- Webhook signature verified against the **raw** request body; invalid/modified
  bodies → 400.
- Idempotent: each `event.id` is inserted into `subscription_events` with a
  unique constraint, so duplicates can't double-credit.
- Plan is derived **only** from the Stripe price ID server-side.
- Paid benefits are granted only after Stripe confirms (`profiles.tier` update
  fires the usage-seeding triggers). `invoice.payment_failed` reverts to free.

## Blocked until you provide

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the three price IDs.
- A real test checkout + webhook round-trip (needs the above).
