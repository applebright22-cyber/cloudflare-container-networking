# Inventory reservations and offline order queue

## Purpose

The inventory ledger is the always-available online authority for each business. Stockroom remains the detailed local inventory/POS application on that business's TinyCore machine. The ledger is not a shared inventory database: each business receives a separate SQLite-backed Durable Object selected by its immutable account ID.

This prevents a storefront from reading inventory directly from a TinyCore machine that may be powered off.

## Checkout lifecycle

1. Stockroom product create/update/archive operations synchronize a versioned catalog snapshot to the account's inventory ledger.
2. Public checkout reads the ledger catalog, not the TinyCore host.
3. Before a checkout URL is issued, the ledger atomically checks available stock and creates a time-limited reservation (30 minutes by default).
4. The checkout record stores the reserved item names, quantities, and server-controlled prices.
5. PayPal capture or verified USDC payment commits the reservation. The ledger deducts the reserved quantities and creates a durable `pending_sync` order.
6. The payment record reports `queued_for_tinycore_sync`. This means payment is confirmed and the local Stockroom update is waiting to be synchronized; it does not mean the local database has already been updated.
7. Expired reservations are released lazily during catalog reads and new reservation requests. A checkout cannot commit an expired reservation.

The ledger rechecks quantities at reservation time, so two simultaneous customers cannot reserve the same final unit. Repeated reservation requests for the same checkout ID return the original reservation. Repeated payment commits return the original order ID.

## Inventory accounting

For each product:

- `on_hand`: central quantity not yet consumed by committed online or offline sales.
- `offline_allocated`: quantity set aside exclusively for local POS sales while TinyCore is disconnected.
- `online_reserved`: sum of unexpired online checkout reservations.

Online availability is:

`max(0, on_hand - offline_allocated - online_reserved)`

An offline allocation is created while TinyCore is connected. It reduces online availability immediately. A disconnected POS may sell only from that allowance. Each offline sale must have a unique event ID and order ID; the ledger consumes the allowance once and queues the sale for reconciliation. Replaying an event is idempotent.

Never allocate more units than the currently unallocated stock. If the allowance is exhausted while offline, the POS must stop selling that product until it reconnects or has a new allocation.

## Catalog synchronization safety

Catalog snapshots include the source product `updated_at` value. Older snapshots are ignored so that a delayed TinyCore sync cannot restore quantities already consumed by central online sales. A newer local quantity update is rejected if it would place on-hand stock below existing offline allocations plus active online reservations.

The local sync client must apply queued central orders before publishing a newer local stock adjustment. Otherwise a legitimate but stale local count could conflict with sales that happened while the machine was offline.

## Internal ledger API

These routes are internal to the per-business InventoryLedger Durable Object. The Worker resolves the object using the authenticated business account ID.

- `PUT /catalog/sync` — upsert versioned Stockroom catalog rows.
- `GET /catalog` — list active products with online-available quantities.
- `POST /reserve` — reserve quantities for one checkout.
- `POST /release` — release an active checkout reservation.
- `POST /commit` — commit a paid reservation and create a `pending_sync` order.
- `POST /offline/allocate` — reserve inventory for a disconnected POS.
- `POST /offline/consume` — record an offline POS sale against its allowance.
- `GET /orders` — read pending local-sync orders.
- `POST /orders/ack` — acknowledge orders after the local database has applied them.

No browser receives a direct Durable Object binding. Public checkout only reaches the controlled Worker payment route.

## Current implementation boundary

This change establishes the central reservation authority, catalog mirror, offline allocation accounting, and durable order outbox. The next integration step is the TinyCore reconnect worker: it must fetch pending orders, apply them transactionally to the local SQLite Stockroom database, then acknowledge the exact order IDs. Until that reconnect worker and its retry behavior are implemented and tested on a real TinyCore host, this is a backend foundation—not a claim that automatic local reconciliation is already complete.

## Deployment

Source changes are committed to GitHub only. Do not run `wrangler deploy` or deploy a Worker as part of this change. The new `INVENTORY_LEDGER` SQLite Durable Object binding must be provisioned by the platform deployment owner before the online ledger can run in a deployed environment.
