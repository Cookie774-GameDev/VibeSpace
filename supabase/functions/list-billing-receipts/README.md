# Billing receipts

Read-only, authenticated `POST` endpoint. It ignores request-body identities, verifies the caller with Supabase Auth, looks up that user's protected `profiles.stripe_customer_id`, and returns at most 24 finalized Stripe invoices. No charges, subscriptions, prices, webhooks, or database records are changed.

Deployment prerequisites: the existing `0015_protect_billing_columns.sql` migration must be applied, and the existing Supabase URL/anon/service-role and Stripe credentials must be configured on the server. Never put Stripe credentials in the frontend. Keep JWT verification enabled. Deployment requires the user's separate authorization; this source change does not deploy the function.

The Billing tab refreshes on entry, on explicit Refresh, or when it regains focus after 30 seconds. A new or newly paid invoice feeds through the printer. Final bill selects a non-void finalized invoice whose recorded period has ended. This is not an estimated monthly total, a live usage calculator, or a new payment workflow. Purchases without Stripe invoices do not produce invented receipts.

The D: test profile is signed out. Its sign-in gate can be checked live; real-account receipt and paid-renewal acceptance require a signed-in account and the deployed endpoint. No real purchase is needed merely to view an existing invoice.

References: [Stripe invoices](https://docs.stripe.com/api/invoices/list), [currency units](https://docs.stripe.com/currencies), [Supabase authentication](https://supabase.com/docs/guides/functions/auth-legacy-jwt). The printer motion is independently implemented from the user's [visual reference](https://www.dqnamo.com/experiments/receipt-printer); no upstream component source was vendored.

Check the pure handler with `node --test supabase/functions/list-billing-receipts/handler.test.ts`; frontend tests live alongside the receipt component and client.
