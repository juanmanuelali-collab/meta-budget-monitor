'use strict';
require('dotenv').config();
const express  = require('express');
const cron     = require('node-cron');
const fetch    = require('node-fetch');
const path     = require('path');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const { generateConsolidatedEmail } = require('./templates/email');

const app  = express();
const PORT = process.env.PORT || 3002;

const META_TOKEN     = process.env.META_ACCESS_TOKEN;
const RESEND_KEY     = process.env.RESEND_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'docta2024';
const FROM_EMAIL     = process.env.FROM_EMAIL     || 'reportes@doctanexus.com';
const FROM_NAME      = process.env.FROM_NAME      || 'Meta Budget Monitor · Docta Nexus';
const SUPA_URL       = process.env.SUPABASE_URL;
const SUPA_KEY       = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const TZ             = 'America/Argentina/Buenos_Aires';

const resend = new Resend(RESEND_KEY);
let supabase = null;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── SUPABASE ──────────────────────────────────────────────────
function getDB() {
  if (!supabase) {
    if (!SUPA_URL || !SUPA_KEY) throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY');
    supabase = createClient(SUPA_URL, SUPA_KEY);
  }
  return supabase;
}

async function loadSettings() {
  try {
    const { data } = await getDB().from('budget_settings').select('data').eq('key', 'global').single();
    return data?.data || {};
  } catch { return {}; }
}

async function saveSettings(settings) {
  try {
    await getDB().from('budget_settings').upsert({ key: 'global', data: settings }, { onConflict: 'key' });
    return true;
  } catch(e) { console.error('[settings save]', e.message); return false; }
}

async function loadClients() {
  try {
    const { data, error } = await getDB().from('budget_clients').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch(e) { console.error('[load clients]', e.message); return []; }
}

async function loadClient(id) {
  try {
    const { data, error } = await getDB().from('budget_clients').select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  } catch { return null; }
}

async function saveClient(clientData) {
  try {
    const db = getDB();
    if (clientData.id) {
      const { id, ...fields } = clientData;
      const { data, error } = await db.from('budget_clients').update(fields).eq('id', id).select().single();
      if (error) throw error;
      return data;
    } else {
      const { id, ...fields } = clientData;
      const { data, error } = await db.from('budget_clients').insert(fields).select().single();
      if (error) throw error;
      return data;
    }
  } catch(e) { console.error('[save client]', e.message); return null; }
}

async function deleteClient(id) {
  try {
    const { error } = await getDB().from('budget_clients').delete().eq('id', id);
    if (error) throw error;
    return true;
  } catch(e) { console.error('[delete client]', e.message); return false; }
}

async function loadHistory() {
  try {
    const { data } = await getDB().from('budget_history').select('*').order('sent_at', { ascending: false }).limit(50);
    return data || [];
  } catch { return []; }
}

async function saveHistory(entry) {
  try {
    await getDB().from('budget_history').insert(entry);
  } catch(e) { console.error('[history save]', e.message); }
}

// ── META API ──────────────────────────────────────────────────
function dateStr(d) { return d.toISOString().split('T')[0]; }

async function metaGet(endpoint, token) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const r = await fetch(`https://graph.facebook.com/v19.0${endpoint}${sep}access_token=${token}`);
  const d = await r.json();
  if (d.error) throw new Error(`Meta API: ${d.error.message}`);
  return d;
}

function getFields(clientType) {
  const base = 'spend,impressions,clicks,ctr,cpm,reach,frequency';
  if (clientType === 'ecommerce') return base + ',purchase_roas,cost_per_action_type,actions,action_values';
  if (clientType === 'leads')     return base + ',cost_per_action_type,actions';
  return base;
}

function parseMetrics(d, clientType) {
  const a = d.data?.[0] || {};
  const actions        = a.actions             || [];
  const costPerAction  = a.cost_per_action_type || [];
  const actionValues   = a.action_values        || [];

  const findAction = (type) => parseFloat(actions.find(x => x.action_type === type)?.value || 0);
  const findValue  = (type) => parseFloat(actionValues.find(x => x.action_type === type)?.value || 0);

  const base = {
    spend:       parseFloat(a.spend       || 0),
    impressions: parseInt(a.impressions   || 0),
    clicks:      parseInt(a.clicks        || 0),
    ctr:         parseFloat(a.ctr         || 0),
    cpm:         parseFloat(a.cpm         || 0),
    reach:       parseInt(a.reach         || 0),
    frequency:   parseFloat(a.frequency   || 0),
  };

  if (clientType === 'ecommerce') {
    const roas      = a.purchase_roas?.[0]?.value ? parseFloat(a.purchase_roas[0].value) : 0;
    const purchases = findAction('purchase');
    const revenue   = findValue('purchase');
    const cpa       = purchases > 0 ? base.spend / purchases : 0;
    return { ...base, roas, purchases, revenue, cpa };
  }
  if (clientType === 'leads') {
    const leads = findAction('lead') || findAction('onsite_conversion.lead_grouped');
    const cpl   = leads > 0 ? base.spend / leads : 0;
    return { ...base, leads, cpl };
  }
  return base;
}

