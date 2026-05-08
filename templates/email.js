'use strict';

function fmtMoney(val, currency = 'ARS') {
  if (!val && val !== 0) return '—';
  const sym = currency === 'USD' ? 'U$S ' : '$ ';
  return sym + Math.round(val).toLocaleString('es-AR');
}
function fmtNum(val, dec = 1) { return (val != null ? val.toFixed(dec) : '—'); }

function generateConsolidatedEmail({ clients, reportDate, scheduleType }) {
  const typeLabel = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual' }[scheduleType] || 'Diario';

  const totalSpend   = clients.reduce((s, { metrics }) => s + (metrics?.month?.spend || 0), 0);
  const totalAlerts  = clients.reduce((s, { alerts }) => s + (alerts?.length || 0), 0);
  const criticals    = clients.filter(({ alerts }) => alerts?.some(a => a.type === 'critical'));

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

    const barColor  = pct >= 100 ? '#f26d6d' : pct >= 80 ? '#f5a623' : '#5de8a0';
    const devColor  = Math.abs(dev) <= 5 ? '#5de8a0' : Math.abs(dev) <= 15 ? '#f5a623' : '#f26d6d';
    const scoreColor = health?.color === 'success' ? '#5de8a0' : health?.color === 'amber' ? '#f5a623' : '#f26d6d';

    const alertsHtml = alerts?.length > 0 ? alerts.map(a =>
      `<div style="background:${a.type === 'critical' ? 'rgba(242,109,109,.12)' : 'rgba(245,166,35,.1)'};border:1px solid ${a.type === 'critical' ? 'rgba(242,109,109,.3)' : 'rgba(245,166,35,.25)'};color:${a.type === 'critical' ? '#f26d6d' : '#f5a623'};border-radius:5px;padding:5px 10px;font-size:12px;margin-bottom:4px">${a.msg}</div>`
    ).join('') : '';

    const extraMetrics = type === 'ecommerce' ? `
      <td style="padding:12px 14px;border-bottom:1px solid #1a1a28">
        <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">ROAS</div>
        <div style="font-size:15px;font-weight:700;color:#edeef8">${fmtNum(lw.roas)}</div>
        ${client.target_roas ? `<div style="font-size:11px;color:#6b6b88">obj: ${fmtNum(client.target_roas)}</div>` : ''}
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid #1a1a28">
        <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Ingresos</div>
        <div style="font-size:15px;font-weight:700;color:#edeef8">${fmtMoney(m.revenue, client.currency)}</div>
        <div style="font-size:11px;color:#6b6b88">${m.purchases || 0} compras</div>
      </td>` :
      type === 'leads' ? `
      <td style="padding:12px 14px;border-bottom:1px solid #1a1a28">
        <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Leads</div>
        <div style="font-size:15px;font-weight:700;color:#edeef8">${m.leads || 0}</div>
        ${client.target_leads ? `<div style="font-size:11px;color:#6b6b88">obj: ${client.target_leads}</div>` : ''}
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid #1a1a28">
        <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">CPL</div>
        <div style="font-size:15px;font-weight:700;color:#edeef8">${fmtMoney(m.cpl, client.currency)}</div>
        ${client.target_cpl ? `<div style="font-size:11px;color:#6b6b88">obj: ${fmtMoney(client.target_cpl, client.currency)}</div>` : ''}
      </td>` : `<td></td><td></td>`;

    return `
    <tr>
      <td colspan="6" style="padding:0">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:2px solid #1a1a28">
          <tr>
            <!-- Nombre + Health -->
            <td style="padding:14px 16px;border-bottom:1px solid #1a1a28;vertical-align:top;width:200px">
              <div style="font-size:14px;font-weight:700;color:#edeef8;margin-bottom:3px">${client.name}</div>
              <div style="font-size:10px;color:#6b6b88;font-family:monospace">${client.ad_account_id}</div>
              ${health ? `
              <div style="margin-top:8px;display:inline-block;background:rgba(93,232,160,.05);border:1px solid rgba(93,232,160,.15);border-radius:6px;padding:4px 10px">
                <span style="font-size:16px;font-weight:800;color:${scoreColor};font-family:monospace">${health.score}</span>
                <span style="font-size:10px;color:${scoreColor};margin-left:3px">${health.label}</span>
              </div>` : ''}
            </td>
            <!-- Gasto mes -->
            <td style="padding:12px 14px;border-bottom:1px solid #1a1a28;vertical-align:top">
              <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Consumo Mes</div>
              <div style="font-size:18px;font-weight:800;color:#c8f135">${fmtMoney(m.spend, client.currency)}</div>
              ${budget > 0 ? `
              <div style="height:4px;background:#1a1a28;border-radius:2px;margin:5px 0 3px">
                <div style="height:100%;border-radius:2px;width:${Math.min(pct,100)}%;background:${barColor}"></div>
              </div>
              <div style="font-size:11px;color:${devColor}">${pct}% real · ${idealPct}% ideal · ${dev > 0 ? '+' : ''}${dev}pp desvío</div>` : ''}
            </td>
            <!-- Gasto ayer -->
            <td style="padding:12px 14px;border-bottom:1px solid #1a1a28;vertical-align:top">
              <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">Gasto Ayer</div>
              <div style="font-size:15px;font-weight:700;color:${yd.spend === 0 ? '#f26d6d' : '#edeef8'}">${fmtMoney(yd.spend, client.currency)}</div>
              ${yd.spend === 0 ? '<div style="font-size:11px;color:#f26d6d">⚠ Sin actividad</div>' : ''}
            </td>
            <!-- CTR / CPM -->
            <td style="padding:12px 14px;border-bottom:1px solid #1a1a28;vertical-align:top">
              <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">CTR / CPM</div>
              <div style="font-size:13px;font-weight:700;color:#edeef8">${fmtNum(m.ctr)}% · ${fmtMoney(m.cpm, client.currency)}</div>
              <div style="font-size:11px;color:#6b6b88">Freq: ${fmtNum(m.frequency)}</div>
            </td>
            ${extraMetrics}
          </tr>
          ${alertsHtml ? `<tr><td colspan="6" style="padding:8px 16px 10px">${alertsHtml}</td></tr>` : ''}
        </table>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Reporte ${typeLabel} · Docta Nexus</title></head>
<body style="margin:0;padding:0;background:#080810;font-family:'DM Sans',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#080810;padding:32px 16px">
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;margin:0 auto">

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

      <!-- RESUMEN GLOBAL -->
      <tr><td style="padding-bottom:16px">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0e0e18;border:1px solid #252538;border-radius:10px">
          <tr>
            <td style="padding:16px;text-align:center;border-right:1px solid #252538">
              <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px">Total gastado (mes)</div>
              <div style="font-size:22px;font-weight:800;color:#c8f135">$ ${Math.round(totalSpend).toLocaleString('es-AR')}</div>
            </td>
            <td style="padding:16px;text-align:center;border-right:1px solid #252538">
              <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px">Clientes activos</div>
              <div style="font-size:22px;font-weight:800;color:#edeef8">${clients.length}</div>
            </td>
            <td style="padding:16px;text-align:center">
              <div style="font-size:10px;color:#6b6b88;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px">Alertas</div>
              <div style="font-size:22px;font-weight:800;color:${totalAlerts > 0 ? '#f5a623' : '#5de8a0'}">${totalAlerts}</div>
            </td>
          </tr>
        </table>
      </td></tr>

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
