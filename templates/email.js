'use strict';

function fmtMoney(val, currency = 'ARS') {
  if (!val && val !== 0) return '—';
  const sym = currency === 'USD' ? 'U$S ' : '$ ';
  return sym + Math.round(val).toLocaleString('es-AR');
}
function fmtNum(val, dec = 1) { return (val != null ? val.toFixed(dec) : '—'); }

// Celda de métrica reutilizable
function metCell(label, value, sub) {
  return `
  <td style="padding:10px 14px;vertical-align:top;border-right:1px solid #1a1a28">
    <div style="font-size:9px;color:#6b6b88;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">${label}</div>
    <div style="font-size:14px;font-weight:700;color:#edeef8">${value}</div>
    ${sub ? `<div style="font-size:11px;color:#6b6b88;margin-top:2px">${sub}</div>` : ''}
  </td>`;
}

function generateConsolidatedEmail({ clients, reportDate, scheduleType }) {
  const typeLabel  = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual' }[scheduleType] || 'Diario';
  const totalAlerts = clients.reduce((s, { alerts }) => s + (alerts?.length || 0), 0);
  const criticals   = clients.filter(({ alerts }) => alerts?.some(a => a.type === 'critical'));

  const clientRows = clients.map(({ client, metrics, alerts, health }) => {
    const m    = metrics?.month     || {};
    const yd   = metrics?.yesterday || {};
    const lw   = metrics?.lastWeek  || {};
    const type = client.client_type || 'general';

    const budget   = client.monthly_budget || 0;
    const pct      = budget > 0 ? Math.round((m.spend / budget) * 100) : 0;
    const daysInM  = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const dayOfM   = new Date().getDate();
    const idealPct = Math.round((dayOfM / daysInM) * 100);
    const dev      = pct - idealPct;

    const barColor   = pct >= 100 ? '#f26d6d' : pct >= 80 ? '#f5a623' : '#5de8a0';
    const devColor   = Math.abs(dev) <= 5 ? '#5de8a0' : Math.abs(dev) <= 15 ? '#f5a623' : '#f26d6d';
    const scoreColor = health?.color === 'success' ? '#5de8a0' : health?.color === 'amber' ? '#f5a623' : '#f26d6d';

    // Texto de desvío claro
    const devText = dev === 0
      ? 'En ritmo ideal'
      : `${dev > 0 ? '+' : ''}${dev} puntos porcentuales ${dev > 0 ? 'por encima' : 'por debajo'} del ritmo ideal`;

    const alertsHtml = alerts?.length > 0 ? alerts.map(a =>
      `<div style="background:${a.type === 'critical' ? 'rgba(242,109,109,.12)' : 'rgba(245,166,35,.1)'};border:1px solid ${a.type === 'critical' ? 'rgba(242,109,109,.3)' : 'rgba(245,166,35,.25)'};color:${a.type === 'critical' ? '#f26d6d' : '#f5a623'};border-radius:5px;padding:5px 10px;font-size:12px;margin-bottom:4px">${a.msg}</div>`
    ).join('') : '';

    // Métricas de performance según tipo — todas del mes
    const perfMetrics = type === 'ecommerce' ? `
      ${metCell('ROAS (mes)', fmtNum(m.roas), client.target_roas ? `obj: ${fmtNum(client.target_roas)}` : '')}
      ${metCell('Ingresos (mes)', fmtMoney(m.revenue, client.currency), `${m.purchases || 0} compras`)}
    ` : type === 'leads' ? `
      ${metCell('Leads (mes)', m.leads || '0', client.target_leads ? `obj: ${client.target_leads}` : '')}
      ${metCell('CPL (mes)', fmtMoney(m.cpl, client.currency), client.target_cpl ? `obj: ${fmtMoney(client.target_cpl, client.currency)}` : '')}
    ` : '';

    return `
    <tr><td style="padding:0;border-bottom:2px solid #141420">

      <!-- CABECERA CLIENTE -->
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding:14px 16px;vertical-align:middle">
            <div style="font-size:15px;font-weight:700;color:#edeef8">${client.name}</div>
          </td>
          ${health ? `
          <td style="padding:12px 16px;text-align:right;vertical-align:middle">
            <div style="display:inline-block;background:rgba(0,0,0,.3);border:1px solid ${scoreColor}44;border-radius:8px;padding:5px 12px">
              <span style="font-size:18px;font-weight:800;color:${scoreColor};font-family:monospace">${health.score}</span>
              <span style="font-size:10px;color:${scoreColor};margin-left:4px;text-transform:uppercase;letter-spacing:.05em">${health.label}</span>
            </div>
          </td>` : ''}
        </tr>
      </table>

      <!-- BLOQUE: ESTE MES -->
      <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #1a1a28;border-bottom:1px solid #1a1a28;background:#0a0a14">
        <tr>
          <td colspan="10" style="padding:6px 14px 4px">
            <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#44445a">📅 Este mes</span>
          </td>
        </tr>
        <tr>
          <!-- Consumo + pacing -->
          <td style="padding:10px 14px;vertical-align:top;border-right:1px solid #1a1a28;min-width:160px">
            <div style="font-size:9px;color:#6b6b88;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Consumo mes</div>
            <div style="font-size:18px;font-weight:800;color:#c8f135">${fmtMoney(m.spend, client.currency)}</div>
            ${budget > 0 ? `
            <div style="height:4px;background:#1a1a28;border-radius:2px;margin:6px 0 4px">
              <div style="height:100%;border-radius:2px;width:${Math.min(pct,100)}%;background:${barColor}"></div>
            </div>
            <div style="font-size:10px;color:${devColor};line-height:1.5">
              ${pct}% real · ${idealPct}% ideal<br>
              <strong>${devText}</strong>
            </div>` : ''}
          </td>
          ${metCell('CTR (mes)', fmtNum(m.ctr) + '%', '')}
          ${metCell('CPM (mes)', fmtMoney(m.cpm, client.currency), `Freq: ${fmtNum(m.frequency)}`)}
          ${perfMetrics}
        </tr>
      </table>

      <!-- BLOQUE: AYER -->
      <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #1a1a28">
        <tr>
          <td colspan="10" style="padding:6px 14px 4px">
            <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#44445a">🕐 Ayer</span>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 14px;vertical-align:top;border-right:1px solid #1a1a28">
            <div style="font-size:9px;color:#6b6b88;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Gasto ayer</div>
            <div style="font-size:16px;font-weight:700;color:${yd.spend === 0 ? '#f26d6d' : '#edeef8'}">${fmtMoney(yd.spend, client.currency)}</div>
            ${yd.spend === 0 ? '<div style="font-size:11px;color:#f26d6d;margin-top:2px">⚠ Sin actividad</div>' : ''}
          </td>
          ${metCell('CTR ayer', fmtNum(yd.ctr) + '%', '')}
          ${metCell('CPM ayer', fmtMoney(yd.cpm, client.currency), '')}
        </tr>
      </table>

      ${alertsHtml ? `
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:8px 14px 10px">${alertsHtml}</td></tr>
      </table>` : ''}

    </td></tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Reporte ${typeLabel} · Docta Nexus</title></head>
<body style="margin:0;padding:0;background:#080810;font-family:'DM Sans',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#080810;padding:32px 16px">
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto">

      <!-- HEADER -->
      <tr><td style="padding-bottom:24px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <div style="font-size:20px;font-weight:800;color:#edeef8;letter-spacing:-.02em">Meta<span style="color:#c8f135">Budget</span></div>
              <div style="font-size:11px;color:#6b6b88;margin-top:2px;text-transform:uppercase;letter-spacing:.08em">Reporte ${typeLabel} · Docta Nexus</div>
            </td>
            <td style="text-align:right;vertical-align:top">
              <div style="font-size:12px;color:#6b6b88">${reportDate}</div>
              <div style="font-size:11px;color:#44445a;margin-top:2px">${clients.length} clientes · ${totalAlerts} alertas</div>
            </td>
          </tr>
        </table>
      </td></tr>

      ${criticals.length > 0 ? `
      <!-- ALERTAS CRÍTICAS -->
      <tr><td style="padding-bottom:16px">
        <div style="background:rgba(242,109,109,.1);border:1px solid rgba(242,109,109,.25);border-radius:10px;padding:14px 16px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#f26d6d;margin-bottom:8px">⚠ ${criticals.length} cliente${criticals.length > 1 ? 's' : ''} con alertas críticas</div>
          ${criticals.map(({ client, alerts }) => `
            <div style="font-size:12px;color:#f26d6d;margin-bottom:3px">
              <strong>${client.name}:</strong> ${alerts.filter(a => a.type === 'critical').map(a => a.msg).join(' · ')}
            </div>`).join('')}
        </div>
      </td></tr>` : ''}

      <!-- CLIENTES -->
      <tr><td>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0e0e18;border:1px solid #252538;border-radius:10px;overflow:hidden">
          ${clientRows}
        </table>
      </td></tr>

      <!-- FOOTER -->
      <tr><td style="padding-top:20px;text-align:center">
        <div style="font-size:11px;color:#44445a">Reporte generado automáticamente por <a href="https://doctanexus.com" style="color:#6b6b88;text-decoration:none">Docta Nexus</a></div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

module.exports = { generateConsolidatedEmail };