async function fetchClientMetrics(client) {
  const token       = META_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN no configurado');

  const adAccountId = client.ad_account_id;
  const clientType  = client.client_type || 'general';
  const fields      = getFields(clientType);

  const today          = new Date();
  const yesterday      = new Date(today - 86400000);
  const monthStart     = new Date(today.getFullYear(), today.getMonth(), 1);
  const weekAgo        = new Date(today - 7 * 86400000);
  const twoWeeksAgo    = new Date(today - 14 * 86400000);
  const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevMonthSameDay = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate() - 1);

  const makeRange = (since, until, extraFields) =>
    `/${adAccountId}/insights?time_range=${encodeURIComponent(JSON.stringify({ since: dateStr(since), until: dateStr(until) }))}&fields=${extraFields || fields}&level=account`;

  const makeDailyRange = (since, until) =>
    `/${adAccountId}/insights?time_range=${encodeURIComponent(JSON.stringify({ since: dateStr(since), until: dateStr(until) }))}&fields=spend,date_start&time_increment=1&level=account`;

  const [yd, mo, lastWeek, prevWeek, prevMonth, daily] = await Promise.all([
    metaGet(makeRange(yesterday, yesterday), token),
    metaGet(makeRange(monthStart, yesterday), token),
    metaGet(makeRange(weekAgo, yesterday), token),
    metaGet(makeRange(twoWeeksAgo, new Date(today - 8 * 86400000)), token),
    prevMonthSameDay >= prevMonthStart
      ? metaGet(makeRange(prevMonthStart, prevMonthSameDay), token)
      : Promise.resolve({ data: [] }),
    metaGet(makeDailyRange(new Date(today - 14 * 86400000), yesterday), token),
  ]);

  return {
    yesterday:  parseMetrics(yd, clientType),
    month:      parseMetrics(mo, clientType),
    lastWeek:   parseMetrics(lastWeek, clientType),
    prevWeek:   parseMetrics(prevWeek, clientType),
    prevMonth:  parseMetrics(prevMonth, clientType),
    dailySpend: (daily.data || []).map(d => ({ date: d.date_start, spend: parseFloat(d.spend || 0) })),
  };
}

