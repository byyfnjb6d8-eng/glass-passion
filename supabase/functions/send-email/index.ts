// ════════════════════════════════════════════════════════════════════════
// Gläserne Leidenschaft — Email Notifications Edge Function
// ════════════════════════════════════════════════════════════════════════
// Sends transactional email via Resend for these event types:
//   - account_approved              (to customer)
//   - account_denied                (to customer)
//   - order_placed                  (to customer AND admin — two emails)
//   - order_status_changed          (to customer)
//   - registration_pending          (to admin)
//   - payment_request               (to customer; Phase 6.21)
//   - order_cancelled_by_customer   (to customer + admin; Phase 6.28)
//   - order_cancelled_by_admin      (to customer; Phase 6.28)
//   - lottery_won                   (to customer + admin BCC; Phase 6.38)
//   - lottery_lost                  (to customer + admin BCC; Phase 6.38)
//   - lottery_send_results          (batch: per-entrant win/lose emails +
//                                     one consolidated admin summary; Phase 6.51 D2)
// Plus utility actions: delete_user, check_banned_email, unban_email.
// Note: password_reset is handled natively by Supabase Auth, not here.
//
// Phase 6.34b: Admin recipient list now comes from the public.admins table
// at runtime (single source of truth shared with the client). Add/remove
// admins via SQL — no redeploys of this function needed.
//
// Phase 6.58: (1) REPLY_TO + body contact addresses standardized on the
// glass-passion.com domain. (2) New "order approved" wording. (3) The approved
// email now links to the passwordless read-only order view at /order.html
// using orders.view_token (see order-view-setup.sql).
//
// Phase 6.59: payment_request now renders an itemized cost breakdown
// (Subtotal / Discount / Shipping / Tariffs / PayPal G&S fee) beneath the
// items table, mirroring the invoice PDF. The frontend passes the values in
// `paymentBreakdown`; discount/tariffs/fee lines appear only when non-zero.
// Backward compatible — if paymentBreakdown is absent, the email falls back
// to the previous single "Total due" line.
//
// Invoked from the client via:
//   sb.functions.invoke('send-email', { body: { type, orderId, userId } })
// ════════════════════════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ─── CONFIGURATION ──────────────────────────────────────────────────────
// Sender: must be an address on a Resend-verified domain.
const FROM_EMAIL = "Gläserne Leidenschaft <no-reply@glass-passion.com>";
// Where replies land. Must be a real monitored mailbox.
const REPLY_TO = "info@glass-passion.com";
// Customer-facing site URL.
const SITE_URL = "https://www.glass-passion.com";

// Brand palette for inline email styling
const GOLD = "#C9A84C";
const NAVY = "#1A3A5C";
const INK = "#1C1914";
const MUTED = "#6E6455";
const BG = "#FAF7F0";

// ─── CORS HEADERS ───────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── HANDLER ────────────────────────────────────────────────────────────
serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      return json({ error: "RESEND_API_KEY not configured" }, 500);
    }

    // Use the service-role Supabase client so we can read profiles/orders/admins
    // regardless of RLS (this function is trusted server-side code).
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const {
      type,
      orderId,
      userId,
      notifyUser,
      reason,
      // Phase 6.15: deletion audit + email bans
      ban,           // boolean: also ban this email from future registrations
      banReason,     // required when ban is true
      adminEmail,    // email of the admin performing the action (for audit trail)
      email,         // used by check_banned_email and unban_email
      unbanReason,   // required when calling unban_email
      // Phase 6.21: payment request email
      paymentAmount, // number in euros — final total including any shipping/tariffs/discount/fee
      paymentNote,   // optional: admin can add a note like "Please pay within 7 days"
      paymentItems,  // array of { name, euros } — frontend-resolved items (order_items lacks name/price)
      // Phase 6.59: itemized cost breakdown for the payment request email —
      // { subtotal, discountPercent, discountAmount, shipping, tariffs, gsFee }
      paymentBreakdown,
      leId,          // Phase 6.51 D2: limited-edition product id for lottery_send_results
    } = body;
    if (!type) return json({ error: "Missing `type`" }, 400);

    // Dispatch by event type
    let result;
    switch (type) {
      case "account_approved":
      case "account_denied":
        result = await handleAccountStatus(supabase, RESEND_API_KEY, userId, type);
        break;
      case "order_placed":
        result = await handleOrderPlaced(supabase, RESEND_API_KEY, orderId);
        break;
      case "order_status_changed":
        result = await handleOrderStatusChanged(supabase, RESEND_API_KEY, orderId);
        break;
      case "order_shipped":
        result = await handleOrderShipped(supabase, RESEND_API_KEY, orderId);
        break;
      case "registration_pending":
        result = await handleRegistrationPending(supabase, RESEND_API_KEY, userId);
        break;
      case "delete_user":
        result = await handleDeleteUser(supabase, RESEND_API_KEY, userId, !!notifyUser, reason, {
          ban: !!ban,
          banReason: banReason,
          adminEmail: adminEmail,
        });
        break;
      case "check_banned_email":
        result = await handleCheckBannedEmail(supabase, email);
        break;
      case "unban_email":
        result = await handleUnbanEmail(supabase, email, unbanReason, adminEmail);
        break;
      case "payment_request":
        result = await handlePaymentRequest(supabase, RESEND_API_KEY, orderId, paymentAmount, paymentNote, paymentItems, adminEmail, paymentBreakdown);
        break;
      case "order_cancelled_by_customer":
        result = await handleOrderCancelledByCustomer(supabase, RESEND_API_KEY, orderId);
        break;
      case "order_cancelled_by_admin":
        result = await handleOrderCancelledByAdmin(supabase, RESEND_API_KEY, orderId);
        break;
      case "lottery_won":
        result = await handleLotteryWon(supabase, RESEND_API_KEY, orderId);
        break;
      case "lottery_lost":
        result = await handleLotteryLost(supabase, RESEND_API_KEY, orderId);
        break;
      case "lottery_send_results":
        result = await handleLotterySendResults(supabase, RESEND_API_KEY, leId);
        break;
      default:
        return json({ error: `Unknown type: ${type}` }, 400);
    }
    return json(result, 200);
  } catch (err) {
    console.error("send-email error:", err);
    return json({ error: String(err?.message || err) }, 500);
  }
});

