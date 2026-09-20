const el = (id) => document.getElementById(id);

const STATUS_FLOW = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['ready', 'cancelled'],
  ready: ['completed'],
  completed: [],
  cancelled: [],
};

const STATUS_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  ready: 'Ready for pickup',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function money(n) {
  return '$' + Number(n).toFixed(2);
}

function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
}

function formatDate(d) {
  const date = new Date(d + 'T00:00:00');
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadOrders() {
  const date = el('filterDate').value;
  const status = el('filterStatus').value;
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (status) params.set('status', status);

  const orders = await api('/api/orders' + (params.toString() ? '?' + params.toString() : ''));
  const visible = status ? orders : orders.filter((o) => o.status !== 'cancelled');
  renderStats(orders);
  renderOrders(visible);
}

function renderStats(orders) {
  const pending = orders.filter((o) => o.status === 'pending').length;
  const confirmed = orders.filter((o) => o.status === 'confirmed').length;
  const ready = orders.filter((o) => o.status === 'ready').length;
  const revenue = orders
    .filter((o) => o.status !== 'cancelled')
    .reduce((sum, o) => sum + o.total, 0);

  el('statsRow').innerHTML = `
    <div class="stat"><div class="n">${pending}</div><div class="l">Pending</div></div>
    <div class="stat"><div class="n">${confirmed}</div><div class="l">Confirmed</div></div>
    <div class="stat"><div class="n">${ready}</div><div class="l">Ready</div></div>
    <div class="stat"><div class="n">${money(revenue)}</div><div class="l">Total value</div></div>
  `;
}

function renderOrders(orders) {
  const list = el('ordersList');
  if (orders.length === 0) {
    list.innerHTML = '<div class="empty-state">No orders match these filters.</div>';
    return;
  }

  list.innerHTML = '';
  orders.forEach((order) => {
    const card = document.createElement('div');
    card.className = `order-card status-${order.status}`;

    const itemsHtml = order.items
      .map((it) => {
        const modLabels = (it.modifiers || []).flatMap((g) => g.selected.map((o) => o.label));
        const modText = modLabels.length ? ` <span class="item-mods">(${modLabels.join(', ')})</span>` : '';
        return `<div>${it.qty} × ${it.name}${modText} — ${money(it.price)}</div>`;
      })
      .join('');

    const nextActions = STATUS_FLOW[order.status] || [];
    const actionsHtml = nextActions
      .map((next) => {
        const label = next === 'cancelled' ? 'Cancel' : `Mark ${STATUS_LABELS[next]}`;
        const cls = next === 'cancelled' ? 'danger' : '';
        return `<button class="${cls}" data-id="${order.id}" data-status="${next}">${label}</button>`;
      })
      .join('');

    const paid = order.paymentStatus === 'paid';
    card.innerHTML = `
      <div class="order-top">
        <div>
          <div class="order-time">${formatTime(order.pickupTime)}</div>
          <div class="order-date">${formatDate(order.pickupDate)}</div>
        </div>
        <div style="display:flex; gap:6px; align-items:flex-start;">
          <span class="badge ${paid ? 'status-ready' : 'status-cancelled'}">${paid ? 'Paid' : 'Unpaid'}</span>
          <span class="badge status-${order.status}">${STATUS_LABELS[order.status]}</span>
        </div>
      </div>
      <div class="order-customer">${order.customerName} · ${order.phone}</div>
      <div class="order-items">${itemsHtml}</div>
      ${order.notes ? `<div class="order-notes">"${order.notes}"</div>` : ''}
      <div class="summary-row" style="font-weight:600"><span>Total</span><span>${money(order.total)}</span></div>
      <div class="order-actions">${actionsHtml}</div>
    `;

    card.querySelectorAll('button[data-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api(`/api/orders/${btn.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: btn.dataset.status }),
          });
          await loadOrders();
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
    });

    list.appendChild(card);
  });
}

function applyTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  updateThemeToggleIcon();
}

function updateThemeToggleIcon() {
  const current = document.documentElement.getAttribute('data-theme');
  const isDark = current === 'dark' || (!current && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const btn = el('themeToggle');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const isDark = current === 'dark' || (!current && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeToggleIcon();
}

async function init() {
  try {
    applyTheme();
    el('themeToggle').addEventListener('click', toggleTheme);
  } catch (e) {
    // localStorage may be unavailable; theme toggle is a non-essential convenience
  }

  const settings = await api('/api/settings');
  el('bizName').textContent = settings.businessName + ' — Dashboard';

  el('filterDate').addEventListener('change', loadOrders);
  el('filterStatus').addEventListener('change', loadOrders);
  el('clearDateBtn').addEventListener('click', (e) => {
    e.preventDefault();
    el('filterDate').value = '';
    loadOrders();
  });

  await loadOrders();
  setInterval(loadOrders, 15000); // auto-refresh so new orders show up
}

init().catch((err) => alert(err.message));
