# VampireSquid merchant payments setup

## Cloudflare secret (required before connecting PayPal)

The Worker encrypts each merchant's PayPal REST client secret with AES-256-GCM before storing it in the account-scoped R2 record. The encryption key must be a base64-encoded 32-byte random value and must be stored as a Worker secret, never in source control or browser storage.

From PowerShell, generate a key:

```powershell
$key = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$key
```

In the Cloudflare dashboard, open **Workers & Pages → cloudflare-container-networking → Settings → Variables and Secrets**, add a secret named `PAYMENTS_ENCRYPTION_KEY`, and paste the generated value. Redeploy the Worker after adding the secret. Keep a secure backup of this key: losing it makes previously stored merchant PayPal secrets undecryptable.

## Merchant PayPal setup

Each merchant uses their own PayPal Business account:

1. Sign in to the PayPal Developer Dashboard with that account.
2. Create a REST app in **Sandbox** first.
3. Copy that app's Client ID and Secret into **VampireSquid Studio → Settings → Merchant payment connections**.
4. Keep the environment set to Sandbox until checkout testing is complete.
5. Switch to Live and enter the Live app credentials only when the merchant is ready to accept real payments.

The connection endpoint validates credentials by requesting a PayPal OAuth access token. The secret is encrypted at rest and is never returned to Studio. The checkout page loads the official PayPal JavaScript SDK; the Worker creates and captures Orders API orders using the merchant's credentials.

## Current publishing behavior

Studio's Publishing view uploads the generated page HTML to account-authenticated Worker routes and stores it in R2. Published pages are served at `/sites/{opaque-publish-id}/` on the Worker domain and do not depend on the TinyCore VM remaining online.

Custom-domain mapping, multi-file static asset publishing, and an automated TinyCore-to-publish build handoff are not part of this first publishing increment yet.

## Published Store checkout (PayPal)

The Store template renders a real cart and sends product IDs and quantities to the public checkout endpoint on the published site. The Worker reads the published page's product catalog, validates product IDs and quantities, calculates the total server-side, creates an account-scoped checkout record, and returns the hosted checkout URL. Customers are redirected to `/checkout.html`, where the official PayPal JavaScript SDK approves the order. The Worker creates and captures the PayPal order with the merchant's own REST credentials and confirms the completed USD capture amount before marking the checkout paid.

The browser-provided cart total is never used as the amount charged. Product prices are read from the published catalog. Store checkout is PayPal-only at this stage; the Store template does not claim to accept crypto.

To test:
1. Configure `PAYMENTS_ENCRYPTION_KEY` as a Worker secret.
2. Connect a merchant PayPal Sandbox REST app in Studio → Settings → Merchant payment connections.
3. Enable PayPal payment settings.
4. Create a Store project and publish it.
5. Open the published site, add products to the bag, and complete a Sandbox checkout using PayPal Sandbox buyer credentials.
6. Verify the checkout status is `paid` only after the server confirms a completed capture.

## Payment boundaries and remaining production work

PayPal supports a merchant-owned REST app, SDK approval UI, server-side order creation, server-side capture, and capture amount/status verification. This is not PayPal partner onboarding; marketplace/partner onboarding, platform fees, and split payouts require separate PayPal approval and integration.

The current Store catalog is sourced from the published HTML. A production catalog editor and normalized server-side product/order database are still needed before large catalogs, stock reservations, tax/shipping, refunds, subscriptions, or multi-currency commerce. Checkout records are stored in R2; the platform does not yet provide a complete merchant order-management screen, PayPal webhook reconciliation, or refund controls.

Crypto remains the separate Base USDC wallet/manual transaction-hash flow. The published Store template currently enables PayPal checkout only.