// ════════════════════════════════════════════════════════════════════════
// Phase 6.34b: Admin list lookup — replaces the previous hardcoded
// ADMIN_ALERT_RECIPIENTS constant. Reads from public.admins via the
// service-role client (bypasses RLS automatically). Returns lowercased
// emails. On error, returns an empty list (fail-closed: better to skip
// an alert than to crash the user-facing flow that triggered it).
// ════════════════════════════════════════════════════════════════════════
async function getAdminEmails(sb: any): Promise<string[]> {
  try {
    const { data, error } = await sb.from("admins").select("email");
    if (error) {
      console.warn("[getAdminEmails] query error:", error);
      return [];
    }
    return (data || [])
      .map((r: any) => String(r.email || "").toLowerCase().trim())
      .filter((e: string) => e !== "");
  } catch (e) {
    console.warn("[getAdminEmails] exception:", e);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════
// HANDLERS
// ════════════════════════════════════════════════════════════════════════

async function handleAccountStatus(sb: any, apiKey: string, userId: string, type: string) {
  if (!userId) throw new Error("Missing userId for account status email");
  const { data: profile, error } = await sb.from("profiles").select("*").eq("id", userId).single();
  if (error || !profile) throw new Error("Profile not found: " + (error?.message || userId));
  const first = profile.first_name || "there";

  if (type === "account_approved") {
    return sendEmail(apiKey, {
      to: profile.email,
      subject: "Your Gläserne Leidenschaft account has been approved",
      html: wrapEmail(`
        <h2 style="color:${NAVY};margin:0 0 16px">Welcome, ${escapeHtml(first)}!</h2>
        <p>Your account has been approved. You can now place orders on the Gläserne Leidenschaft site.</p>
        <p style="color:${MUTED};font-size:13px;font-style:italic;border-left:3px solid ${GOLD};padding:8px 0 8px 14px;margin:20px 0;background:${BG}">
          Please note: account approval does not guarantee that any individual order you place will be fulfilled. You will receive a separate confirmation email once your order has been processed and confirmed based on product availability.
        </p>
        <p style="margin:24px 0">
          <a href="${SITE_URL}" style="background:${GOLD};color:${INK};padding:12px 24px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;letter-spacing:1px;text-transform:uppercase;font-size:13px">Browse the Collection</a>
        </p>
        <p style="color:${MUTED};font-size:13px">Questions? Reply to this email or write to <a href="mailto:${REPLY_TO}" style="color:${NAVY}">${REPLY_TO}</a>.</p>
      `),
    });
  } else {
    return sendEmail(apiKey, {
      to: profile.email,
      subject: "Update on your Gläserne Leidenschaft account",
      html: wrapEmail(`
        <h2 style="color:${NAVY};margin:0 0 16px">Hello ${escapeHtml(first)},</h2>
        <p>Thank you for your interest in Gläserne Leidenschaft. Unfortunately, we were unable to approve your account at this time.</p>
        <p style="margin-top:24px">Kind regards,<br>Gläserne Leidenschaft</p>
        <p style="color:${MUTED};font-size:12px;font-style:italic;margin-top:20px;border-top:1px solid #e6dfce;padding-top:12px">
          This email is not monitored. Please do not reply.
        </p>
      `),
    });
  }
}

async function handleOrderPlaced(sb: any, apiKey: string, orderId: string) {
  if (!orderId) throw new Error("Missing orderId for order_placed email");
  // Phase 6.45c: pull denormalized snapshot fields (product_name/product_color/product_euros)
  // so the confirmation email can show the actual ornaments customers ordered,
  // plus the order's payment_type for inclusion in both customer + admin emails.
  // Phase 6.45c.1 (May 24 fix): column names corrected to match actual schema —
  // they are `product_name`, `product_color`, `product_euros` (NOT name_snapshot
  // etc., which was my mistake yesterday and caused every order email to fail
  // silently with "column ... does not exist"). Per ORDER_ITEMS_PROJECTION in
  // index.html line 5082.
  const { data: order, error } = await sb
    .from("orders")
    .select("*, order_items(product_id, product_name, product_color, product_euros, is_gift)")
    .eq("id", orderId)
    .single();
  if (error || !order) throw new Error("Order not found: " + (error?.message || orderId));

  const customerName = `${order.first_name || ""} ${order.last_name || ""}`.trim() || "customer";
  const firstName = order.first_name || "there";
  // Hide gift items from customer-facing email (Phase 6.29 "Option C")
  const customerItems = (order.order_items || []).filter((it: any) => !it.is_gift);
  const itemCount = customerItems.length;
  const subtotal = Number(order.total_euros || 0).toFixed(2);
  const orderRef = order.order_id || "(pending)";

  // Phase 6.45c.1: itemized rows using correct column names
  const itemRowsHtml = customerItems.map((it: any) => {
    const name = it.product_name || "—";
    const color = it.product_color || "";
    const price = typeof it.product_euros === "number"
      ? `€${Number(it.product_euros).toFixed(2)}`
      : "";
    return `<tr>
      <td style="padding:6px 0;font-family:Georgia,serif;font-size:14px;color:${INK}">
        ${escapeHtml(name)}${color ? `<div style="font-size:12px;color:${MUTED};margin-top:2px">${escapeHtml(color)}</div>` : ""}
      </td>
      <td style="padding:6px 0;font-family:Georgia,serif;font-size:14px;color:${INK};text-align:right;vertical-align:top">${price}</td>
    </tr>`;
  }).join("");

  const itemRowsText = customerItems.map((it: any) => {
    const name = it.product_name || "—";
    const color = it.product_color || "";
    const price = typeof it.product_euros === "number"
      ? `  €${Number(it.product_euros).toFixed(2)}`
      : "";
    return `  • ${name}${color ? ` (${color})` : ""}${price}`;
  }).join("\n");

  // Phase 6.45c: payment type display
  const paymentType = order.payment_type || "";
  let paymentTypeDisplay = "";
  let paymentTypeText = "";
  if (paymentType === "friends_family") {
    paymentTypeDisplay = "PayPal Friends &amp; Family";
    paymentTypeText = "PayPal Friends & Family";
  } else if (paymentType === "goods_services") {
    paymentTypeDisplay = "PayPal Goods &amp; Services (+5% fee)";
    paymentTypeText = "PayPal Goods & Services (+5% fee)";
  }
  const paymentTypeHtml = paymentTypeDisplay
    ? `<p style="margin:8px 0;color:${MUTED};font-size:13px"><strong>Payment type selected:</strong> ${paymentTypeDisplay}</p>`
    : "";
  const paymentTypeTextLine = paymentTypeText
    ? `\nPayment type selected: ${paymentTypeText}\n`
    : "";

  const itemsTableHtml = itemRowsHtml
    ? `<table style="width:100%;border-collapse:collapse;margin:8px 0 16px;border-top:1px solid #e6dfce;border-bottom:1px solid #e6dfce">${itemRowsHtml}</table>`
    : "";

  // Phase 6.50a: late-submission flag — surfaces a prominent warning at the
  // TOP of both customer and admin emails when the order was submitted past
  // the closing window (soft close).
  const isLate = !!order.submitted_after_window;
  // Phase 6.50b: over-cap flag. Suppressed when late is also true — late is
  // the stronger signal and both convey "not guaranteed". This keeps emails
  // from showing two stacked warnings.
  const isOverCap = !!order.submitted_at_or_over_global_cap && !isLate;
  const lateCustomerHtml = isLate
    ? `<div style="background:rgba(168,100,42,0.12);border-left:4px solid #a8642a;padding:14px;margin:0 0 16px;color:#a8642a;font-size:14px">
         <strong>⚠ Submitted after our ordering window closed.</strong><br>
         Your order is not guaranteed and may not be fulfilled. Mr. D and Ivonne will still review it and follow up by email.
       </div>`
    : "";
  const lateCustomerText = isLate
    ? `⚠ SUBMITTED AFTER OUR ORDERING WINDOW CLOSED.
Your order is not guaranteed and may not be fulfilled. Mr. D and Ivonne will still review it and follow up by email.

`
    : "";
  const lateAdminHtml = isLate
    ? `<div style="background:rgba(168,100,42,0.12);border-left:4px solid #a8642a;padding:12px 14px;margin:0 0 16px;color:#a8642a;font-size:14px">
         <strong>⚠ Order submitted after the closing window.</strong><br>
         The customer was warned that this order is not guaranteed.
       </div>`
    : "";
  // Phase 6.50b: capacity (global cap) banners
  const overCapCustomerHtml = isOverCap
    ? `<div style="background:rgba(176,141,64,0.12);border-left:4px solid ${GOLD};padding:14px;margin:0 0 16px;color:${INK};font-size:14px">
         <strong>Note: we've reached our seasonal capacity.</strong><br>
         Your order will still be reviewed, but availability is limited. Mr. D and Ivonne will follow up with you by email.
       </div>`
    : "";
  const overCapCustomerText = isOverCap
    ? `NOTE: WE'VE REACHED OUR SEASONAL CAPACITY.
Your order will still be reviewed, but availability is limited. Mr. D and Ivonne will follow up with you by email.

`
    : "";
  const overCapAdminHtml = isOverCap
    ? `<div style="background:rgba(176,141,64,0.12);border-left:4px solid ${GOLD};padding:12px 14px;margin:0 0 16px;color:${INK};font-size:14px">
         <strong>⚠ Order submitted at or over seasonal capacity threshold.</strong><br>
         The customer was advised that capacity has been reached. No automatic decision has been made — please review manually.
       </div>`
    : "";
  const lateSubjectPrefix = isLate ? "⚠ LATE: " : (isOverCap ? "⚠ AT CAPACITY: " : "");

  // Phase 6.45c.1 (May 24): wording reflects PENDING REVIEW, not confirmed.
  // Path B is inquiry-based — until Mr. D approves, nothing is reserved.
  // Email 1: customer
  await sendEmail(apiKey, {
    to: order.email,
    subject: `${lateSubjectPrefix}Order received (pending review) — ${orderRef}`,
    html: wrapEmail(`
      ${lateCustomerHtml}
      ${overCapCustomerHtml}
      <h2 style="color:${NAVY};margin:0 0 16px">Thank you, ${escapeHtml(firstName)}!</h2>
      <p>We've received your order request. Your order ID is:</p>
      <div style="background:${BG};border:1px solid #e0d9c8;padding:14px;font-family:'Courier New',monospace;font-size:15px;color:${GOLD};letter-spacing:1px;margin:16px 0;text-align:center">${escapeHtml(orderRef)}</div>
      <p style="margin:16px 0 8px;color:${MUTED};font-size:13px;letter-spacing:1px;text-transform:uppercase">Your selections</p>
      ${itemsTableHtml}
      <p><strong>${itemCount}</strong> item${itemCount === 1 ? "" : "s"} · Subtotal <strong>€${subtotal}</strong></p>
      ${paymentTypeHtml}
      <div style="background:#fdf6e3;border-left:3px solid ${GOLD};padding:12px 14px;margin:18px 0;font-size:14px;color:${INK}">
        <p style="margin:0 0 12px"><strong>What happens next:</strong> Mr. D and Ivonne will review your request within two business days. Once approved, you will receive a confirmation email that your order has been accepted and will be processed.</p>
        <p style="margin:0">Once your order has been completed and is ready to ship, you will receive an invoice, including shipping costs and any applicable fees. Payment must be made via PayPal, using either Friends &amp; Family or Goods &amp; Services. Please note that payments made through PayPal Goods &amp; Services will incur an additional fee equal to 5% of the total invoice amount. Payment is due within three business days of receipt of the invoice. Orders not paid within this timeframe will be canceled. Shipping information will be provided after your package has been dropped off at the post office and/or picked up by the shipping carrier. Please note that delivery times may vary from approximately 3 days (DHL Express) to 3 weeks (DHL Premium).</p>
      </div>
      <p style="margin:24px 0">
        <a href="${SITE_URL}" style="background:${GOLD};color:${INK};padding:12px 24px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;letter-spacing:1px;text-transform:uppercase;font-size:13px">View My Orders</a>
      </p>
      <p style="margin-top:24px">— Ivonne and Mr. D</p>
    `),
    text: `${lateCustomerText}${overCapCustomerText}Thank you, ${firstName}!

We've received your order request. Your order ID is:
${orderRef}

Your selections:
${itemRowsText}

${itemCount} item${itemCount === 1 ? "" : "s"} · Subtotal €${subtotal}${paymentTypeTextLine}

WHAT HAPPENS NEXT:
Mr. D and Ivonne will review your request within two business days. Once approved, you will receive a confirmation email that your order has been accepted and will be processed.

Once your order has been completed and is ready to ship, you will receive an invoice, including shipping costs and any applicable fees. Payment must be made via PayPal, using either Friends & Family or Goods & Services. Please note that payments made through PayPal Goods & Services will incur an additional fee equal to 5% of the total invoice amount. Payment is due within three business days of receipt of the invoice. Orders not paid within this timeframe will be canceled. Shipping information will be provided after your package has been dropped off at the post office and/or picked up by the shipping carrier. Please note that delivery times may vary from approximately 3 days (DHL Express) to 3 weeks (DHL Premium).

— Ivonne and Mr. D`,
  });

  // Email 2: admin alert — sent to every admin in public.admins
  await sendAdminAlert(sb, apiKey, {
    subject: `${lateSubjectPrefix}New order: ${orderRef} — ${customerName}`,
    html: wrapEmail(`
      ${lateAdminHtml}
      ${overCapAdminHtml}
      <h2 style="color:${NAVY};margin:0 0 16px">New order received</h2>
      <p><strong>Order ID:</strong> <code style="color:${GOLD}">${escapeHtml(orderRef)}</code></p>
      <p><strong>Customer:</strong> ${escapeHtml(customerName)} &lt;${escapeHtml(order.email || "")}&gt;</p>
      <p><strong>Items:</strong> ${itemCount}</p>
      <p><strong>Subtotal:</strong> €${subtotal}</p>
      ${paymentTypeDisplay ? `<p><strong>Payment type:</strong> ${paymentTypeDisplay}</p>` : ""}
      <p><strong>Shipping method:</strong> ${escapeHtml(order.shipping_method || "—")}</p>
      ${order.country ? `<p><strong>Ship to:</strong> ${escapeHtml(order.country)}</p>` : ""}
      <p style="color:${MUTED};font-size:13px;margin-top:24px">Open the Admin panel to review and set pricing.</p>
    `),
  });

  return { ok: true, sent: 2 };
}

async function handleOrderStatusChanged(sb: any, apiKey: string, orderId: string) {
  if (!orderId) throw new Error("Missing orderId for order_status_changed email");
  const { data: order, error } = await sb
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();
  if (error || !order) throw new Error("Order not found: " + (error?.message || orderId));

  const firstName = order.first_name || "there";
  const orderRef = order.order_id || "(pending)";
  const status = order.status || "pending";

  // Phase 6.58: new "order approved" wording. Note the body contains <br>
  // line breaks — it is rendered inside <p>${copy.body}</p>, which is fine.
  // The auto "Hello [name]," greeting and the order-ID box are kept above it.
  const statusCopy: Record<string, { heading: string; body: string; subject?: string; terminal?: boolean }> = {
    approved: {
      heading: "Thank you for your order",
      body: `Your order has been successfully received and entered into our production schedule.<br><br>
All ornaments are handcrafted and made to order.<br><br>
An invoice will be sent to your registered email address once your order has been completed and is ready to ship. Payment should be made via PayPal. Send payment to username glasbaetz@hotmail.com.<br><br>
You may view a read-only copy of your order at any time using the button below.<br><br>
If you have any questions regarding your order, please contact Ivonne or Renee.<br><br>
Thank you for your support.<br>
Ivonne &amp; Mr. D`,
    },
    shipped: {
      heading: "Your order has shipped!",
      body: "Good news — your order is on its way. You should receive it within the next two to three weeks depending on destination.",
    },
    cancelled: {
      heading: "We are unable to fulfill your order at this time",
      body: "Thank you for your interest in Gläserne Leidenschaft. Unfortunately, we are not able to fulfill this order. We appreciate your enthusiasm for our work and hope you'll consider us again in the future.",
      subject: "Update on your order",
      terminal: true,
    },
    pending: {
      heading: "Your order status has been updated",
      body: "Your order is back in pending status.",
    },
  };
  const copy = statusCopy[status] || statusCopy.pending;

  // Phase 6.58: when the order is approved, the CTA points to the passwordless
  // read-only order view (order.html?t=<view_token>). For any other status it
  // falls back to the main site. If no token exists yet, also fall back.
  const orderViewUrl = (status === "approved" && order.view_token)
    ? `${SITE_URL}/order.html?t=${encodeURIComponent(order.view_token)}`
    : SITE_URL;
  const ctaBlock = copy.terminal ? "" : `
    <p style="margin:24px 0">
      <a href="${orderViewUrl}" style="background:${GOLD};color:${INK};padding:12px 24px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;letter-spacing:1px;text-transform:uppercase;font-size:13px">View My Order</a>
    </p>`;
  const signOffBlock = copy.terminal
    ? `<p style="margin-top:24px">Gläserne Leidenschaft</p>
       <p style="color:${MUTED};font-size:12px;font-style:italic;margin-top:20px;border-top:1px solid #e6dfce;padding-top:12px">
         This email is not monitored. Please do not reply.
       </p>`
    : `<p style="margin-top:24px">— Ivonne and Mr. D</p>`;

  return sendEmail(apiKey, {
    to: order.email,
    subject: `${copy.subject || copy.heading} — ${orderRef}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Hello ${escapeHtml(firstName)},</h2>
      <p><strong>${copy.heading}.</strong></p>
      <div style="background:${BG};border:1px solid #e0d9c8;padding:14px;font-family:'Courier New',monospace;font-size:15px;color:${GOLD};letter-spacing:1px;margin:16px 0;text-align:center">${escapeHtml(orderRef)}</div>
      <p>${copy.body}</p>
      ${ctaBlock}
      ${signOffBlock}
    `),
  });
}

// ════════════════════════════════════════════════════════════════════════
// Phase 6.30: Order shipped email — includes tracking info
// ════════════════════════════════════════════════════════════════════════

const CARRIER_DISPLAY_NAMES: Record<string, string> = {
  dhl_paket:       "DHL Paket",
  dhl_paket_intl:  "DHL Paket International",
  deutsche_post:   "Deutsche Post",
  ups:             "UPS",
  fedex:           "FedEx",
  usps:            "USPS",
};

const CARRIER_TRACKING_URL: Record<string, string> = {
  dhl_paket:       "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode={N}",
  dhl_paket_intl:  "https://www.dhl.com/global-en/home/tracking/tracking-parcel.html?tracking-id={N}",
  deutsche_post:   "https://www.deutschepost.de/sendung/simpleQueryResult.html?form.sendungsnummer={N}",
  ups:             "https://www.ups.com/track?loc=en_US&tracknum={N}",
  fedex:           "https://www.fedex.com/fedextrack/?trknbr={N}",
  usps:            "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1={N}",
};

function buildTrackingUrl(carrier: string | null | undefined, trackingNumber: string | null | undefined): string | null {
  if (!carrier || !trackingNumber) return null;
  const template = CARRIER_TRACKING_URL[carrier];
  if (!template) return null;
  return template.replace("{N}", encodeURIComponent(trackingNumber));
}

async function handleOrderShipped(sb: any, apiKey: string, orderId: string) {
  if (!orderId) throw new Error("Missing orderId for order_shipped email");
  const { data: order, error } = await sb
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();
  if (error || !order) throw new Error("Order not found: " + (error?.message || orderId));

  const firstName = order.first_name || "there";
  const orderRef = order.order_id || "(pending)";
  const tracking = order.tracking_number || null;
  const carrier = order.shipping_carrier || null;
  const carrierOther = order.shipping_carrier_other || null;

  const carrierDisplayName = carrier === "other"
    ? (carrierOther || "Carrier")
    : (CARRIER_DISPLAY_NAMES[carrier as string] || "Carrier");

  const trackingUrl = buildTrackingUrl(carrier, tracking);

  let trackingBlock = "";
  if (trackingUrl && tracking) {
    trackingBlock = `
      <div style="background:${BG};border:1px solid #e0d9c8;padding:18px;margin:20px 0;border-radius:4px">
        <p style="margin:0 0 6px;font-size:13px;color:${MUTED};letter-spacing:1px;text-transform:uppercase">Carrier</p>
        <p style="margin:0 0 14px;font-size:15px;color:${INK};font-weight:bold">${escapeHtml(carrierDisplayName)}</p>
        <p style="margin:0 0 6px;font-size:13px;color:${MUTED};letter-spacing:1px;text-transform:uppercase">Tracking Number</p>
        <p style="margin:0 0 16px;font-family:'Courier New',monospace;font-size:14px;color:${INK}">${escapeHtml(tracking)}</p>
        <p style="margin:0">
          <a href="${trackingUrl}" style="background:${GOLD};color:${INK};padding:10px 20px;text-decoration:none;border-radius:4px;font-family:Georgia,serif;letter-spacing:1px;text-transform:uppercase;font-size:13px;display:inline-block">Track Your Package</a>
        </p>
      </div>`;
  } else if (tracking) {
    trackingBlock = `
      <div style="background:${BG};border:1px solid #e0d9c8;padding:18px;margin:20px 0;border-radius:4px">
        <p style="margin:0 0 6px;font-size:13px;color:${MUTED};letter-spacing:1px;text-transform:uppercase">Carrier</p>
        <p style="margin:0 0 14px;font-size:15px;color:${INK};font-weight:bold">${escapeHtml(carrierDisplayName)}</p>
        <p style="margin:0 0 6px;font-size:13px;color:${MUTED};letter-spacing:1px;text-transform:uppercase">Tracking Number</p>
        <p style="margin:0;font-family:'Courier New',monospace;font-size:14px;color:${INK}">${escapeHtml(tracking)}</p>
      </div>`;
  }

  return sendEmail(apiKey, {
    to: order.email,
    subject: `Your order has shipped — ${orderRef}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Hello ${escapeHtml(firstName)},</h2>
      <p><strong>Good news — your order is on its way!</strong></p>
      <div style="background:${BG};border:1px solid #e0d9c8;padding:14px;font-family:'Courier New',monospace;font-size:15px;color:${GOLD};letter-spacing:1px;margin:16px 0;text-align:center">${escapeHtml(orderRef)}</div>
      <p>Your hand-blown ornaments are now in transit. You should receive them within the next two to three weeks depending on destination.</p>
      ${trackingBlock}
      <p style="font-size:13px;color:${MUTED};font-style:italic">Tracking information typically updates within 24–48 hours of dispatch. If the tracking link doesn't show details right away, please check back later.</p>
      <p style="margin-top:24px">— Ivonne and Mr. D</p>
    `),
  });
}

