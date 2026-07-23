// Phase 6.58 — Visit logging endpoint (Cloudflare Pages Function).
// The pages send a tiny beacon here on load; Cloudflare provides the
// visitor's geo data (country / region / city) in request.cf, which the
// free dashboards never expose. One row per visit is stored in Supabase
// via the insert-only log_site_visit() RPC (see backups/phase6.58-visit-log.sql).
//
// Privacy: the visitor's IP is truncated (last octet dropped) before it
// leaves this function — the full IP is never stored anywhere.

const SB_URL = 'https://wjddakdiknuyqchzcdbc.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndqZGRha2Rpa251eXFjaHpjZGJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxMjIxMjksImV4cCI6MjA5MTY5ODEyOX0.MKt_gugn0uEuk2EiYHF0e2HU2gNFAmIHDUKgKm_x-Wk';

function anonymizeIp(ip) {
  if (!ip) return '';
  if (ip.indexOf(':') !== -1) {
    // IPv6 → keep the /48-ish prefix
    return ip.split(':').slice(0, 3).join(':') + '::';
  }
  return ip.split('.').slice(0, 3).join('.') + '.0';
}

export async function onRequestPost(context) {
  const { request } = context;
  const cf = request.cf || {};

  let body = {};
  try { body = await request.json(); } catch (e) {}

  const payload = {
    p: {
      page: String(body.page || '').slice(0, 120),
      country: cf.country || request.headers.get('cf-ipcountry') || '',
      region: cf.region || '',
      city: cf.city || '',
      ip: anonymizeIp(request.headers.get('cf-connecting-ip') || ''),
      ref: String(body.ref || '').slice(0, 200),
      ua: (request.headers.get('user-agent') || '').slice(0, 160),
      lang: String(body.lang || '').slice(0, 16),
    },
  };

  const res = await fetch(SB_URL + '/rest/v1/rpc/log_site_visit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SB_ANON,
      authorization: 'Bearer ' + SB_ANON,
    },
    body: JSON.stringify(payload),
  });

  // 204 = row stored; 500 = the RPC is missing or failed (run the
  // phase6.58 SQL in the Supabase SQL editor).
  return new Response(null, { status: res.ok ? 204 : 500 });
}
