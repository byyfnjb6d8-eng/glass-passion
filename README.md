# Gläserne Leidenschaft

A members-only web shop and order-management site for **Gläserne Leidenschaft** — a glass-ornament and Christmas-decoration studio in Lauscha, Germany ("Glas & Weihnachtsschmuck der besonderen Art").

The site is a self-contained static front end backed by [Supabase](https://supabase.com/) (authentication, Postgres, Row-Level Security, and RPC functions). It is bilingual (German / English) and access-gated.

---

## Stack

| Layer | Technology |
|---|---|
| Front end | Single-file static HTML/CSS/JS (no build step) |
| Backend | Supabase — Auth, Postgres, Row-Level Security (RLS), SECURITY DEFINER RPCs |
| PDF generation | [jsPDF](https://github.com/parallax/jsPDF) + jsPDF-AutoTable (order confirmations & invoices) |
| Fonts | Self-hosted `woff2` (Cinzel, Cormorant Garamond, DM Mono) in [`/fonts`](fonts) |
| Hosting | Static host serving the repo root, configured via [`_headers`](_headers) |

> **Security model:** the inlined Supabase **anon** key is public by design — the database is protected by Row-Level Security and SECURITY DEFINER RPCs, not by hiding the key. Never place a Supabase **service-role** key in this repository.

---

## Repository layout

```
.
├── index.html        # The entire application (storefront, accounts, admin panel,
│                     # document archive, lottery, i18n, PDF generation) — all
│                     # CSS and JS are inline.
├── order.html        # Standalone read-only order viewer. Opened by customers via
│                     # a tokenised link (?t=<token>) that calls the
│                     # get_order_by_view_token RPC.
├── _headers          # Host headers config. Forces revalidation of the app shell
│                     # so visitors never get a stale cached page.
├── fonts/            # Self-hosted web fonts (woff2).
└── README.md
```

---

## Features

- **Storefront & ordering** — product catalogue, per-user and per-product quantity caps, gift items, limited-edition showcase, and a lottery for limited editions.
- **Accounts** — Supabase email/password auth, member approval workflow, order history.
- **Admin panel** — capability-based admin access (products, orders, members, vault, lottery, season, and admin management), driven by a `capabilities` model.
- **Document archive ("vault")** — password-gated gallery of past collections / documents.
- **PDF documents** — order confirmations and invoices generated client-side with jsPDF.
- **Internationalisation** — German / English via an in-page translation table (`T[lang]` / `t()`).
- **Payments** — handled off-site via manual PayPal invoicing; the site stores only the customer's PayPal email, not card data.

---

## Configuration

Runtime configuration lives **inline in `index.html`** (and `order.html`):

- **Supabase URL + anon key** — public; the same values are re-declared for the access gate and the main app.
- **Access gate** — the "under construction" screen. The visible gate is toggled client-side via the `GATE_DISABLED` flag in `index.html`; the access code itself is verified server-side by the `verify_gate_code` RPC (the client never learns the code).
- **Archive password** — verified server-side via the `verify_archive_password` RPC.

Code is organised by inline `Phase X.YY` comment markers that document the history and intent of each change.

---

## Local development

There is no build step. To run locally, serve the repo root with any static file server (so that absolute paths like `/fonts/...` resolve):

```bash
# from the repo root
python3 -m http.server 8080
# then open http://localhost:8080/
```

The page talks to the **live** Supabase backend, so most flows (auth, orders, admin) require a real account and network access. The access gate appears first; unlock state is cached per browser session.

---

## Deployment

The site deploys as static files from the repository root. The [`_headers`](_headers) file sets `Cache-Control: public, max-age=0, must-revalidate` on the app shell so that an updated deploy is picked up immediately (the host serves `304 Not Modified` when nothing changed).

> When changing hosts or adding new configuration (e.g. security headers, redirects), update `_headers` to match the target platform's supported syntax.

---

## Internal documentation

> ⚠️ **This repository's root is the deploy/publish directory.** Every file committed here — on **any** branch, in any format (including `.md`) — can be fetched publicly from the live site. On both Netlify and Cloudflare Pages, preview/branch deployments are created automatically for non-production branches and published at public, unauthenticated URLs, so a "non-deployed" branch is **not** a safe hiding place by default. A private GitHub repo being private does **not** make the deployed site private — they are separate surfaces.

Therefore, engineering reviews, security findings, and remediation plans are kept **outside this repository** — in a separate private repository that is not connected to the static host, or in an access-controlled store. Never commit sensitive internal documents to this repo.
