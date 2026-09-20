const state = {
  menu: [],
  settings: null,
  cart: [], // { lineId, itemId, name, qty, unitPrice, price, selections, modifierSummary }
  draftSelections: {}, // itemId -> { groupId: optionId | [optionId,...] }
  draftQty: {}, // itemId -> number
  selectedDate: null,
  selectedTime: null,
};

const el = (id) => document.getElementById(id);

function todayStr() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function dayLabel(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function money(n) {
  return '$' + Number(n).toFixed(2);
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

function showError(msg) {
  const banner = el('errorBanner');
  banner.textContent = msg;
  banner.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearError() {
  el('errorBanner').style.display = 'none';
}

function initDraft(item) {
  const selections = {};
  (item.modifierGroups || []).forEach((group) => {
    if (group.type === 'single') {
      const def = group.options[0];
      selections[group.id] = def ? def.id : null;
    } else {
      selections[group.id] = [];
    }
  });
  state.draftSelections[item.id] = selections;
  state.draftQty[item.id] = 1;
}

function priceForDraft(item) {
  const selections = state.draftSelections[item.id] || {};
  let unitPrice = item.price;
  (item.modifierGroups || []).forEach((group) => {
    const val = selections[group.id];
    const ids = group.type === 'single' ? (val ? [val] : []) : val || [];
    const chosen = ids.map((id) => group.options.find((o) => o.id === id)).filter(Boolean);

    // Fixed-price options (e.g. Maple cold foam) always cost their listed price.
    // Pool options (priceDelta: null) share the group's free allowance, then cost extraCharge each.
    const fixedSum = chosen.filter((o) => o.priceDelta !== null).reduce((sum, o) => sum + o.priceDelta, 0);
    const poolCount = chosen.filter((o) => o.priceDelta === null).length;
    const billablePoolCount = Math.max(0, poolCount - (group.freeAllowance || 0));
    unitPrice += fixedSum + billablePoolCount * (group.extraCharge || 0);
  });
  return unitPrice;
}

function renderMenu() {
  const grid = el('menuGrid');
  grid.innerHTML = '';

  let lastCategory = null;
  state.menu.forEach((item) => {
    if (item.category !== lastCategory) {
      const cat = document.createElement('div');
      cat.className = 'menu-category';
      cat.textContent = item.category;
      grid.appendChild(cat);
      lastCategory = item.category;
    }
    grid.appendChild(renderMenuItemCard(item));
  });
}

function renderMenuItemCard(item) {
  if (!(item.id in state.draftSelections)) initDraft(item);
  const selections = state.draftSelections[item.id];
  const qty = state.draftQty[item.id];

  const card = document.createElement('div');
  card.className = 'menu-item';

  const header = document.createElement('div');
  header.className = 'menu-item-header';
  header.innerHTML = `
    <div class="info">
      <div class="name">${item.name}</div>
      <div class="price">${item.price > 0 ? money(item.price) + ' base' : 'Price TBD'}</div>
    </div>
  `;
  card.appendChild(header);

  (item.modifierGroups || []).forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'modifier-group';
    const groupLabel = document.createElement('div');
    groupLabel.className = 'modifier-label';
    let labelText = group.label + (group.required ? '' : ' (optional)');
    if (group.freeAllowance) {
      labelText += ` — first ${group.freeAllowance} free, +${money(group.extraCharge || 0)} each after`;
    }
    groupLabel.textContent = labelText;
    groupEl.appendChild(groupLabel);

    const options = document.createElement('div');
    options.className = 'modifier-options';

    group.options.forEach((opt) => {
      const isMulti = group.type === 'multi';
      const isSelected = isMulti
        ? (selections[group.id] || []).includes(opt.id)
        : selections[group.id] === opt.id;

      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'modifier-pill' + (isSelected ? ' selected' : '');
      pill.textContent = opt.priceDelta > 0 ? `${opt.label} (+${money(opt.priceDelta)})` : opt.label;
      pill.addEventListener('click', () => {
        if (isMulti) {
          const cur = new Set(selections[group.id] || []);
          if (cur.has(opt.id)) cur.delete(opt.id);
          else cur.add(opt.id);
          selections[group.id] = Array.from(cur);
        } else {
          selections[group.id] = opt.id;
        }
        renderMenu();
      });
      options.appendChild(pill);
    });

    groupEl.appendChild(options);
    card.appendChild(groupEl);
  });

  const footer = document.createElement('div');
  footer.className = 'menu-item-footer';
  footer.innerHTML = `
    <div class="qty-control">
      <button type="button" data-action="dec">−</button>
      <span>${qty}</span>
      <button type="button" data-action="inc">+</button>
    </div>
    <button type="button" class="add-btn">Add · ${money(priceForDraft(item) * qty)}</button>
  `;
  footer.querySelector('[data-action="dec"]').addEventListener('click', () => {
    state.draftQty[item.id] = Math.max(1, qty - 1);
    renderMenu();
  });
  footer.querySelector('[data-action="inc"]').addEventListener('click', () => {
    state.draftQty[item.id] = qty + 1;
    renderMenu();
  });
  footer.querySelector('.add-btn').addEventListener('click', () => addToCart(item));
  card.appendChild(footer);

  return card;
}

function describeSelections(item, selections) {
  const parts = [];
  (item.modifierGroups || []).forEach((group) => {
    const val = selections[group.id];
    if (group.type === 'single') {
      // Only call out a single-choice pick if it differs from the default (first) option
      if (val && val !== group.options[0].id) {
        const opt = group.options.find((o) => o.id === val);
        if (opt) parts.push(opt.label);
      }
    } else {
      (val || []).forEach((id) => {
        const opt = group.options.find((o) => o.id === id);
        if (opt) parts.push(opt.label);
      });
    }
  });
  return parts.join(', ');
}

function addToCart(item) {
  const selections = JSON.parse(JSON.stringify(state.draftSelections[item.id]));
  const qty = state.draftQty[item.id];
  const unitPrice = priceForDraft(item);
  const summary = describeSelections(item, selections);

  // Merge into an identical existing line if one exists
  const key = item.id + '::' + JSON.stringify(selections);
  const existing = state.cart.find((l) => l.key === key);
  if (existing) {
    existing.qty += qty;
  } else {
    state.cart.push({
      key,
      lineId: 'l_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      itemId: item.id,
      name: item.name,
      qty,
      unitPrice,
      selections,
      summary,
    });
  }

  // Reset this item's draft
  initDraft(item);
  renderMenu();
  renderSummary();
}

function removeLine(lineId) {
  state.cart = state.cart.filter((l) => l.lineId !== lineId);
  renderSummary();
}

function changeLineQty(lineId, delta) {
  const line = state.cart.find((l) => l.lineId === lineId);
  if (!line) return;
  line.qty = Math.max(1, line.qty + delta);
  renderSummary();
}

function renderSummary() {
  const rows = el('summaryRows');
  rows.innerHTML = '';
  let total = 0;

  if (state.cart.length === 0) {
    rows.innerHTML = '<div class="slot-empty" style="padding:0">No items selected yet.</div>';
  }

  state.cart.forEach((line) => {
    const lineTotal = line.unitPrice * line.qty;
    total += lineTotal;
    const row = document.createElement('div');
    row.className = 'cart-line';
    row.innerHTML = `
      <div class="cart-line-main">
        <div class="cart-line-name">${line.name}${line.summary ? ` <span class="cart-line-mods">— ${line.summary}</span>` : ''}</div>
        <div class="cart-line-controls">
          <button type="button" data-action="dec">−</button>
          <span>${line.qty}</span>
          <button type="button" data-action="inc">+</button>
        </div>
      </div>
      <div class="cart-line-price">
        ${money(lineTotal)}
        <button type="button" class="remove-btn" title="Remove">×</button>
      </div>
    `;
    row.querySelector('[data-action="dec"]').addEventListener('click', () => changeLineQty(line.lineId, -1));
    row.querySelector('[data-action="inc"]').addEventListener('click', () => changeLineQty(line.lineId, 1));
    row.querySelector('.remove-btn').addEventListener('click', () => removeLine(line.lineId));
    rows.appendChild(row);
  });

  el('summaryTotal').textContent = money(total);
}

function renderDayToggle() {
  const container = el('dayToggle');
  container.innerHTML = '';

  const options = [
    { date: state.today, main: 'Today', sub: dayLabel(state.today) },
    { date: state.tomorrow, main: 'Tomorrow', sub: dayLabel(state.tomorrow) },
  ];

  options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = opt.date === state.selectedDate ? 'selected' : '';
    btn.innerHTML = `<span class="d-main">${opt.main}</span><span class="d-sub">${opt.sub}</span>`;
    btn.addEventListener('click', async () => {
      if (state.selectedDate === opt.date) return;
      state.selectedDate = opt.date;
      renderDayToggle();
      await loadSlots(opt.date);
    });
    container.appendChild(btn);
  });
}