async function handleOrderCancelledByCustomer(sb: any, apiKey: string, orderId: string) {
  if (!orderId) throw new Error("Missing orderId for order_cancelled_by_customer email");
  const { data: order, error } = await sb
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();
  if (error || !order) throw new Error("Order not found: " + (error?.message || orderId));

  const firstName = order.first_name || "there";
  const customerName = `${order.first_name || ""} ${order.last_name || ""}`.trim() || "customer";
  const orderRef = order.order_id || "(pending)";
  const cancelledAtStr = order.cancelled_at
    ? new Date(order.cancelled_at).toUTCString()
    : new Date().toUTCString();

  // Email 1: customer confirmation
  await sendEmail(apiKey, {
    to: order.email,
    subject: `Cancellation confirmed — ${orderRef}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Hello ${escapeHtml(firstName)},</h2>
      <p>This confirms that you've cancelled your order. No payment is owed.</p>
      <div style="background:${BG};border:1px solid #e0d9c8;padding:14px;font-family:'Courier New',monospace;font-size:15px;color:${GOLD};letter-spacing:1px;margin:16px 0;text-align:center">${escapeHtml(orderRef)}</div>
      <p>If you cancelled in error, please reply to this email or contact us at info@glass-passion.com — we may be able to restore the order if you reach us quickly.</p>
      <p style="margin-top:24px">Thank you for your interest in our work, and we hope to see you again.</p>
      <p style="margin-top:24px">— Ivonne and Mr. D</p>
      <p style="color:${MUTED};font-size:12px;font-style:italic;margin-top:20px;border-top:1px solid #e6dfce;padding-top:12px">
        Cancelled at ${escapeHtml(cancelledAtStr)}.
      </p>
    `),
  });

  // Email 2: admin alert
  await sendAdminAlert(sb, apiKey, {
    subject: `Order cancelled by customer: ${orderRef} — ${customerName}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Customer-initiated cancellation</h2>
      <p><strong>Order ID:</strong> <code style="color:${GOLD}">${escapeHtml(orderRef)}</code></p>
      <p><strong>Customer:</strong> ${escapeHtml(customerName)} &lt;${escapeHtml(order.email || "")}&gt;</p>
      <p><strong>Cancelled at:</strong> ${escapeHtml(cancelledAtStr)}</p>
      <p style="color:${MUTED};font-size:13px;margin-top:24px">No action required. The order is now in the cancelled state and will not appear in active workflows.</p>
    `),
  });

  return { ok: true, sent: 2 };
}

