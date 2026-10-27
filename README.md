# Secret Flower Studio

## Order workflow setup

### 1. Configure the browser-safe Supabase settings

Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to this Supabase project's URL and **publishable/anon** key. These values are intended for browser use. Never place a service-role key, Resend key, or other private credential in a `VITE_` variable.

### 2. Apply the database migration

Apply all pending files in `supabase/migrations` to the project's database, in timestamp order, either through the Supabase SQL editor or with the Supabase CLI (`supabase login`, then `supabase db push`). The checked-in Supabase config targets this project's ref. The migration upgrades the former `orders` table, preserves existing records and backfills their available JSON item and note snapshots, creates normalized `order_items` and `order_notes`, enables RLS, and removes anonymous order-table insertion. New orders are inserted through the `create_flower_order` transaction, which reprices from server-side catalog prices, allocates a per-day `SC-YYYYMMDD-NNN` number under a row lock, and saves the order, item snapshots, notes, and recipient contacts atomically.

### 3. Deploy the Edge Function

Deploy `supabase/functions/orders` as the `orders` Edge Function. `supabase/config.toml` disables the platform's JWT gate so customers can reach the public create action; the function itself verifies admin sessions against Supabase Auth before any list, demand, status, or email-retry action. Do not expose the service-role key. Set these secrets with the Supabase CLI or dashboard function secrets:

| Secret | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Project URL, available to the Edge Function runtime |
| `SUPABASE_ANON_KEY` | Yes | Used server-side to validate the admin access token |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Privileged database access, Edge Function only |
| `SITE_ORIGIN` | Recommended | Storefront origin for CORS, e.g. `https://your-store.example` |
| `RESEND_API_KEY` | Later | Resend API credential for customer confirmation emails |
| `ORDER_EMAIL_FROM` | Later | Verified sender, e.g. `Secret Flower Studio <orders@your-domain.example>` |

Until the Resend key and verified sender are configured, saved orders succeed and the customer sees the saved order number; email delivery is reported as not configured. If a configured send fails, the order stays saved and an authorized admin can retry from its detail panel.

### 4. Grant admin access

Create the studio owner's user in Supabase Auth and grant the server-controlled app metadata role `admin` (for example through the Supabase dashboard's user editor or a trusted server-side admin script). The role must be in `app_metadata`, never user-editable `user_metadata`. Visit `/admin` and sign in with that Supabase Auth account. The browser stores the session in session storage; database RLS and the Edge Function both restrict order access to authenticated admin claims.

### 5. Run locally

Use `npm install` and `npm run dev`, then visit `/` for the shop or `/admin` for administration. Configure the Edge Function secrets in the Supabase project and deploy it before testing checkout against the live project.

## Order and purchasing behavior

- Order numbers use the Colombo calendar date and a transaction-safe daily counter. The private UUID remains the internal order ID.
- Flower name, selected stem colors, stem quantity, wrap, price snapshot, order notes, purchaser contact details, and the intended recipient’s name and phone are saved with each order. Checkout does not collect street addresses because delivery is arranged for the scheduled day at the fixed delivery point. Catalog prices are recomputed by the database transaction so browser-submitted prices cannot alter totals.
- Statuses are `pending`, `confirmed`, `preparing`, `ready`, `fulfilled`, and `cancelled`. Purchasing demand counts every status except `cancelled`; the dashboard displays this rule.
- Demand totals are customer-requested stems and included/paid-extra note cards. They are not stock-on-hand and do not represent received inventory.
- The email sender is not active until `RESEND_API_KEY` and `ORDER_EMAIL_FROM` are set to real values for a verified domain.