// ── ALERTAS ───────────────────────────────────────────────────
function evaluateClient(client, metrics) {
  const alerts = [];
  if (!metrics) return alerts;

  const spendMonth     = metrics.month?.spend     || 0;
  const spendYesterday = metrics.yesterday?.spend  || 0;
  const budget         = client.monthly_budget     || 0;
  const daysInMonth    = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dayOfMonth     = new Date().getDate();
  const pct            = budget > 0 ? (spendMonth / budget) * 100 : 0;
  const idealPct       = (dayOfMonth / daysInMonth) * 100;
  const deviation      = pct - idealPct;

  if (spendYesterday === 0)
    alerts.push({ type: 'critical', msg: 'Sin gasto ayer — verificar campañas activas' });
  if (budget > 0 && pct >= 100)
    alerts.push({ type: 'critical', msg: `Presupuesto agotado: ${Math.round(pct)}% consumido` });
  else if (budget > 0 && deviation > 20)
    alerts.push({ type: 'critical', msg: `Pacing +${Math.round(deviation)}pp — riesgo de sobreinversión` });
  else if (budget > 0 && deviation < -20)
    alerts.push({ type: 'critical', msg: `Pacing ${Math.round(deviation)}pp — bajo consumo crítico` });
  else if (budget > 0 && Math.abs(deviation) > 10)
    alerts.push({ type: 'warning', msg: `Pacing ${deviation > 0 ? '+' : ''}${Math.round(deviation)}pp vs ideal` });

  const freq = metrics.month?.frequency || 0;
  if (freq > 4)      alerts.push({ type: 'critical', msg: `Frecuencia ${freq.toFixed(1)} — audiencia saturada` });
  else if (freq > 3) alerts.push({ type: 'warning',  msg: `Frecuencia ${freq.toFixed(1)} — monitorear` });

  const cpmNow = metrics.lastWeek?.cpm || 0, cpmPrev = metrics.prevWeek?.cpm || 0;
  if (cpmPrev > 0 && cpmNow > 0) {
    const d = ((cpmNow - cpmPrev) / cpmPrev) * 100;
    if (d > 60)      alerts.push({ type: 'critical', msg: `CPM subió ${Math.round(d)}% vs semana anterior` });
    else if (d > 30) alerts.push({ type: 'warning',  msg: `CPM subió ${Math.round(d)}% vs semana anterior` });
  }

  const ctrNow = metrics.lastWeek?.ctr || 0, ctrPrev = metrics.prevWeek?.ctr || 0;
  if (ctrPrev > 0 && ctrNow > 0) {
    const d = ((ctrNow - ctrPrev) / ctrPrev) * 100;
    if (d < -30) alerts.push({ type: 'warning', msg: `CTR cayó ${Math.round(Math.abs(d))}% vs semana anterior` });
  }

  if (client.client_type === 'ecommerce') {
    const roasNow = metrics.lastWeek?.roas || 0, roasPrev = metrics.prevWeek?.roas || 0;
    if (roasPrev > 0 && roasNow > 0) {
      const d = ((roasNow - roasPrev) / roasPrev) * 100;
      if (d < -35) alerts.push({ type: 'critical', msg: `ROAS cayó ${Math.round(Math.abs(d))}% vs semana anterior` });
    }
    if ((metrics.lastWeek?.purchases || 0) === 0 && spendMonth > 0)
      alerts.push({ type: 'warning', msg: 'Sin conversiones en los últimos 7 días' });
  }

  if (client.client_type === 'leads') {
    if ((metrics.lastWeek?.leads || 0) === 0 && spendMonth > 0)
      alerts.push({ type: 'warning', msg: 'Sin leads en los últimos 7 días' });
  }

  return alerts;
}

// ── HEALTH SCORE ──────────────────────────────────────────────
function calcHealthScore(client, metrics) {
  if (!metrics) return null;
  let score = 100;
  const reasons = [];

  const budget      = client.monthly_budget || 0;
  const spendMonth  = metrics.month?.spend  || 0;
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dayOfMonth  = new Date().getDate();
  const pct         = budget > 0 ? (spendMonth / budget) * 100 : 50;
  const idealPct    = (dayOfMonth / daysInMonth) * 100;
  const deviation   = Math.abs(pct - idealPct);

  // Pacing (25pts)
  if      (deviation <= 5)  { /* ok */ }
  else if (deviation <= 10) { score -= 8;  reasons.push('Pacing levemente desviado'); }
  else if (deviation <= 20) { score -= 15; reasons.push('Pacing con desvío moderado'); }
  else                      { score -= 25; reasons.push('Pacing muy desviado'); }

  // Sin gasto ayer (10pts)
  if ((metrics.yesterday?.spend || 0) === 0) { score -= 10; reasons.push('Sin gasto ayer'); }

  // Frecuencia (10pts)
  const freq = metrics.month?.frequency || 0;
  if      (freq > 4) { score -= 10; reasons.push('Frecuencia alta'); }
  else if (freq > 3) { score -= 5;  reasons.push('Frecuencia moderada'); }

  // CTR (10pts)
  const ctr = metrics.month?.ctr || 0;
  if      (ctr < 0.5) { score -= 10; reasons.push('CTR muy bajo'); }
  else if (ctr < 1)   { score -= 5;  reasons.push('CTR bajo'); }

  // CPM variación (10pts)
  const cpmNow = metrics.lastWeek?.cpm || 0, cpmPrev = metrics.prevWeek?.cpm || 0;
  if (cpmPrev > 0 && cpmNow > 0) {
    const d = ((cpmNow - cpmPrev) / cpmPrev) * 100;
    if      (d > 60) { score -= 10; reasons.push('CPM muy alto'); }
    else if (d > 30) { score -= 5;  reasons.push('CPM en alza'); }
  }

  // ROAS vs objetivo — ecommerce (25pts)
  if (client.client_type === 'ecommerce') {
    const roasA = metrics.month?.roas    || 0;
    const roasT = client.target_roas     || 0;
    if (roasT > 0 && roasA > 0) {
      const p = (roasA / roasT) * 100;
      if      (p >= 100) { /* ok */ }
      else if (p >= 80)  { score -= 8;  reasons.push('ROAS levemente bajo objetivo'); }
      else if (p >= 60)  { score -= 15; reasons.push('ROAS bajo objetivo'); }
      else               { score -= 25; reasons.push('ROAS muy lejos del objetivo'); }
    }
    if ((metrics.month?.purchases || 0) === 0) { score -= 15; reasons.push('Sin conversiones'); }
  }

  // CPL vs objetivo — leads (25pts)
  if (client.client_type === 'leads') {
    const cplA = metrics.month?.cpl || 0;
    const cplT = client.target_cpl  || 0;
    if (cplT > 0 && cplA > 0) {
      const p = (cplT / cplA) * 100;
      if      (p >= 100) { /* ok */ }
      else if (p >= 80)  { score -= 8;  reasons.push('CPL levemente sobre objetivo'); }
      else if (p >= 60)  { score -= 15; reasons.push('CPL sobre objetivo'); }
      else               { score -= 25; reasons.push('CPL muy sobre objetivo'); }
    }
    if ((metrics.month?.leads || 0) === 0) { score -= 15; reasons.push('Sin leads'); }
  }

  score = Math.max(0, Math.min(100, score));
  let label, color;
  if      (score >= 80) { label = 'Excelente'; color = 'success'; }
  else if (score >= 60) { label = 'Normal';    color = 'amber'; }
  else if (score >= 40) { label = 'Atención';  color = 'amber'; }
  else                  { label = 'Crítico';   color = 'danger'; }

  return { score, label, color, reasons };
}