async function handleOrderCancelledByAdmin(sb: any, apiKey: string, orderId: string) {
  if (!orderId) throw new Error("Missing orderId for order_cancelled_by_admin email");
  const { data: order, error } = await sb
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();
  if (error || !order) throw new Error("Order not found: " + (error?.message || orderId));

  const firstName = order.first_name || "there";
  const orderRef = order.order_id || "(pending)";
  const reason = (order.cancellation_reason || "").trim();

  const reasonBlock = reason
    ? `<div style="background:${BG};border-left:3px solid ${GOLD};padding:12px 16px;margin:16px 0;font-style:italic;color:${INK}">${escapeHtml(reason)}</div>`
    : "";

  return sendEmail(apiKey, {
    to: order.email,
    subject: `Update on your order — ${orderRef}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Hello ${escapeHtml(firstName)},</h2>
      <p>We're writing to let you know that your order has been cancelled. We're sorry for any inconvenience this causes.</p>
      <div style="background:${BG};border:1px solid #e0d9c8;padding:14px;font-family:'Courier New',monospace;font-size:15px;color:${GOLD};letter-spacing:1px;margin:16px 0;text-align:center">${escapeHtml(orderRef)}</div>
      ${reasonBlock}
      <p>No payment is owed. If you have any questions, please reply to this email or write to info@glass-passion.com — we'd be glad to help.</p>
      <p style="margin-top:24px">Thank you for your interest in our work.</p>
      <p style="margin-top:24px">Gläserne Leidenschaft</p>
      <p style="color:${MUTED};font-size:12px;font-style:italic;margin-top:20px;border-top:1px solid #e6dfce;padding-top:12px">
        This email is not monitored. Please do not reply.
      </p>
    `),
  });
}

