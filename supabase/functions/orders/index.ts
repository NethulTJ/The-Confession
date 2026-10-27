const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const statuses = ["pending", "confirmed", "preparing", "ready", "fulfilled", "cancelled"];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const senderDisplayName = "The Confession by the Leo Club of IIT";

async function adminUser(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY")!, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user.app_metadata?.role === "admin" ? user : null;
}

async function db(path: string, init: RequestInit = {}) {
  return fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`, "Content-Type": "application/json", ...init.headers },
  });
}

type EmailOrderItem = {
  id: string;
  flower_name: string;
  stem_quantity: number;
  selected_colors: string[];
  wrap_name: string;
  item_subtotal: number;
  notes: { note_text: string; note_type: "included" | "extra"; price: number }[];
};

const htmlEscapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>\"]/g, char => htmlEscapes[char]);
const formatLkr = (value: number) => `LKR ${Number(value).toLocaleString("en-LK")}`;
const encodeMime = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
  return base64.match(/.{1,76}/g)?.join("\r\n") ?? "";
};

const asciiPdfText = (value: unknown) => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "?");
const escapePdfText = (value: string) => asciiPdfText(value).replace(/([\\()])/g, "\\$1");
const base64Bytes = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));

function createInvoicePdf(orderNumber: string, customerName: string, recipientName: string, items: EmailOrderItem[], subtotal: number, createdAt = new Date()) {
  const headerLines = [
    { text: "THE CONFESSION", size: 22, color: "0.42 0.15 0.24" },
    { text: "ORDER INVOICE", size: 11, color: "0.55 0.38 0.39" },
    { text: `Order number: ${orderNumber}`, size: 12, color: "0.22 0.16 0.18" },
    { text: `Date: ${createdAt.toLocaleDateString("en-GB", { timeZone: "Asia/Colombo" })}`, size: 10, color: "0.38 0.31 0.31" },
    { text: `Ordered by: ${customerName}`, size: 10, color: "0.38 0.31 0.31" },
    { text: `Prepared for: ${recipientName}`, size: 10, color: "0.38 0.31 0.31" },
    { text: "ITEMS", size: 10, color: "0.55 0.38 0.39" },
  ];
  const pages = [];
  for (let start = 0; start < items.length; start += 10) {
    const pageItems = items.slice(start, start + 10);
    const lines = [
      ...headerLines,
      ...pageItems.flatMap((item, index) => [
      { text: `${start + index + 1}. ${item.flower_name} - ${item.stem_quantity} ${item.stem_quantity === 1 ? "stem" : "stems"}`, size: 11, color: "0.22 0.16 0.18" },
      { text: `   Colors: ${item.selected_colors.join(", ") || "As selected"} | Wrap: ${item.wrap_name}`, size: 9, color: "0.38 0.31 0.31" },
      { text: `   Item total: ${formatLkr(item.item_subtotal)}`, size: 9, color: "0.38 0.31 0.31" },
      ]),
    ];
    if (start + 10 >= items.length) lines.push(
      { text: `ORDER TOTAL: ${formatLkr(subtotal)}`, size: 14, color: "0.42 0.15 0.24" },
      { text: "Payment is not collected online. Delivery will be arranged personally.", size: 9, color: "0.48 0.41 0.41" },
    );
    let y = 795;
    const commands = ["0.97 0.95 0.92 rg", "0 0 595 842 re f", "0.85 0.78 0.71 RG", "42 42 511 758 re S"];
    for (const [index, line] of lines.entries()) {
      if (index === 1) y -= 27;
      else if (index === 6 || line.text.startsWith("ORDER TOTAL")) y -= 25;
      else y -= line.size >= 11 ? 23 : 18;
      commands.push(`${line.color} rg BT /${line.size >= 11 ? "F2" : "F1"} ${line.size} Tf 58 ${y} Td (${escapePdfText(line.text)}) Tj ET`);
    }
    pages.push(commands.join("\n"));
  }
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
  const pageIds = pages.map((_, index) => 5 + index * 2);
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  for (const [index, stream] of pages.entries()) {
    const pageId = 5 + index * 2;
    const contentId = pageId + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

async function getOrderEmailItems(orderId: string): Promise<EmailOrderItem[]> {
  const [itemsResponse, notesResponse] = await Promise.all([
    db(`order_items?select=id,flower_name,stem_quantity,selected_colors,wrap_name,item_subtotal&order_id=eq.${encodeURIComponent(orderId)}&order=created_at.asc`),
    db(`order_notes?select=order_item_id,note_text,note_type,price&order_id=eq.${encodeURIComponent(orderId)}&order=created_at.asc`),
  ]);
  if (!itemsResponse.ok || !notesResponse.ok) throw new Error("Could not load the saved order details for email");
  const [items, notes] = await Promise.all([itemsResponse.json(), notesResponse.json()]);
  return items.map((item: any) => ({ ...item, notes: notes.filter((note: any) => note.order_item_id === item.id) }));
}

async function sendOrderConfirmation(to: string, customerName: string, recipientName: string, orderNumber: string, items: EmailOrderItem[], subtotal: number, invoicePdf: Uint8Array) {
  const username = Deno.env.get("GMAIL_USER");
  const appPassword = Deno.env.get("GMAIL_APP_PASSWORD")?.replace(/\s/g, "");
  const sender = Deno.env.get("GMAIL_SENDER_EMAIL") ?? username;
  if (!username || !appPassword || !sender) throw new Error("Gmail is not configured");
  if (!emailPattern.test(username) || !emailPattern.test(sender) || !emailPattern.test(to)) throw new Error("Invalid email configuration");

  const subject = `Your order from The Confession · ${orderNumber}`;
  const safeCustomer = customerName.trim() || "there";
  const textItems = items.map((item, index) => {
    const notes = item.notes.map(note => `${note.note_type === "extra" ? `Extra note (${formatLkr(note.price)})` : "Included note"}: “${note.note_text}”`).join("\n    ");
    return `${start + index + 1}. ${item.flower_name} · ${item.stem_quantity} ${item.stem_quantity === 1 ? "stem" : "stems"}\n    Colors: ${item.selected_colors.join(", ") || "As selected"}\n    Wrap: ${item.wrap_name}\n${notes ? `    ${notes}\n` : ""}    Item total: ${formatLkr(item.item_subtotal)}`;
  }).join("\n\n");
  const message = [
    `${senderDisplayName} · Order confirmation`,
    "",
    `Thank you, ${safeCustomer}. Your order is saved and being prepared with care.`,
    `Order number: ${orderNumber}`,
    `Prepared for: ${recipientName}`,
    "",
    "YOUR ORDER",
    textItems,
    "",
    `Order subtotal: ${formatLkr(subtotal)}`,
    "",
    "Delivery is arranged personally for our scheduled day at the fixed delivery point. We’ll be in touch to coordinate the details.",
    "",
    "With care,",
    senderDisplayName,
  ].join("\n");
  const itemHtml = items.map((item, index) => {
    const notesHtml = item.notes.length
      ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid #eee7df">${item.notes.map(note => `<p style="margin:5px 0;color:#69565a;font-size:13px"><strong style="color:#8a5961">${note.note_type === "extra" ? `PAID EXTRA NOTE · ${formatLkr(note.price)}` : "INCLUDED NOTE"}</strong><br>“${escapeHtml(note.note_text)}”</p>`).join("")}</div>`
      : "";
    return `<tr><td style="padding:18px 0;border-bottom:1px solid #eee7df"><div style="font-family:Georgia,serif;font-size:18px;color:#462f34">${index + 1}. ${escapeHtml(item.flower_name)} <span style="font-family:Arial,sans-serif;font-size:13px;color:#806d6c">· ${item.stem_quantity} ${item.stem_quantity === 1 ? "stem" : "stems"}</span></div><div style="margin-top:8px;color:#756567;font-size:13px;line-height:1.7">Colors: ${escapeHtml(item.selected_colors.join(", ") || "As selected")}<br>Wrap: ${escapeHtml(item.wrap_name)}</div>${notesHtml}<div style="margin-top:12px;text-align:right;font-size:13px;color:#593e43">Item total <strong>${formatLkr(item.item_subtotal)}</strong></div></td></tr>`;
  }).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f1eb;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#49383b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:0 auto;background:#fffdfa;border:1px solid #e9e0d6"><tr><td style="padding:34px 38px 26px;text-align:center;background:#542d38;color:#fff8ef"><div style="font-family:Georgia,serif;font-size:22px;letter-spacing:1px">The Confession</div><div style="margin-top:7px;font-size:10px;letter-spacing:1px;color:#e7d1c3">by the Leo Club of IIT</div></td></tr><tr><td style="padding:34px 38px 12px"><p style="margin:0 0 10px;color:#a2696a;font-size:10px;font-weight:bold;letter-spacing:2px">ORDER CONFIRMATION</p><h1 style="margin:0;font-family:Georgia,serif;font-size:30px;font-weight:normal;line-height:1.25;color:#462f34">Thank you, ${escapeHtml(safeCustomer)}.</h1><p style="margin:12px 0 0;color:#756567;font-size:14px;line-height:1.7">Your order is saved and being prepared with care.</p></td></tr><tr><td style="padding:18px 38px 22px"><div style="padding:15px 18px;background:#f7f1eb;border-left:3px solid #a76b70"><div style="font-size:9px;letter-spacing:1.5px;color:#967c75">ORDER NUMBER</div><div style="margin-top:5px;font-family:Georgia,serif;font-size:20px;color:#6d293f">${escapeHtml(orderNumber)}</div><div style="margin-top:9px;font-size:12px;color:#756567">Prepared for <strong style="color:#49383b">${escapeHtml(recipientName)}</strong></div></div></td></tr><tr><td style="padding:0 38px"><h2 style="margin:8px 0 0;font-family:Georgia,serif;font-size:20px;font-weight:normal;color:#462f34">Your order</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${itemHtml}<tr><td style="padding:18px 0 8px;text-align:right;color:#49383b;font-size:14px">Order subtotal <strong style="margin-left:12px;font-size:18px;color:#6d293f">${formatLkr(subtotal)}</strong></td></tr></table></td></tr><tr><td style="padding:24px 38px 34px"><div style="padding:18px 20px;background:#f7f1eb"><div style="font-family:Georgia,serif;font-size:17px;color:#513a3e">Delivery arrangements</div><p style="margin:8px 0 0;color:#756567;font-size:13px;line-height:1.7">Delivery is arranged personally for our scheduled day at the fixed delivery point. We’ll be in touch to coordinate the details.</p></div><p style="margin:24px 0 0;color:#756567;font-size:13px;line-height:1.7">With care,<br><strong style="color:#6d293f">${escapeHtml(senderDisplayName)}</strong></p></td></tr><tr><td style="padding:17px;text-align:center;background:#542d38;color:#e7d1c3;font-size:10px;letter-spacing:1px">MADE WITH CARE · COLOMBO</td></tr></table></body></html>`;
  const boundary = `secret_order_${crypto.randomUUID().replaceAll("-", "")}`;
  const encodedText = encodeMime(message);
  const encodedHtml = encodeMime(html);
  const conn = await Deno.connectTls({ hostname: "smtp.gmail.com", port: 465 });
  let pending = "";
  const readBuffer = new Uint8Array(1024);
  const decoder = new TextDecoder();

  const readLine = async () => {
    while (!pending.includes("\n")) {
      const count = await conn.read(readBuffer);
      if (count === null) throw new Error("Gmail closed the SMTP connection");
      pending += decoder.decode(readBuffer.subarray(0, count), { stream: true });
    }
    const index = pending.indexOf("\n");
    const line = pending.slice(0, index).replace(/\r$/, "");
    pending = pending.slice(index + 1);
    return line;
  };

  const expect = async (accepted: number[]) => {
    let line: string;
    do {
      line = await readLine();
    } while (/^\d{3}-/.test(line));
    const code = Number(line.slice(0, 3));
    if (!accepted.includes(code)) throw new Error(`Gmail SMTP ${code}: ${line.slice(4, 180)}`);
  };

  const command = async (value: string, accepted: number[]) => {
    const bytes = new TextEncoder().encode(`${value}\r\n`);
    let offset = 0;
    while (offset < bytes.length) offset += await conn.write(bytes.subarray(offset));
    await expect(accepted);
  };

  try {
    await expect([220]);
    await command("EHLO localhost", [250]);
    await command("AUTH LOGIN", [334]);
    await command(btoa(username), [334]);
    await command(btoa(appPassword), [235]);
    await command(`MAIL FROM:<${sender}>`, [250]);
    await command(`RCPT TO:<${to}>`, [250, 251]);
    await command("DATA", [354]);
    const data = [
      `From: ${senderDisplayName} <${sender}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: multipart/alternative; boundary="alt_' + boundary + '"',
      "",
      `--alt_${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      encodedText,
      `--alt_${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      encodedHtml,
      `--alt_${boundary}--`,
      `--${boundary}`,
      'Content-Type: application/pdf; name="' + orderNumber + '-invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="' + orderNumber + '-invoice.pdf"',
      "",
      base64Bytes(invoicePdf).match(/.{1,76}/g)?.join("\r\n") ?? "",
      `--${boundary}--`,
      ".",
    ].join("\r\n") + "\r\n";
    const bytes = new TextEncoder().encode(data);
    let offset = 0;
    while (offset < bytes.length) offset += await conn.write(bytes.subarray(offset));
    await expect([250]);
    await command("QUIT", [221]);
  } finally {
    conn.close();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    if (body.action === "create") {
      if (body.terms_accepted !== true) return reply({ error: "Please review and agree to the delivery terms before placing your order." }, 400);
      const c = body.customer ?? {};
      const recipientName = c.recipient_name ?? c.name;
      const recipientPhone = c.recipient_phone ?? c.phone;
      const valid = typeof c.name === "string" && c.name.trim().length > 0 && c.name.length <= 100 && typeof c.email === "string" && emailPattern.test(c.email.trim()) && c.email.length <= 254 && typeof c.phone === "string" && /^[+0-9() -]{7,20}$/.test(c.phone) && typeof recipientName === "string" && recipientName.trim().length > 0 && recipientName.length <= 100 && typeof recipientPhone === "string" && /^[+0-9() -]{7,20}$/.test(recipientPhone);
      if (!valid || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20 || !/^[0-9a-f-]{36}$/i.test(body.client_request_id ?? "")) return reply({ error: "Please check your contact, delivery, and order details." }, 400);
      const items = body.items.map((item: any) => ({
        flower_id: item.flower_id,
        stems: Number(item.stems),
        stemColors: Array.isArray(item.stemColors) ? item.stemColors : [],
        wrap: typeof item.wrap === "string" ? item.wrap.slice(0, 30) : "Oat",
        messages: Array.isArray(item.messages) ? item.messages : [],
        extraNoteCount: Number(item.extraNoteCount ?? 0),
      }));
      const allowedColors: Record<string, string[]> = { chrysanthemum: ["Pink", "Purple", "Red", "White", "Orange"], lilies: ["White", "Pink", "Orange"], rose: ["Red", "Pink", "White"] };
      if (items.some((item: any) => !["chrysanthemum", "lilies", "rose"].includes(item.flower_id) || !Number.isInteger(item.stems) || item.stems < 1 || item.stems > 4 || item.stemColors.length !== item.stems || item.stemColors.some((x: unknown) => !allowedColors[item.flower_id].includes(x as string)) || !Number.isInteger(item.extraNoteCount) || item.extraNoteCount < 0 || item.extraNoteCount > 10 || item.messages.length !== item.extraNoteCount && item.messages.length !== item.extraNoteCount + 1 || item.messages.some((x: unknown) => typeof x !== "string" || !x.trim() || x.length > 1600))) return reply({ error: "One of the flower selections or notes is invalid." }, 400);
      const created = await db("rpc/create_flower_order", { method: "POST", body: JSON.stringify({ p_order: { client_request_id: body.client_request_id, terms_accepted: true, terms_accepted_at: new Date().toISOString(), customer_name: c.name, customer_email: c.email, customer_phone: c.phone, recipient_name: recipientName, recipient_phone: recipientPhone, items } }) });
      const order = await created.json();
      if (!created.ok) return reply({ error: "We couldn’t save your order. Please try again." }, 400);
      // Email is attempted only after the atomic order transaction returns successfully.
      const emailConfigured = Boolean(Deno.env.get("GMAIL_USER") && Deno.env.get("GMAIL_APP_PASSWORD"));
      let emailItems: EmailOrderItem[] = [];
      let invoicePdf = new Uint8Array();
      try {
        emailItems = await getOrderEmailItems(order.id);
        invoicePdf = createInvoicePdf(order.order_number, c.name, recipientName, emailItems, Number(order.subtotal));
      } catch (error) {
        console.error("Order invoice generation failed", error instanceof Error ? error.message : "Unknown error");
      }
      if (!order.existing && emailConfigured && invoicePdf.length) {
        try {
          await sendOrderConfirmation(c.email, c.name, recipientName, order.order_number, emailItems, Number(order.subtotal), invoicePdf);
          await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "sent", confirmation_email_error: null }) });
          order.confirmation_email_status = "sent";
        } catch (error) {
          const detail = error instanceof Error ? error.message.slice(0, 200) : "Unknown Gmail SMTP error";
          console.error("Order confirmation email failed", detail);
          await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "failed", confirmation_email_error: detail }) });
          order.confirmation_email_status = "failed";
          order.confirmation_email_error = detail;
        }
      } else if (!emailConfigured) {
        order.confirmation_email_status = "not_configured";
      }
      return reply({ order: { ...order, invoice_pdf_base64: invoicePdf.length ? base64Bytes(invoicePdf) : null } }, 201);
    }

    const user = await adminUser(req);
    if (!user) return reply({ error: "Admin sign-in required." }, 401);
    if (body.action === "list") {
      const response = await db("orders?select=*&order=created_at.desc&limit=200");
      const orders = await response.json();
      if (!response.ok) return reply({ error: "Orders could not be loaded." }, 502);
      const ids = orders.map((o: any) => o.id);
      if (ids.length) {
        const [itemsRes, notesRes] = await Promise.all([db(`order_items?select=*&order_id=in.(${ids.join(",")})`), db(`order_notes?select=*&order_id=in.(${ids.join(",")})`) ]);
        const items = await itemsRes.json(); const notes = await notesRes.json();
        for (const order of orders) {
          order.items = items.filter((x: any) => x.order_id === order.id).map((item: any) => ({ ...item, notes: notes.filter((n: any) => n.order_item_id === item.id) }));
        }
      } else for (const order of orders) order.items = [];
      return reply({ orders });
    }
    if (body.action === "status") {
      if (typeof body.id !== "string" || !statuses.includes(body.status)) return reply({ error: "Invalid order status." }, 400);
      const response = await db(`orders?id=eq.${encodeURIComponent(body.id)}&select=id,order_number,status`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: body.status, updated_at: new Date().toISOString() }) });
      const rows = await response.json();
      if (!response.ok || !rows.length) return reply({ error: "Order status could not be updated." }, 400);
      return reply({ order: rows[0] });
    }
    if (body.action === "demand") {
      const from = new Date(body.from); const to = new Date(body.to);
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return reply({ error: "Choose a valid date range." }, 400);
      const response = await db(`orders?select=id,created_at,status&created_at=gte.${encodeURIComponent(from.toISOString())}&created_at=lte.${encodeURIComponent(to.toISOString())}&status=neq.cancelled`);
      const orders = await response.json(); if (!response.ok) return reply({ error: "Demand could not be loaded." }, 502);
      const ids = orders.map((o: any) => o.id);
      if (!ids.length) return reply({ demand: { stems: { chrysanthemum: 0, lilies: 0, rose: 0 }, notes: { total: 0, included: 0, extra: 0 }, included_statuses: statuses.filter(s => s !== "cancelled") } });
      const [itemsRes, notesRes] = await Promise.all([db(`order_items?select=flower_id,stem_quantity,order_id&order_id=in.(${ids.join(",")})`), db(`order_notes?select=note_type,order_id&order_id=in.(${ids.join(",")})`)]);
      const items = await itemsRes.json(); const notes = await notesRes.json();
      const stems = { chrysanthemum: 0, lilies: 0, rose: 0 };
      for (const item of items) stems[item.flower_id as keyof typeof stems] += item.stem_quantity;
      const included = notes.filter((n: any) => n.note_type === "included").length; const extra = notes.filter((n: any) => n.note_type === "extra").length;
      return reply({ demand: { stems, notes: { total: included + extra, included, extra }, included_statuses: statuses.filter(s => s !== "cancelled") } });
    }
    if (body.action === "retry_email") {
      const r = await db(`orders?id=eq.${encodeURIComponent(body.id)}&select=*`); const rows = await r.json(); const order = rows[0];
      if (!order) return reply({ error: "Order not found." }, 404);
      if (!Deno.env.get("GMAIL_USER") || !Deno.env.get("GMAIL_APP_PASSWORD")) return reply({ error: "Confirmation email is not configured." }, 503);
      try {
        const emailItems = await getOrderEmailItems(order.id);
        const invoicePdf = createInvoicePdf(order.order_number, order.customer_name, order.recipient_name, emailItems, Number(order.subtotal), new Date(order.created_at));
        await sendOrderConfirmation(order.customer_email, order.customer_name, order.recipient_name, order.order_number, emailItems, Number(order.subtotal), invoicePdf);
      } catch (error) {
        const detail = error instanceof Error ? error.message.slice(0, 200) : "Unknown Gmail SMTP error";
        console.error("Order confirmation retry failed", detail);
        await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "failed", confirmation_email_error: detail }) });
        return reply({ error: `Email retry failed: ${detail}` }, 502);
      }
      await db(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_email_status: "sent", confirmation_email_error: null }) });
      return reply({ ok: true });
    }
    return reply({ error: "Unknown action." }, 400);
  } catch {
    return reply({ error: "The request could not be completed." }, 500);
  }
});