async function loadSlots(dateStr) {
  const slotGrid = el('slotGrid');
  const emptyMsg = el('slotEmpty');
  slotGrid.innerHTML = '';
  state.selectedTime = null;

  const slots = await api(`/api/slots?date=${dateStr}`);
  if (slots.length === 0) {
    emptyMsg.style.display = 'block';
    return;
  }
  emptyMsg.style.display = 'none';

  slots.forEach((slot) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-btn';
    btn.textContent = formatTime(slot.time);
    btn.disabled = slot.full;
    btn.addEventListener('click', () => {
      state.selectedTime = slot.time;
      document.querySelectorAll('.slot-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    slotGrid.appendChild(btn);
  });
}

function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
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

  const [menu, settings] = await Promise.all([api('/api/menu'), api('/api/settings')]);
  state.menu = menu;
  state.settings = settings;
  el('bizName').textContent = settings.businessName;
  el('bizTagline').textContent = settings.tagline || 'Place your order and pick a pickup time.';
  renderMenu();
  renderSummary();

  state.today = todayStr();
  state.tomorrow = tomorrowStr();

  // Default to today unless it has no slots left, then default to tomorrow
  const todaysSlots = await api(`/api/slots?date=${state.today}`);
  state.selectedDate = todaysSlots.length > 0 ? state.today : state.tomorrow;

  renderDayToggle();
  await loadSlots(state.selectedDate);

  el('submitBtn').addEventListener('click', submitOrder);
  el('newOrderBtn').addEventListener('click', async () => {
    state.cart = [];
    state.draftSelections = {};
    state.draftQty = {};
    renderMenu();
    renderSummary();
    el('customerName').value = '';
    el('phone').value = '';
    el('notes').value = '';
    el('successView').style.display = 'none';
    el('orderView').style.display = 'block';
    window.scrollTo({ top: 0 });
    await loadSlots(state.selectedDate);
  });

  await handlePaymentReturn();
}

async function submitOrder() {
  clearError();
  const items = state.cart.map((line) => ({
    itemId: line.itemId,
    qty: line.qty,
    selections: line.selections,
  }));
  const customerName = el('customerName').value.trim();
  const phone = el('phone').value.trim();
  const notes = el('notes').value.trim();

  if (items.length === 0) return showError('Please choose at least one item.');
  if (!customerName) return showError('Please enter your name.');
  if (!phone) return showError('Please enter a phone number.');
  if (!state.selectedDate || !state.selectedTime) return showError('Please choose a pickup date and time.');

  const btn = el('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Redirecting to payment…';

  try {
    const order = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerName,
        phone,
        notes,
        items,
        pickupDate: state.selectedDate,
        pickupTime: state.selectedTime,
      }),
    });

    const checkout = await api(`/api/checkout/${order.id}`, { method: 'POST' });
    window.location.href = checkout.url; // hand off to Stripe's hosted checkout page
  } catch (err) {
    showError(err.message);
    await loadSlots(state.selectedDate); // refresh in case slot filled up
    btn.disabled = false;
    btn.textContent = 'Place order';
  }
}

// Handles the redirect back from Stripe Checkout (success or cancel).
async function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  const orderId = params.get('order');
  if (!orderId) return;

  if (sessionId) {
    try {
      const result = await api(`/api/checkout/verify?session_id=${encodeURIComponent(sessionId)}`);
      if (result.paid) {
        const order = result.order;
        el('successDetails').textContent =
          `${order.customerName}, your payment went through! We'll have your order ready for pickup on ${order.pickupDate} at ${formatTime(order.pickupTime)}.`;
        el('successOrderId').textContent = `Order #${order.id}`;
        el('orderView').style.display = 'none';
        el('successView').style.display = 'block';
        window.scrollTo({ top: 0 });
      } else {
        showError('Payment was not completed. Please try again.');
      }
    } catch (err) {
      showError('Could not verify payment: ' + err.message);
    }
  } else if (params.get('cancelled')) {
    try {
      await api(`/api/orders/${orderId}`, { method: 'DELETE' });
    } catch (err) {
      // order may already be gone; nothing to do
    }
    showError("Payment was cancelled — your order wasn't placed. Feel free to try again.");
    await loadSlots(state.selectedDate);
  }

  window.history.replaceState({}, '', window.location.pathname);
}

init().catch((err) => showError(err.message));