// ── FORECAST IA ───────────────────────────────────────────────
async function generateForecast(client, metrics) {
  if (!ANTHROPIC_KEY || !metrics) return null;
  try {
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const dayOfMonth  = new Date().getDate();
    const context = {
      cliente: client.name,
      tipo: client.client_type || 'general',
      presupuesto: client.monthly_budget,
      moneda: client.currency,
      diaActual: dayOfMonth,
      diasRestantes: daysInMonth - dayOfMonth,
      gastoMes: metrics.month?.spend,
      gastoAyer: metrics.yesterday?.spend,
      ctr: metrics.month?.ctr,
      cpm: metrics.month?.cpm,
      frecuencia: metrics.month?.frequency,
      ...(client.client_type === 'ecommerce' && {
        roas: metrics.month?.roas, ingresos: metrics.month?.revenue,
        compras: metrics.month?.purchases, roasObjetivo: client.target_roas,
      }),
      ...(client.client_type === 'leads' && {
        leads: metrics.month?.leads, cpl: metrics.month?.cpl, cplObjetivo: client.target_cpl,
      }),
    };

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: `Sos un analista de performance en Meta Ads para la agencia Docta Nexus.
Dado el estado actual de una cuenta, generá un forecast conciso y accionable.
Responde SOLO con un objeto JSON con estas claves:
- gastoEsperado: número (gasto proyectado a fin de mes)
- metricaEsperada: número (ROAS o CPL proyectado según tipo, o 0 si general)
- insight: string corto (máx 100 chars, español, accionable, sin emojis)
- recomendacion: string corto (máx 100 chars, español, qué ajustar)
Solo el JSON puro, sin markdown.`,
        messages: [{ role: 'user', content: JSON.stringify(context) }],
      }),
    });

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch(e) { console.error('[forecast]', e.message); return null; }
}

