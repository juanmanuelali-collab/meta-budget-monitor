'use strict';

function fmtMoney(val, currency = 'ARS') {
  const sym = currency === 'USD' ? 'U$S' : '$';
  if (val >= 1000000) return `${sym}${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000) return `${sym}${(val / 1000).toFixed(1)}K`;
  return `${sym}${Math.round(val).toLocaleString('es-AR')}`;
}

function pctBar(pct) {
  const capped = Math.min(pct, 100);
  const color = pct >= 100 ? '#f26d6d' : pct >= 80 ? '#f5a623' : '#5de8a0';
  return `
    <div style="background:#2a2a32;border-radius:4px;height:8px;width:100%;margin:6px 0 2px">
      <div style="background:${color};height:8px;border-radius:4px;width:${capped}%"></div>
    </div>
    <div style="font-size:11px;color:${color};font-weight:700">${Math.round(pct)}% del presupuesto</div>
  `;
}

function statusBadge(client, pct, spendYesterday) {
  if (spendYesterday === 0) return { label: 'SIN GASTO AYER', color: '#f26d6d', bg: 'rgba(242,109,109,.12)' };
  if (pct >= 100) return { label: 'PRESUPUESTO AGOTADO', color: '#f26d6d', bg: 'rgba(242,109,109,.12)' };
  if (pct >= 80) return { label: 'ALERTA PRESUPUESTO', color: '#f5a623', bg: 'rgba(245,166,35,.12)' };
  return { label: 'NORMAL', color: '#5de8a0', bg: 'rgba(93,232,160,.12)' };
}

function generateConsolidatedEmail({ clients, reportDate, scheduleType }) {
  const typeLabel = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual' }[scheduleType] || 'Diario';

  const rows = clients.map(({ client, metrics }) => {
    const spendMonth = metrics?.month?.spend || 0;
    const spendYesterday = metrics?.yesterday?.spend || 0;
    const budget = client.monthly_budget || 0;
    const pct = budget > 0 ? (spendMonth / budget) * 100 : 0;
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const dayOfMonth = new Date().getDate();
    const projectedSpend = dayOfMonth > 1 ? (spendMonth / (dayOfMonth - 1)) * daysInMonth : 0;
    const status = statusBadge(client, pct, spendYesterday);
    const alerts = [];
    if (spendYesterday === 0) alerts.push('Sin gasto ayer');
    if (pct >= 100) alerts.push('Presupuesto agotado');
    else if (pct >= 80) alerts.push(`${Math.round(pct)}% consumido`);
    if (budget > 0 && projectedSpend < budget * 0.85 && dayOfMonth > 5) alerts.push('Ritmo bajo');
    if (budget > 0 && projectedSpend > budget * 1.1) alerts.push('Ritmo alto');

    return `
    <tr style="border-bottom:1px solid #2a2a32">
      <td style="padding:14px 12px;vertical-align:top">
        <div style="font-weight:700;font-size:14px;color:#edeef0;margin-bottom:2px">${client.name}</div>
        <div style="font-size:11px;color:#7a7a8a">${client.ad_account_id}</div>
      </td>
      <td style="padding:14px 12px;text-align:right;vertical-align:top">
        <div style="font-size:15px;font-weight:800;color:#edeef0">${fmtMoney(spendMonth, client.currency)}</div>
        <div style="font-size:11px;color:#7a7a8a">de ${budget > 0 ? fmtMoney(budget, client.currency) : '—'}</div>
        ${budget > 0 ? pctBar(pct) : ''}
      </td>
      <td style="padding:14px 12px;text-align:right;vertical-align:top">
        <div style="font-size:15px;font-weight:800;color:${spendYesterday === 0 ? '#f26d6d' : '#edeef0'}">${fmtMoney(spendYesterday, client.currency)}</div>
        <div style="font-size:11px;color:#7a7a8a">ayer</div>
      </td>
      <td style="padding:14px 12px;text-align:right;vertical-align:top">
        <div style="font-size:13px;font-weight:700;color:#c8f135">${budget > 0 ? fmtMoney(projectedSpend, client.currency) : '—'}</div>
        <div style="font-size:11px;color:#7a7a8a">proyección mes</div>
      </td>
      <td style="padding:14px 12px;text-align:center;vertical-align:top">
        <span style="display:inline-block;background:${status.bg};color:${status.color};font-size:10px;font-weight:800;padding:3px 10px;border-radius:20px;letter-spacing:.06em">${status.label}</span>
        ${alerts.length > 0 ? `<div style="margin-top:6px">${alerts.map(a => `<div style="font-size:10px;color:#7a7a8a;margin-top:2px">⚠ ${a}</div>`).join('')}</div>` : ''}
      </td>
    </tr>`;
  }).join('');

  const totalSpendMonth = clients.reduce((s, { metrics }) => s + (metrics?.month?.spend || 0), 0);
  const totalSpendYesterday = clients.reduce((s, { metrics }) => s + (metrics?.yesterday?.spend || 0), 0);
  const totalBudget = clients.reduce((s, { client }) => s + (client.monthly_budget || 0), 0);
  const alertClients = clients.filter(({ client, metrics }) => {
    const spend = metrics?.month?.spend || 0;
    const pct = client.monthly_budget > 0 ? (spend / client.monthly_budget) * 100 : 0;
    return (metrics?.yesterday?.spend || 0) === 0 || pct >= 80;
  });

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Reporte ${typeLabel} de Presupuestos Meta Ads</title></head>
<body style="margin:0;padding:0;background:#0b0b0d;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d;padding:32px 16px">
<tr><td align="center">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">

  <!-- HEADER -->
  <tr><td style="background:#111114;border:1px solid #2a2a32;border-radius:14px 14px 0 0;padding:24px 28px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#7a7a8a;margin-bottom:6px">DOCTA NEXUS · META BUDGET MONITOR</div>
          <div style="font-size:22px;font-weight:800;color:#edeef0">Reporte ${typeLabel} <span style="color:#c8f135">de Presupuestos</span></div>
          <div style="font-size:13px;color:#7a7a8a;margin-top:4px">${reportDate} · ${clients.length} clientes activos</div>
        </td>
        <td align="right" valign="top">
          <div style="background:#c8f135;color:#0a0a0c;font-size:11px;font-weight:800;padding:6px 14px;border-radius:20px;display:inline-block">Meta Ads</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- SUMMARY KPIs -->
  <tr><td style="background:#18181c;border-left:1px solid #2a2a32;border-right:1px solid #2a2a32;padding:20px 28px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="25%" style="text-align:center;padding:12px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#7a7a8a;margin-bottom:6px">Consumo del Mes</div>
          <div style="font-size:24px;font-weight:800;color:#c8f135">$${Math.round(totalSpendMonth).toLocaleString('es-AR')}</div>
        </td>
        <td width="25%" style="text-align:center;padding:12px;border-left:1px solid #2a2a32">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#7a7a8a;margin-bottom:6px">Gasto Ayer</div>
          <div style="font-size:24px;font-weight:800;color:#edeef0">$${Math.round(totalSpendYesterday).toLocaleString('es-AR')}</div>
        </td>
        <td width="25%" style="text-align:center;padding:12px;border-left:1px solid #2a2a32">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#7a7a8a;margin-bottom:6px">Presupuesto Total</div>
          <div style="font-size:24px;font-weight:800;color:#edeef0">${totalBudget > 0 ? '$' + Math.round(totalBudget).toLocaleString('es-AR') : '—'}</div>
        </td>
        <td width="25%" style="text-align:center;padding:12px;border-left:1px solid #2a2a32">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#7a7a8a;margin-bottom:6px">Con Alertas</div>
          <div style="font-size:24px;font-weight:800;color:${alertClients.length > 0 ? '#f5a623' : '#5de8a0'}">${alertClients.length}</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- TABLE -->
  <tr><td style="background:#111114;border:1px solid #2a2a32;border-top:none;border-radius:0 0 14px 14px;padding:0 0 20px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr style="border-bottom:1px solid #2a2a32">
        <th style="padding:12px 12px;text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#7a7a8a">Cliente</th>
        <th style="padding:12px 12px;text-align:right;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#7a7a8a">Mes Actual</th>
        <th style="padding:12px 12px;text-align:right;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#7a7a8a">Ayer</th>
        <th style="padding:12px 12px;text-align:right;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#7a7a8a">Proyección</th>
        <th style="padding:12px 12px;text-align:center;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#7a7a8a">Estado</th>
      </tr>
      ${rows}
    </table>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="padding:24px 0 0;text-align:center">
    <div style="font-size:12px;color:#50505a">Enviado por <strong style="color:#c8f135">Docta Nexus</strong> · Meta Budget Monitor</div>
    <div style="font-size:11px;color:#36363f;margin-top:4px"><a href="https://doctanexus.com" style="color:#50505a;text-decoration:none">doctanexus.com</a></div>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

module.exports = { generateConsolidatedEmail };