// ════════════════════════════════════════════════════════════════════════
// Phase 6.38: Lottery result emails (won/lost) — single-order helpers.
// Customer email + admin alert (admin list comes from public.admins).
// Retained for manual single-entry use; the batch path below
// (handleLotterySendResults) is the primary flow for a committed draw.
// ════════════════════════════════════════════════════════════════════════

async function handleLotteryWon(sb: any, apiKey: string, orderId: string) {
  if (!orderId) throw new Error("Missing orderId for lottery_won email");
  const { data: order, error } = await sb
    .from("orders").select("*").eq("id", orderId).single();
  if (error || !order) throw new Error("Order not found: " + (error?.message || orderId));

  const firstName = order.first_name || "there";
  const customerName = `${order.first_name || ""} ${order.last_name || ""}`.trim() || "customer";
  const orderRef = order.order_id || "(pending)";

  // Customer email
  await sendEmail(apiKey, {
    to: order.email,
    subject: `Congratulations — you won the Limited Edition lottery (${orderRef})`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Wonderful news, ${escapeHtml(firstName)}!</h2>
      <p>You've been selected in the Limited Edition lottery for the 2026 season. The Limited Edition piece will be added to your order.</p>
      <div style="background:${BG};border:1px solid #e0d9c8;padding:14px;font-family:'Courier New',monospace;font-size:15px;color:${GOLD};letter-spacing:1px;margin:16px 0;text-align:center">${escapeHtml(orderRef)}</div>
      <p>Your single invoice — covering your full selection including the Limited Edition piece — will be sent shortly. You can review your updated order from your Order History at any time.</p>
      <p style="margin-top:24px">— Ivonne and Mr. D</p>
    `),
  });

  // Admin BCC — for the record
  await sendAdminAlert(sb, apiKey, {
    subject: `Lottery WON: ${orderRef} — ${customerName}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Lottery: Won</h2>
      <p><strong>Order ID:</strong> <code style="color:${GOLD}">${escapeHtml(orderRef)}</code></p>
      <p><strong>Customer:</strong> ${escapeHtml(customerName)} &lt;${escapeHtml(order.email || "")}&gt;</p>
      <p>The Limited Edition piece has been added to this order and the customer has been notified.</p>
      <p style="color:${MUTED};font-size:13px;margin-top:24px">Open the Admin panel to review the updated order and send the invoice.</p>
    `),
  });

  return { ok: true, sent: 2 };
}

async function handleLotteryLost(sb: any, apiKey: string, orderId: string) {
  if (!orderId) throw new Error("Missing orderId for lottery_lost email");
  const { data: order, error } = await sb
    .from("orders").select("*").eq("id", orderId).single();
  if (error || !order) throw new Error("Order not found: " + (error?.message || orderId));

  const firstName = order.first_name || "there";
  const customerName = `${order.first_name || ""} ${order.last_name || ""}`.trim() || "customer";
  const orderRef = order.order_id || "(pending)";

  // Customer email
  await sendEmail(apiKey, {
    to: order.email,
    subject: `Limited Edition lottery result — ${orderRef}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Hello ${escapeHtml(firstName)},</h2>
      <p>Thank you for entering the Limited Edition lottery for the 2026 season. Unfortunately, your entry was not selected this time. Your order will continue with your regular selections, and you will receive a single invoice for those shortly.</p>
      <div style="background:${BG};border:1px solid #e0d9c8;padding:14px;font-family:'Courier New',monospace;font-size:15px;color:${GOLD};letter-spacing:1px;margin:16px 0;text-align:center">${escapeHtml(orderRef)}</div>
      <p>We appreciate your interest in our work, and we hope you'll consider us again in the future.</p>
      <p style="margin-top:24px">— Ivonne and Mr. D</p>
    `),
  });

  // Admin BCC — for the record
  await sendAdminAlert(sb, apiKey, {
    subject: `Lottery NOT SELECTED: ${orderRef} — ${customerName}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Lottery: Not Selected</h2>
      <p><strong>Order ID:</strong> <code style="color:${GOLD}">${escapeHtml(orderRef)}</code></p>
      <p><strong>Customer:</strong> ${escapeHtml(customerName)} &lt;${escapeHtml(order.email || "")}&gt;</p>
      <p>The customer has been notified. Their order proceeds with regular ornaments only.</p>
    `),
  });

  return { ok: true, sent: 2 };
}

// ════════════════════════════════════════════════════════════════════════
// Phase 6.51 Deploy 2 (single-LE): batch result-email send.
// Individual win/lose email per entrant via Resend's BATCH endpoint
// (chunked at 100), then ONE consolidated admin summary per draw.
// Idempotent — only entries with result_email_sent_at IS NULL are processed,
// and each is stamped once handled, so reruns never double-send. Season
// minimum + cap and the LE name are pulled fresh so the rules line is
// always accurate.
// ════════════════════════════════════════════════════════════════════════
async function getLotteryRuleValues(sb: any): Promise<{ minOrnaments: number; seasonCap: number }> {
  try {
    const { data } = await sb.from("site_settings")
      .select("lottery_minimum_ornaments, lottery_season_cap").eq("id", "global").single();
    return {
      minOrnaments: data && data.lottery_minimum_ornaments != null ? Number(data.lottery_minimum_ornaments) : 5,
      seasonCap: data && data.lottery_season_cap != null ? Number(data.lottery_season_cap) : 15,
    };
  } catch (_) {
    return { minOrnaments: 5, seasonCap: 15 };
  }
}

async function getProductName(sb: any, productId: string): Promise<string> {
  try {
    const { data } = await sb.from("products").select("name").eq("id", productId).single();
    return data && data.name ? String(data.name) : "Limited Edition";
  } catch (_) {
    return "Limited Edition";
  }
}

function buildLotteryCustomerEmail(
  order: any, won: boolean, leName: string, minOrnaments: number, seasonCap: number
): { subject: string; html: string; text: string } {
  const firstName = order.first_name || "there";
  const orderRef = order.order_id || "(pending)";
  const rulesLine = `A reminder of this season's rules: a minimum of ${minOrnaments} ornaments is required for any order, and the maximum any one customer can receive is ${seasonCap} total, with no duplicates.`;
  const refBox = `<div style="background:${BG};border:1px solid #e0d9c8;padding:14px;font-family:'Courier New',monospace;font-size:15px;color:${GOLD};letter-spacing:1px;margin:16px 0;text-align:center">${escapeHtml(orderRef)}</div>`;
  const rulesBox = `<p style="color:${MUTED};font-size:13px;font-style:italic;border-left:3px solid ${GOLD};padding:8px 0 8px 14px;margin:20px 0;background:${BG}">${escapeHtml(rulesLine)}</p>`;
  if (won) {
    return {
      subject: `Congratulations — you won the Limited Edition lottery (${orderRef})`,
      html: wrapEmail(`
        <h2 style="color:${NAVY};margin:0 0 16px">Wonderful news, ${escapeHtml(firstName)}!</h2>
        <p>You've been selected in the lottery for our Limited Edition piece, <strong>${escapeHtml(leName)}</strong>. It will be added to your order.</p>
        ${refBox}
        <p>Your single invoice — covering your full selection including the Limited Edition piece — will be sent shortly. You can review your updated order from your Order History at any time.</p>
        ${rulesBox}
        <p style="margin-top:24px">— Ivonne and Mr. D</p>
      `),
      text: `Wonderful news, ${firstName}!

You've been selected in the lottery for our Limited Edition piece, ${leName}. It will be added to your order.

Order: ${orderRef}

Your single invoice — covering your full selection including the Limited Edition piece — will be sent shortly.

${rulesLine}

— Ivonne and Mr. D`,
    };
  }
  return {
    subject: `Limited Edition lottery result — ${orderRef}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Hello ${escapeHtml(firstName)},</h2>
      <p>Thank you for entering the lottery for our Limited Edition piece, <strong>${escapeHtml(leName)}</strong>. Unfortunately, your entry was not selected this time. Your order will continue with your regular selections, and you will receive a single PayPal invoice for those shortly.</p>
      ${refBox}
      ${rulesBox}
      <p>We appreciate your interest in our work, and we hope you'll consider us again in the future.</p>
      <p style="margin-top:24px">— Ivonne and Mr. D</p>
    `),
    text: `Hello ${firstName},

Thank you for entering the lottery for our Limited Edition piece, ${leName}. Unfortunately, your entry was not selected this time. Your order will continue with your regular selections, and you'll receive a single PayPal invoice for those shortly.

Order: ${orderRef}

${rulesLine}

We appreciate your interest in our work, and we hope you'll consider us again in the future.

— Ivonne and Mr. D`,
  };
}

async function handleLotterySendResults(sb: any, apiKey: string, leId: string) {
  if (!leId) throw new Error("Missing leId for lottery_send_results");

  const { minOrnaments, seasonCap } = await getLotteryRuleValues(sb);
  const leName = await getProductName(sb, leId);

  // Only resolved entries for this LE that haven't been emailed yet.
  const { data: entries, error: entErr } = await sb
    .from("lottery_entries")
    .select("order_id, status, result_email_sent_at")
    .eq("le_product_id", leId)
    .in("status", ["won", "lost"])
    .is("result_email_sent_at", null);
  if (entErr) throw new Error("lottery_entries query failed: " + entErr.message);
  if (!entries || entries.length === 0) {
    return { ok: true, emailed: 0, skipped: 0, note: "No unsent results." };
  }

  const orderIds = entries.map((e: any) => e.order_id);
  const { data: orders, error: oErr } = await sb
    .from("orders")
    .select("id, email, first_name, last_name, order_id, cancelled_at")
    .in("id", orderIds);
  if (oErr) throw new Error("orders query failed: " + oErr.message);
  const ordersById: Record<string, any> = {};
  (orders || []).forEach((o: any) => { ordersById[o.id] = o; });

  const emails: any[] = [];
  const sendOrderIds: string[] = [];
  const skipOrderIds: string[] = [];
  const winners: any[] = [];
  let loserCount = 0;

  for (const e of entries) {
    const o = ordersById[e.order_id];
    // Skip cancelled orders or those with no email — stamped below so they don't linger.
    if (!o || o.cancelled_at || !o.email) { skipOrderIds.push(e.order_id); continue; }
    const built = buildLotteryCustomerEmail(o, e.status === "won", leName, minOrnaments, seasonCap);
    emails.push({
      from: FROM_EMAIL, to: [o.email], reply_to: REPLY_TO,
      subject: built.subject, html: built.html, text: built.text,
    });
    sendOrderIds.push(e.order_id);
    if (e.status === "won") winners.push(o); else loserCount++;
  }

  // Stamp non-sendable entries (cancelled / no email) so the pending count clears.
  if (skipOrderIds.length > 0) {
    await sb.from("lottery_entries")
      .update({ result_email_sent_at: new Date().toISOString() })
      .eq("le_product_id", leId).in("order_id", skipOrderIds);
  }

  // Send in chunks of 100 via Resend's batch endpoint; stamp each chunk only
  // after it succeeds, so a failure mid-run leaves the remainder retryable.
  let emailed = 0;
  const CHUNK = 100;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const chunkIds = sendOrderIds.slice(i, i + CHUNK);
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Resend batch error (${res.status}) after ${emailed} sent: ${JSON.stringify(data)}`);
    }
    const { error: stampErr } = await sb.from("lottery_entries")
      .update({ result_email_sent_at: new Date().toISOString() })
      .eq("le_product_id", leId).in("order_id", chunkIds);
    if (stampErr) console.warn("[lottery_send_results] stamp failed:", stampErr);
    emailed += chunk.length;
  }

  // One consolidated admin summary for the whole send.
  const winnerRows = winners.map((o: any) => {
    const nm = `${o.first_name || ""} ${o.last_name || ""}`.trim() || o.email || "(customer)";
    return `<li style="margin-bottom:4px"><strong>${escapeHtml(nm)}</strong> &lt;${escapeHtml(o.email || "")}&gt; · <code style="color:${GOLD}">${escapeHtml(o.order_id || "")}</code></li>`;
  }).join("");
  await sendAdminAlert(sb, apiKey, {
    subject: `Lottery results sent: ${leName} — ${winners.length} winner(s)`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Lottery results sent</h2>
      <p><strong>Limited Edition:</strong> ${escapeHtml(leName)}</p>
      <p><strong>Winners (${winners.length}):</strong></p>
      ${winners.length ? `<ul style="padding-left:18px;margin:8px 0 16px">${winnerRows}</ul>` : `<p style="color:${MUTED}">None.</p>`}
      <p><strong>Not selected:</strong> ${loserCount} customer(s) notified by email.</p>
      <p style="color:${MUTED};font-size:13px;margin-top:24px">Winners' orders now include the Limited Edition piece. Open the Admin panel to send their invoices.</p>
    `),
  });

  return { ok: true, emailed, skipped: skipOrderIds.length, winners: winners.length, losers: loserCount };
}

