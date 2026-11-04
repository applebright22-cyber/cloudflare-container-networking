# Stockroom business database

Stockroom replaces the former Studio Cockpit navigation entry. It is the account-scoped product and inventory workspace.

## Database lifecycle

- A business account signup creates its own `BusinessDatabase` Durable Object and initializes its SQLite schema before signup provisioning is accepted.
- Each account maps to a separate Durable Object ID derived from its immutable `acct-...` account ID. One business cannot select another business's database through the public API.
- The schema is idempotent. Opening Studio, opening Stockroom, or launching TinyCore runs the initialize check in the background; existing product rows are preserved.
- The TinyCore VM host page sends the authenticated initialize request as the guest starts. This does not wait for the database before Linux boot continues.
- Account deletion purges the associated business database along with account project and VM data.

## Storage boundary

The first implementation uses Cloudflare SQLite-backed Durable Objects for the business database. Cloudflare persists this data independently of the browser and TinyCore VM snapshot. It is **not** an Oracle-hosted PostgreSQL service: the existing Oracle executor remains a separate Linux command/runtime service. Moving the SQL engine onto Oracle would require a separately deployed PostgreSQL service and an authenticated provisioning bridge.

## Product schema

The `products` table stores product ID, unique SKU, name, description, category, image URL, selling price, cost price, quantity, status, variations JSON, optional external URL, and timestamps. Prices are stored as integer cents. The `inventory_movements` table records initial stock and quantity adjustments.

## Authenticated API

All routes require the account ID in the query string and the user's session token in an Authorization Bearer header.

- `POST /api/stockroom/initialize?account_id=...` — initialize or verify schema.
- `GET /api/stockroom/products?account_id=...` — list products and inventory summary.
- `POST /api/stockroom/products?account_id=...` — create a product.
- `PUT /api/stockroom/products/:id?account_id=...` — update product details or stock.
- `DELETE /api/stockroom/products/:id?account_id=...` — archive a product.
- `GET /api/stockroom/movements?account_id=...` — recent inventory movements.

The Worker validates the session against the existing AccountRegistry before routing to the account's private database object. The Durable Object binding is not exposed to browsers.

## Deploy

Both `wrangler.toml` files declare the `BUSINESS_DATABASE` binding and SQLite storage export, following the repository's existing Durable Object configuration style. Deploy through the repository's existing Cloudflare-connected GitHub workflow. Confirm the deployment completes before testing signup or Stockroom.
