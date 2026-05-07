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
const TZ             = 'America/Argentina/Buenos_Aires';

const resend = new Resend(RESEND_KEY);
let supabase = null;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── SUPABASE ──────────────────────────────────────────────────
function getDB() {
  if (!supabase) {
    if (!SUPA_URL || !SUPA_KEY) throw new Error('Faltan SUPABASE_URL y SUPABASE_ANON_KEY');
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
      // UPDATE
      const { id, ...fields } = clientData;
      const { data, error } = await db.from('budget_clients').update(fields).eq('id', id).select().single();
      if (error) throw error;
      return data;
    } else {
      // INSERT
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

async function fetchClientMetrics(adAccountId) {
  const token = META_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN no configurado');

  const today      = new Date();
  const yesterday  = new Date(today - 86400000);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const fields = 'spend,impressions,clicks,ctr,cpm,reach';

  const makeRange = (since, until) =>
    `/${adAccountId}/insights?time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&fields=${fields}&level=account`;

  const [yd, mo] = await Promise.all([
    metaGet(makeRange(dateStr(yesterday), dateStr(yesterday)), token),
    metaGet(makeRange(dateStr(monthStart), dateStr(yesterday)), token),
  ]);

  const parse = (d) => {
    const a = d.data?.[0] || {};
    return {
      spend:       parseFloat(a.spend       || 0),
      impressions: parseInt(a.impressions   || 0),
      clicks:      parseInt(a.clicks        || 0),
      ctr:         parseFloat(a.ctr         || 0),
      cpm:         parseFloat(a.cpm         || 0),
      reach:       parseInt(a.reach         || 0),
    };
  };

  return { yesterday: parse(yd), month: parse(mo) };
}

// ── ALERTAS ───────────────────────────────────────────────────
function evaluateClient(client, metrics) {
  const alerts = [];
  const spendMonth     = metrics?.month?.spend || 0;
  const spendYesterday = metrics?.yesterday?.spend || 0;
  const budget         = client.monthly_budget || 0;
  const pct            = budget > 0 ? (spendMonth / budget) * 100 : 0;

  const daysInMonth  = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dayOfMonth   = new Date().getDate();
  const projectedSpend = dayOfMonth > 1 ? (spendMonth / (dayOfMonth - 1)) * daysInMonth : 0;

  if (spendYesterday === 0)
    alerts.push({ type: 'critical', msg: 'Sin gasto ayer — verificar campañas activas' });
  if (budget > 0 && pct >= 100)
    alerts.push({ type: 'critical', msg: `Presupuesto agotado: ${Math.round(pct)}% consumido` });
  else if (budget > 0 && pct >= 80)
    alerts.push({ type: 'warning', msg: `${Math.round(pct)}% del presupuesto consumido` });
  if (budget > 0 && dayOfMonth > 5 && projectedSpend < budget * 0.85)
    alerts.push({ type: 'warning', msg: `Ritmo bajo: proyección $${Math.round(projectedSpend).toLocaleString('es-AR')} (${Math.round((projectedSpend/budget)*100)}% del presupuesto)` });
  if (budget > 0 && projectedSpend > budget * 1.1)
    alerts.push({ type: 'warning', msg: `Ritmo alto: proyección supera presupuesto en ${Math.round(((projectedSpend/budget)-1)*100)}%` });

  return alerts;
}

// ── ENVÍO CONSOLIDADO ─────────────────────────────────────────
async function sendConsolidatedReport(scheduleType = 'daily', force = false) {
  console.log(`[report] Iniciando reporte ${scheduleType}${force ? ' (forzado)' : ''}`);

  const settings = await loadSettings();
  const recipients = settings.recipients || [];
  if (!recipients.length && !force) {
    console.warn('[report] Sin destinatarios configurados');
    return { ok: false, error: 'Sin destinatarios' };
  }

  const allClients = await loadClients();
  const activeClients = allClients.filter(c => c.active);
  if (!activeClients.length) {
    console.warn('[report] Sin clientes activos');
    return { ok: false, error: 'Sin clientes activos' };
  }

  // Fetch métricas de todos los clientes en paralelo
  const clientsWithMetrics = await Promise.all(
    activeClients.map(async (client) => {
      try {
        const metrics = await fetchClientMetrics(client.ad_account_id);
        return { client, metrics, error: null };
      } catch(e) {
        console.error(`[metrics] Error ${client.name}:`, e.message);
        return { client, metrics: null, error: e.message };
      }
    })
  );

  const now = new Date();
  const reportDate = now.toLocaleDateString('es-AR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ
  });

  const html = generateConsolidatedEmail({
    clients: clientsWithMetrics.filter(c => c.metrics),
    reportDate: reportDate.charAt(0).toUpperCase() + reportDate.slice(1),
    scheduleType,
  });

  const typeLabel = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual' }[scheduleType] || 'Diario';
  const subject = `Reporte ${typeLabel} Presupuestos Meta Ads — ${now.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const to = force && recipients.length === 0 ? [FROM_EMAIL] : recipients;

  try {
    await resend.emails.send({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to, subject, html });
    console.log(`[report] ✓ Enviado a ${to.join(', ')}`);

    // Guardar historial
    const alertCount = clientsWithMetrics
      .filter(c => c.metrics)
      .reduce((s, { client, metrics }) => s + evaluateClient(client, metrics).length, 0);

    await saveHistory({
      sent_at:       now.toISOString(),
      type:          scheduleType,
      clients_count: clientsWithMetrics.filter(c => c.metrics).length,
      alerts_count:  alertCount,
      recipients:    to.length,
    });

    return { ok: true, sent: to.length, clients: clientsWithMetrics.filter(c => c.metrics).length };
  } catch(e) {
    console.error('[report] Error enviando:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── CRON ──────────────────────────────────────────────────────
const activeJobs = {};

function registerJob(type, expr) {
  if (activeJobs[type]) { activeJobs[type].stop(); delete activeJobs[type]; }
  if (!expr || !cron.validate(expr)) return false;
  activeJobs[type] = cron.schedule(expr, () => sendConsolidatedReport(type), { timezone: TZ });
  console.log(`[cron] ✓ ${type}: "${expr}"`);
  return true;
}

async function initCron() {
  const settings = await loadSettings();
  const sched = settings.schedule || {};

  if (sched.daily?.enabled) {
    const h = sched.daily.hour ?? 9, m = sched.daily.minute ?? 0;
    registerJob('daily', `${m} ${h} * * *`);
  }
  if (sched.weekly?.enabled) {
    const h = sched.weekly.hour ?? 9, m = sched.weekly.minute ?? 0, dow = sched.weekly.dow ?? 1;
    registerJob('weekly', `${m} ${h} * * ${dow}`);
  }
  if (sched.monthly?.enabled) {
    const h = sched.monthly.hour ?? 9, m = sched.monthly.minute ?? 0, day = sched.monthly.day ?? 1;
    registerJob('monthly', `${m} ${h} ${day} * *`);
  }
  console.log('[cron] Inicializado');
}

// ── MIDDLEWARE AUTH ───────────────────────────────────────────
function auth(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ── API ENDPOINTS ─────────────────────────────────────────────

// Auth
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
});

// Clientes
app.get('/api/clients', auth, async (req, res) => {
  try {
    const clients = await loadClients();
    res.json(clients);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', auth, async (req, res) => {
  try {
    const { name, ad_account_id, monthly_budget, currency, active, notes } = req.body;
    if (!name || !ad_account_id) return res.status(400).json({ error: 'name y ad_account_id son requeridos' });
    const saved = await saveClient({
      name: name.trim(),
      ad_account_id: ad_account_id.trim(),
      monthly_budget: parseFloat(monthly_budget) || 0,
      currency: currency || 'ARS',
      active: active !== false,
      notes: notes || '',
      created_at: new Date().toISOString(),
    });
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clients/:id', auth, async (req, res) => {
  try {
    const { name, ad_account_id, monthly_budget, currency, active, notes } = req.body;
    const saved = await saveClient({
      id: req.params.id,
      name: name?.trim(),
      ad_account_id: ad_account_id?.trim(),
      monthly_budget: parseFloat(monthly_budget) || 0,
      currency: currency || 'ARS',
      active: active !== false,
      notes: notes || '',
    });
    res.json(saved);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  try {
    await deleteClient(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Métricas de un cliente
app.get('/api/clients/:id/metrics', auth, async (req, res) => {
  try {
    const client = await loadClient(req.params.id);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    const metrics = await fetchClientMetrics(client.ad_account_id);
    res.json(metrics);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dashboard — métricas de todos
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const clients = await loadClients();
    const active = clients.filter(c => c.active);
    const results = await Promise.all(
      active.map(async (client) => {
        try {
          const metrics = await fetchClientMetrics(client.ad_account_id);
          const alerts = evaluateClient(client, metrics);
          return { client, metrics, alerts };
        } catch(e) {
          return { client, metrics: null, alerts: [], error: e.message };
        }
      })
    );
    res.json(results);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Settings
app.get('/api/settings', auth, async (req, res) => {
  try { res.json(await loadSettings()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', auth, async (req, res) => {
  try {
    const ok = await saveSettings(req.body);
    if (ok) {
      await initCron(); // Reinicializar cron con nueva config
      res.json({ ok: true });
    } else {
      res.status(500).json({ error: 'Error guardando settings' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Test envío
app.post('/api/send-test', auth, async (req, res) => {
  try {
    const result = await sendConsolidatedReport(req.body.type || 'daily', true);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Historial
app.get('/api/history', auth, async (req, res) => {
  try { res.json(await loadHistory()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Health
app.get('/health', (_, res) => res.json({ ok: true, version: '1.0.0' }));

// Frontend
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[server] Meta Budget Monitor en puerto ${PORT}`);
  await initCron();
});
