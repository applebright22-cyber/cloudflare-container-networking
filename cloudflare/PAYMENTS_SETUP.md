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

## Current payment scope

PayPal supports a merchant-owned REST app, SDK approval UI, server-side order creation, server-side capture, and capture amount/status verification. The current product is not PayPal partner onboarding; that still requires PayPal approval.

Crypto remains the existing Base USDC wallet/manual transaction-hash flow. Store product catalogs, trusted server-side price lookup, embedded cart/checkout in generated Store templates, order-management screens, webhook reconciliation, and platform fees still need implementation before describing the full commerce platform as complete.
