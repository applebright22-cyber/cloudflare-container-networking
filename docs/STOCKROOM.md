# Stockroom business database

Stockroom replaces the former Studio Cockpit navigation entry. It is the account-scoped product and inventory workspace.

## Database lifecycle

- A business account signup creates its own `BusinessDatabase` Durable Object and initializes its SQLite schema before signup provisioning is accepted.
- Each account maps to a separate Durable Object ID derived from its immutable `acct-...` account ID. One business cannot select another business's database through the public API.
- The schema is idempotent. Opening Studio, opening Stockroom, or launching TinyCore runs the initialize check in the background; existing product rows are preserved.
- The TinyCore VM host page sends the authenticated initialize request as the guest starts. This does not wait for the database before Linux boot continues.
- Account deletion purges the associated business database along with account project and VM data.

## Storage boundary and TinyCore host mode

The original Cloudflare SQLite-backed Durable Object remains the default backend until the TinyCore host is configured. A TinyCore-hosted backend is included in `tinycore/stockroom/`: a Python 3 standard-library HTTP API with one SQLite file per business account.

To activate it, configure Worker variable `STOCKROOM_ORIGIN` with the HTTPS origin of the TinyCore service and Worker secret `STOCKROOM_GATEWAY_TOKEN`. Set the same token in the TinyCore host environment. With both values present, signup initialization, Stockroom CRUD, public storefront catalogs, checkout catalog reads, inventory deductions, and account cleanup route to TinyCore. The Worker authenticates user sessions before forwarding. Without both settings, the existing Durable Object backend remains active.

Run this on an always-on TinyCore host, not the browser's temporary v86 session. Install Python 3, copy `tinycore/stockroom/` to `/opt/stockroom`, put the database directory on a persistent mounted disk, and source `bootlocal-stockroom.sh` from `/opt/bootlocal.sh` after the disk is mounted. Keep the service bound to localhost and place a TLS reverse proxy or Cloudflare Tunnel in front of it. Do not expose port 8787 directly.

**Migration warning:** switching on TinyCore mode does not automatically copy existing Durable Object product or inventory records. Back up and migrate existing Stockroom data before configuring the Worker origin. Writes made in TinyCore mode are not synchronized back to the old backend. Removing either Worker setting selects the old backend again.

## Product schema

The `products` table stores product ID, unique SKU, name, description, category, image URL, selling price, cost price, quantity, status, variations JSON, optional external URL, and timestamps. Prices are stored as integer cents. The `inventory_movements` table records initial stock, quantity adjustments, and paid-order deductions. The `inventory_consumptions` table makes each checkout deduction idempotent.

## Authenticated API

All routes require the account ID in the query string and the user's session token in an Authorization Bearer header.

- `POST /api/stockroom/initialize?account_id=...` — initialize or verify schema.
- `GET /api/stockroom/products?account_id=...` — list products and inventory summary.
- `POST /api/stockroom/products?account_id=...` — create a product.
- `PUT /api/stockroom/products/:id?account_id=...` — update product details or stock.
- `DELETE /api/stockroom/products/:id?account_id=...` — archive a product.
- `GET /api/stockroom/movements?account_id=...` — recent inventory movements.
- `GET /api/stockroom/public/:published_site_id` — read-only active catalog for that published store.

The Worker validates the session against the existing AccountRegistry before routing private requests to the account's database object. Published storefronts receive a separate read-only public catalog containing only active product details; cost prices and exact stock counts are never exposed. PayPal/USDC checkout prices and available quantities are re-read from Stockroom on the server, and confirmed payment triggers an idempotent stock deduction. The Durable Object binding is not exposed to browsers.

## Deploy

Both `wrangler.toml` files declare the `BUSINESS_DATABASE` binding and SQLite storage export, following the repository's existing Durable Object configuration style. Deploy through the repository's existing Cloudflare-connected GitHub workflow. Confirm the deployment completes before testing signup or Stockroom.