// ── REPORTE EMAIL ─────────────────────────────────────────────
async function sendConsolidatedReport(scheduleType = 'daily', force = false) {
  const settings   = await loadSettings();
  const recipients = settings.recipients || [];
  if (!recipients.length && !force) return { ok: false, error: 'Sin destinatarios' };

  const allClients    = await loadClients();
  const activeClients = allClients.filter(c => c.active);
  if (!activeClients.length) return { ok: false, error: 'Sin clientes activos' };

  const clientsWithMetrics = await Promise.all(
    activeClients.map(async (client) => {
      try {
        const metrics = await fetchClientMetrics(client);
        const alerts  = evaluateClient(client, metrics);
        const health  = calcHealthScore(client, metrics);
        return { client, metrics, alerts, health, error: null };
      } catch(e) {
        return { client, metrics: null, alerts: [], health: null, error: e.message };
      }
    })
  );

  const now        = new Date();
  const reportDate = now.toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ });
  const html       = generateConsolidatedEmail({
    clients: clientsWithMetrics.filter(c => c.metrics),
    reportDate: reportDate.charAt(0).toUpperCase() + reportDate.slice(1),
    scheduleType,
  });

  const typeLabel = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual' }[scheduleType] || 'Diario';
  const subject   = `Reporte ${typeLabel} Presupuestos Meta Ads — ${now.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const to        = force && recipients.length === 0 ? [FROM_EMAIL] : recipients;

  try {
    await resend.emails.send({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to, subject, html });
    const alertCount = clientsWithMetrics.filter(c => c.metrics).reduce((s, { alerts }) => s + alerts.length, 0);
    await saveHistory({ sent_at: now.toISOString(), type: scheduleType, clients_count: clientsWithMetrics.filter(c => c.metrics).length, alerts_count: alertCount, recipients: to.length });
    return { ok: true, sent: to.length, clients: clientsWithMetrics.filter(c => c.metrics).length };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ── CRON ──────────────────────────────────────────────────────
const activeJobs = {};
function registerJob(type, expr) {
  if (activeJobs[type]) { activeJobs[type].stop(); delete activeJobs[type]; }
  if (!expr || !cron.validate(expr)) return false;
  activeJobs[type] = cron.schedule(expr, () => sendConsolidatedReport(type), { timezone: TZ });
  return true;
}
async function initCron() {
  const s = (await loadSettings()).schedule || {};
  if (s.daily?.enabled)   registerJob('daily',   `${s.daily.minute||0} ${s.daily.hour??9} * * *`);
  if (s.weekly?.enabled)  registerJob('weekly',  `${s.weekly.minute||0} ${s.weekly.hour??9} * * ${s.weekly.dow??1}`);
  if (s.monthly?.enabled) registerJob('monthly', `${s.monthly.minute||0} ${s.monthly.hour??9} ${s.monthly.day??1} * *`);
}

// ── AUTH ──────────────────────────────────────────────────────
function auth(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ── ROUTES ────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
});

app.get('/api/clients', auth, async (req, res) => {
  try { res.json(await loadClients()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', auth, async (req, res) => {
  try {
    const { name, ad_account_id, monthly_budget, currency, active, notes,
            client_type, target_roas, target_cpl, target_leads, target_revenue } = req.body;
    if (!name || !ad_account_id) return res.status(400).json({ error: 'name y ad_account_id requeridos' });
    res.json(await saveClient({
      name: name.trim(), ad_account_id: ad_account_id.trim(),
      monthly_budget: parseFloat(monthly_budget) || 0,
      currency: currency || 'ARS', active: active !== false,
      notes: notes || '', client_type: client_type || 'general',
      target_roas: parseFloat(target_roas) || null,
      target_cpl: parseFloat(target_cpl) || null,
      target_leads: parseInt(target_leads) || null,
      target_revenue: parseFloat(target_revenue) || null,
      created_at: new Date().toISOString(),
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', auth, async (req, res) => {
  try {
    const { name, ad_account_id, monthly_budget, currency, active, notes,
            client_type, target_roas, target_cpl, target_leads, target_revenue } = req.body;
    res.json(await saveClient({
      id: req.params.id,
      name: name?.trim(), ad_account_id: ad_account_id?.trim(),
      monthly_budget: parseFloat(monthly_budget) || 0,
      currency: currency || 'ARS', active: active !== false,
      notes: notes || '', client_type: client_type || 'general',
      target_roas: parseFloat(target_roas) || null,
      target_cpl: parseFloat(target_cpl) || null,
      target_leads: parseInt(target_leads) || null,
      target_revenue: parseFloat(target_revenue) || null,
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  try { await deleteClient(req.params.id); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clients/:id/metrics', auth, async (req, res) => {
  try {
    const client = await loadClient(req.params.id);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(await fetchClientMetrics(client));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const clients = await loadClients();
    const results = await Promise.all(
      clients.filter(c => c.active).map(async (client) => {
        try {
          const metrics  = await fetchClientMetrics(client);
          const alerts   = evaluateClient(client, metrics);
          const health   = calcHealthScore(client, metrics);
          const forecast = await generateForecast(client, metrics);
          return { client, metrics, alerts, health, forecast };
        } catch(e) {
          return { client, metrics: null, alerts: [], health: null, forecast: null, error: e.message };
        }
      })
    );
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings', auth, async (req, res) => {
  try { res.json(await loadSettings()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', auth, async (req, res) => {
  try {
    if (await saveSettings(req.body)) { await initCron(); res.json({ ok: true }); }
    else res.status(500).json({ error: 'Error guardando settings' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/send-test', auth, async (req, res) => {
  try { res.json(await sendConsolidatedReport(req.body.type || 'daily', true)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', auth, async (req, res) => {
  try { res.json(await loadHistory()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (_, res) => res.json({ ok: true, version: '2.0.0' }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log(`[server] Meta Budget Monitor v2 · Puerto ${PORT}`);
  await initCron();
});