async function handleRegistrationPending(sb: any, apiKey: string, userId: string) {
  if (!userId) throw new Error("Missing userId for registration_pending email");
  const { data: profile, error } = await sb.from("profiles").select("*").eq("id", userId).single();
  if (error || !profile) throw new Error("Profile not found: " + (error?.message || userId));
  const name = `${profile.first_name || ""} ${profile.last_name || ""}`.trim() || "(no name)";
  const cityCountry = [profile.city, profile.country].filter(Boolean).join(", ");

  return sendAdminAlert(sb, apiKey, {
    subject: `New registration pending review — ${name}`,
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">New account pending review</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(profile.email || "")}</p>
      ${profile.phone ? `<p><strong>Phone:</strong> ${escapeHtml(profile.phone)}</p>` : ""}
      ${profile.facebook_name ? `<p><strong>Facebook:</strong> ${escapeHtml(profile.facebook_name)}</p>` : ""}
      ${cityCountry ? `<p><strong>Location:</strong> ${escapeHtml(cityCountry)}</p>` : ""}
      <p style="color:${MUTED};font-size:13px;margin-top:24px">Open the Admin panel to approve or deny this account.</p>
    `),
  });
}

// ════════════════════════════════════════════════════════════════════════
// USER DELETION (admin-triggered)
// ════════════════════════════════════════════════════════════════════════
async function handleDeleteUser(
  sb: any,
  apiKey: string,
  userId: string,
  notifyUser: boolean,
  reason?: string,
  opts?: { ban?: boolean; banReason?: string; adminEmail?: string }
) {
  if (!userId) throw new Error("Missing userId for delete_user");
  const ban = !!opts?.ban;
  const banReason = opts?.banReason?.trim() || "";
  const adminEmail = opts?.adminEmail?.trim() || "(unknown admin)";

  if (ban && !banReason) {
    throw new Error("A ban reason is required when banning an email address.");
  }

  // 1. Fetch the full profile
  const { data: profile } = await sb
    .from("profiles")
    .select("id, email, first_name, last_name, phone, city, country")
    .eq("id", userId)
    .single();
  if (!profile) throw new Error("Profile not found: " + userId);

  // 2. Refuse to delete admin accounts — hard safety rail.
  // Phase 6.34b: admin list now comes from the database.
  const emailLower = String(profile.email || "").toLowerCase();
  const adminList = await getAdminEmails(sb);
  if (adminList.includes(emailLower)) {
    throw new Error(`Refusing to delete admin account: ${profile.email}`);
  }

  // 3. Count what we're about to delete
  const { count: preOrderItemCount } = await sb
    .from("order_items").select("*", { count: "exact", head: true }).eq("user_id", userId);
  const { count: preOrderCount } = await sb
    .from("orders").select("*", { count: "exact", head: true }).eq("user_id", userId);

  // 4. Send notification email FIRST
  let emailSent = false;
  let emailError: string | null = null;
  if (notifyUser && profile.email) {
    try {
      await sendAccountRemovedEmail(apiKey, profile, reason);
      emailSent = true;
    } catch (e) {
      emailError = String((e as any)?.message || e);
      console.warn("[delete_user] notification email failed:", emailError);
    }
  }

  // 5. Write the audit row FIRST, then (optionally) the ban.
  const fullName = [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
  const { error: auditErr } = await sb.from("deleted_accounts_audit").insert({
    deleted_by_email: adminEmail,
    deleted_user_id: userId,
    deleted_user_email: profile.email,
    deleted_user_name: fullName || null,
    deleted_user_phone: profile.phone || null,
    deleted_user_city: profile.city || null,
    deleted_user_country: profile.country || null,
    order_count: preOrderCount || 0,
    order_item_count: preOrderItemCount || 0,
    notified: emailSent,
    reason: reason?.trim() || null,
    banned: ban,
    ban_reason: ban ? banReason : null,
  });
  if (auditErr) throw new Error("Failed to write audit log (deletion aborted): " + auditErr.message);

  if (ban && profile.email) {
    const { error: banErr } = await sb.from("banned_emails").insert({
      email: emailLower,
      banned_by_email: adminEmail,
      reason: banReason,
    });
    if (banErr && !String(banErr.message).toLowerCase().includes("duplicate")) {
      throw new Error("Failed to add to banned_emails (deletion aborted): " + banErr.message);
    }
  }

  // 6. Cascade delete in FK-safe order
  const counts = { orderItems: 0, orders: 0, profile: 0, authUser: 0 };

  const { count: oiCount, error: oiErr } = await sb
    .from("order_items").delete({ count: "exact" }).eq("user_id", userId);
  if (oiErr) throw new Error("Failed to delete order_items: " + oiErr.message);
  counts.orderItems = oiCount || 0;

  const { count: ordCount, error: ordErr } = await sb
    .from("orders").delete({ count: "exact" }).eq("user_id", userId);
  if (ordErr) throw new Error("Failed to delete orders: " + ordErr.message);
  counts.orders = ordCount || 0;

  const { count: pCount, error: pErr } = await sb
    .from("profiles").delete({ count: "exact" }).eq("id", userId);
  if (pErr) throw new Error("Failed to delete profile: " + pErr.message);
  counts.profile = pCount || 0;

  const { error: authErr } = await sb.auth.admin.deleteUser(userId);
  if (authErr) throw new Error("Failed to delete auth user: " + authErr.message);
  counts.authUser = 1;

  return { ok: true, deleted: counts, emailSent, emailError, banned: ban };
}

async function handleCheckBannedEmail(sb: any, email: string) {
  if (!email) return { banned: false };
  const normalized = String(email).toLowerCase().trim();
  const { data } = await sb
    .from("banned_emails")
    .select("id")
    .eq("email", normalized)
    .maybeSingle();
  return { banned: !!data };
}

async function handlePaymentRequest(
  sb: any,
  apiKey: string,
  orderId: string,
  paymentAmount: number,
  paymentNote: string | undefined,
  paymentItems: Array<{ name: string; euros: number }> | undefined,
  adminEmail: string | undefined,
  // Phase 6.59: itemized cost breakdown from the frontend. All amounts in
  // euros; discount/tariffs/gsFee lines render only when > 0. Optional for
  // backward compatibility with older clients.
  paymentBreakdown?: {
    subtotal?: number;
    discountPercent?: number;
    discountAmount?: number;
    shipping?: number;
    tariffs?: number;
    gsFee?: number;
  }
) {
  if (!orderId) throw new Error("Missing orderId for payment_request email");
  if (typeof paymentAmount !== "number" || paymentAmount <= 0) {
    throw new Error("Missing or invalid paymentAmount (expected positive number)");
  }

  const { data: order, error: orderErr } = await sb
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();
  if (orderErr || !order) throw new Error("Order not found: " + (orderErr?.message || orderId));

  const firstName = order.first_name || "there";
  const orderRef = order.order_id || orderId.slice(0, 8);
  const items = Array.isArray(paymentItems) ? paymentItems : [];

  const itemRowsHtml = items.map((it) => {
    const name = it.name || "—";
    const price = typeof it.euros === "number" ? `€${it.euros.toFixed(2)}` : "";
    return `<tr>
      <td style="padding:6px 0;font-family:Georgia,serif;font-size:14px;color:${INK}">${escapeHtml(name)}</td>
      <td style="padding:6px 0;font-family:Georgia,serif;font-size:14px;color:${INK};text-align:right">${price}</td>
    </tr>`;
  }).join("");

  const itemRowsText = items.map((it) => {
    const name = it.name || "—";
    const price = typeof it.euros === "number" ? `  €${it.euros.toFixed(2)}` : "";
    return `  • ${name}${price}`;
  }).join("\n");

  const optionalNoteHtml = paymentNote
    ? `<p style="margin:16px 0;padding:12px 16px;background:${BG};border-left:3px solid ${GOLD};font-family:Georgia,serif;color:${INK};font-size:14px;font-style:italic">${escapeHtml(paymentNote)}</p>`
    : "";
  const optionalNoteText = paymentNote ? `\n${paymentNote}\n` : "";

  const amountFmt = paymentAmount.toFixed(2);

  // ─── Phase 6.59: itemized totals block (mirrors the invoice PDF) ───────
  // Subtotal always shows when a breakdown is supplied; Discount, Shipping,
  // Tariffs, and G&S fee lines show only when their amount is > 0, matching
  // the invoice PDF's gating. Falls back to the legacy single "Total due"
  // line when no breakdown is present.
  const bd = paymentBreakdown && typeof paymentBreakdown === "object" ? paymentBreakdown : null;
  const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : 0);
  let totalsHtml = "";
  let totalsText = "";
  if (bd) {
    const bSub = num(bd.subtotal);
    const bDisc = num(bd.discountAmount);
    const bDiscPct = num(bd.discountPercent);
    const bShip = num(bd.shipping);
    const bTar = num(bd.tariffs);
    const bFee = num(bd.gsFee);
    const rowHtml = (label: string, amountStr: string) => `<tr>
      <td style="padding:4px 0;font-family:Georgia,serif;font-size:14px;color:${MUTED}">${label}</td>
      <td style="padding:4px 0;font-family:Georgia,serif;font-size:14px;color:${INK};text-align:right">${amountStr}</td>
    </tr>`;
    let rows = rowHtml("Subtotal", `€${bSub.toFixed(2)}`);
    if (bDisc > 0) rows += rowHtml(`Discount (${bDiscPct}%)`, `-€${bDisc.toFixed(2)}`);
    if (bShip > 0) rows += rowHtml("Shipping", `€${bShip.toFixed(2)}`);
    if (bTar > 0) rows += rowHtml("Tariffs / fees", `€${bTar.toFixed(2)}`);
    if (bFee > 0) rows += rowHtml("PayPal G&amp;S fee (5%)", `€${bFee.toFixed(2)}`);
    rows += `<tr>
      <td style="padding:8px 0 0;font-family:Georgia,serif;font-size:16px;color:${NAVY};font-weight:bold;border-top:2px solid ${GOLD}">Total due</td>
      <td style="padding:8px 0 0;font-family:Georgia,serif;font-size:16px;color:${NAVY};font-weight:bold;text-align:right;border-top:2px solid ${GOLD}">€${amountFmt}</td>
    </tr>`;
    totalsHtml = `<table style="width:100%;border-collapse:collapse;margin:8px 0 16px">${rows}</table>`;

    const tLines = [`Subtotal: €${bSub.toFixed(2)}`];
    if (bDisc > 0) tLines.push(`Discount (${bDiscPct}%): -€${bDisc.toFixed(2)}`);
    if (bShip > 0) tLines.push(`Shipping: €${bShip.toFixed(2)}`);
    if (bTar > 0) tLines.push(`Tariffs / fees: €${bTar.toFixed(2)}`);
    if (bFee > 0) tLines.push(`PayPal G&S fee (5%): €${bFee.toFixed(2)}`);
    tLines.push(`Total due: €${amountFmt}`);
    totalsText = tLines.join("\n");
  } else {
    // Legacy fallback — single total line, pre-6.59 behavior.
    totalsHtml = `<p style="margin:16px 0;font-family:Georgia,serif;font-size:17px;color:${INK}">
      <strong>Total due: €${amountFmt}</strong>
    </p>`;
    totalsText = `Total due: €${amountFmt}`;
  }

  const html = wrapEmail(`
    <h2 style="color:${NAVY};margin:0 0 16px">Payment request for your order, ${escapeHtml(firstName)}</h2>
    <p>Thank you for your order with Gläserne Leidenschaft. Your order has been approved and we're now ready to collect payment.</p>
    <p style="margin:16px 0 8px;color:${MUTED};font-size:13px;letter-spacing:1px;text-transform:uppercase">Order ${escapeHtml(orderRef)}</p>
    <table style="width:100%;border-collapse:collapse;margin:8px 0 16px;border-top:1px solid #e6dfce;border-bottom:1px solid #e6dfce">
      ${itemRowsHtml || `<tr><td style="padding:6px 0;font-family:Georgia,serif;color:${MUTED};font-style:italic">(${items.length} item${items.length === 1 ? "" : "s"})</td></tr>`}
    </table>
    ${totalsHtml}
    ${optionalNoteHtml}
    <h3 style="color:${NAVY};margin:24px 0 8px;font-size:16px">How to pay</h3>
    <p>Please send payment via PayPal to:</p>
    <p style="font-family:Georgia,serif;font-size:16px;color:${NAVY};background:${BG};padding:12px 16px;border-radius:4px;margin:8px 0">
      <strong>glasbaetz@hotmail.com</strong>
    </p>
    <p style="color:${MUTED};font-size:13px">When sending, please include your order reference <strong>${escapeHtml(orderRef)}</strong> in the PayPal memo so we can match your payment to your order.</p>
    <p style="margin:16px 0;padding:12px 14px;background:#fdf6e3;border-left:3px solid ${GOLD};font-family:Georgia,serif;color:${INK};font-size:14px"><strong>Payment is due within three (3) days via PayPal.</strong></p>
    <p style="margin-top:24px">If you have any questions, reply to this email or write to <a href="mailto:${REPLY_TO}" style="color:${NAVY}">${REPLY_TO}</a>.</p>
    <p style="margin-top:24px">— Ivonne and Mr. D</p>
  `);

  const text = `Payment request for your Gläserne Leidenschaft order

Hello ${firstName},

Your order has been approved. Here is what you ordered:

Order: ${orderRef}

${itemRowsText || `(${items.length} item${items.length === 1 ? "" : "s"})`}

${totalsText}
${optionalNoteText}
How to pay
Please send payment via PayPal to: glasbaetz@hotmail.com
Please include order reference ${orderRef} in the PayPal memo.

Payment is due within three (3) days via PayPal.

Questions? Reply to this email or write to ${REPLY_TO}.

— Ivonne and Mr. D`;

  const sendResult = await sendEmail(apiKey, {
    to: order.email,
    subject: `Payment request — Gläserne Leidenschaft order ${orderRef}`,
    html,
    text,
  });

  const stampRes = await sb
    .from("orders")
    .update({
      payment_request_sent_at: new Date().toISOString(),
      payment_request_sent_by: adminEmail || null,
    })
    .eq("id", orderId);
  if (stampRes.error) {
    console.warn("payment_request audit stamp failed:", stampRes.error);
  }

  return { ok: true, sent: sendResult, amount: paymentAmount };
}

async function handleUnbanEmail(sb: any, email: string, unbanReason: string, adminEmail?: string) {
  if (!email) throw new Error("Missing email for unban_email");
  if (!unbanReason || !unbanReason.trim()) {
    throw new Error("An unban reason is required.");
  }
  const normalized = String(email).toLowerCase().trim();
  const whoUnbanned = adminEmail?.trim() || "(unknown admin)";

  const { count: removed, error: delErr } = await sb
    .from("banned_emails")
    .delete({ count: "exact" })
    .eq("email", normalized);
  if (delErr) throw new Error("Failed to remove from banned_emails: " + delErr.message);
  if (!removed) {
    return { ok: true, removed: 0, note: "Email was not in the banned list." };
  }

  const { data: auditRows } = await sb
    .from("deleted_accounts_audit")
    .select("id")
    .eq("deleted_user_email", normalized)
    .eq("banned", true)
    .order("deleted_at", { ascending: false })
    .limit(1);
  if (auditRows && auditRows[0]) {
    const noteText = `Unbanned ${new Date().toISOString()} by ${whoUnbanned}. Reason: ${unbanReason.trim()}`;
    await sb.from("deleted_accounts_audit")
      .update({ banned: false, ban_reason: noteText })
      .eq("id", auditRows[0].id);
  }

  return { ok: true, removed };
}

async function sendAccountRemovedEmail(apiKey: string, profile: any, reason?: string) {
  const first = profile.first_name || "there";
  const reasonBlock = reason && reason.trim()
    ? `<p>${escapeHtml(reason)}</p>`
    : "";
  return sendEmail(apiKey, {
    to: profile.email,
    subject: "Your Gläserne Leidenschaft account has been removed",
    html: wrapEmail(`
      <h2 style="color:${NAVY};margin:0 0 16px">Hello ${escapeHtml(first)},</h2>
      <p>Your Gläserne Leidenschaft account has been removed. You no longer have access to the site, and any orders associated with your account have been cancelled.</p>
      ${reasonBlock}
      <p style="margin-top:24px">Gläserne Leidenschaft</p>
      <p style="color:${MUTED};font-size:12px;font-style:italic;margin-top:20px;border-top:1px solid #e6dfce;padding-top:12px">
        This email is not monitored. Please do not reply.
      </p>
    `),
  });
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

async function sendEmail(
  apiKey: string,
  { to, subject, html, text }: { to: string; subject: string; html: string; text?: string }
) {
  if (!to) throw new Error("Missing recipient email");
  const payload: any = {
    from: FROM_EMAIL,
    to: [to],
    reply_to: REPLY_TO,
    subject,
    html,
  };
  if (text) payload.text = text;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return { ok: true, id: data?.id };
}

// ════════════════════════════════════════════════════════════════════════
// Phase 6.34b: sendAdminAlert now takes the supabase client and looks up
// the recipient list from public.admins at call time. If the table is
// empty or the query fails, the alert is skipped (logged) rather than
// throwing — admin alerts should never break a user-facing flow.
// ════════════════════════════════════════════════════════════════════════
async function sendAdminAlert(
  sb: any,
  apiKey: string,
  { subject, html }: { subject: string; html: string }
) {
  const recipients = await getAdminEmails(sb);
  if (recipients.length === 0) {
    console.warn("[sendAdminAlert] No admin recipients found in public.admins; skipping alert");
    return { ok: true, skipped: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: recipients,
      reply_to: REPLY_TO,
      subject,
      html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return { ok: true, id: data?.id, recipients: recipients.length };
}

function wrapEmail(innerHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:${BG};font-family:Georgia,'Times New Roman',serif;color:${INK}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:560px;border:1px solid #e6dfce;border-radius:4px;overflow:hidden">
        <tr><td style="padding:28px 32px 20px 32px;border-bottom:2px solid ${GOLD}">
          <div style="font-family:Georgia,serif;font-size:22px;color:${NAVY};letter-spacing:1px">Gläserne Leidenschaft</div>
          <div style="font-family:Georgia,serif;font-size:12px;font-style:italic;color:${MUTED};margin-top:4px">Glas &amp; Weihnachtsschmuck der besonderen Art</div>
        </td></tr>
        <tr><td style="padding:28px 32px;line-height:1.6;font-size:15px">${innerHtml}</td></tr>
        <tr><td style="padding:16px 32px;background:${BG};border-top:1px solid #e6dfce;font-size:11px;color:${MUTED};text-align:center;font-style:italic">
          Gläserne Leidenschaft · Lauscha, Germany · <a href="mailto:${REPLY_TO}" style="color:${MUTED}">${REPLY_TO}</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s: any): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(payload: any, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}