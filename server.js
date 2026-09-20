const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const db = require('./db');

const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const app = express();
const PORT = process.env.PORT || 3210;
const PREP_BUFFER_MINUTES = 60; // orders must be placed at least this far ahead of pickup

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Validates one cart line against its menu item's modifier groups and
// computes its priced-out form. Throws a user-facing Error on bad input.
function resolveOrderLine(menuItem, line) {
  const qty = Math.max(1, Number(line.qty) || 1);
  const selections = line.selections || {};
  let unitPrice = menuItem.price;
  const modifiers = [];

  for (const group of menuItem.modifierGroups || []) {
    const raw = selections[group.id];
    const selectedIds = Array.isArray(raw) ? raw : raw ? [raw] : [];

    if (group.type === 'single' && selectedIds.length !== 1) {
      if (group.required) {
        throw new Error(`Please choose a ${group.label.toLowerCase()} for ${menuItem.name}.`);
      }
      continue;
    }

    const optionById = Object.fromEntries(group.options.map((o) => [o.id, o]));
    const chosen = selectedIds.map((id) => {
      const opt = optionById[id];
      if (!opt) throw new Error(`Invalid ${group.label.toLowerCase()} option for ${menuItem.name}.`);
      return opt;
    });

    // Options with a fixed priceDelta always cost that. Options with priceDelta: null
    // draw from the group's shared free allowance (e.g. "first one free, then $0.30 each").
    const fixedChosen = chosen.filter((o) => o.priceDelta !== null);
    const poolChosen = chosen.filter((o) => o.priceDelta === null);
    const fixedSum = fixedChosen.reduce((sum, o) => sum + o.priceDelta, 0);
    const freeAllowance = group.freeAllowance || 0;
    const extraCharge = group.extraCharge || 0;
    const billablePoolCount = Math.max(0, poolChosen.length - freeAllowance);
    unitPrice += fixedSum + billablePoolCount * extraCharge;

    if (chosen.length > 0) {
      modifiers.push({
        groupId: group.id,
        label: group.label,
        selected: chosen.map((o) => ({ id: o.id, label: o.label, priceDelta: o.priceDelta })),
      });
    }
  }

  unitPrice = round2(unitPrice);
  return {
    itemId: menuItem.id,
    name: menuItem.name,
    qty,
    unitPrice,
    price: round2(unitPrice * qty),
    modifiers,
  };
}

function generateSlotsForDate(dateStr, settings) {
  const date = new Date(dateStr + 'T00:00:00');
  const weekday = date.getDay();
  const windows = (settings.weeklyHours && settings.weeklyHours[weekday]) || [];
  const interval = settings.slotIntervalMinutes;

  const now = new Date();
  const isToday = dateStr === now.toISOString().slice(0, 10);
  const earliestAllowed = isToday
    ? now.getHours() * 60 + now.getMinutes() + PREP_BUFFER_MINUTES
    : -Infinity;

  const slots = [];
  windows.forEach((window) => {
    const open = timeToMinutes(window.open);
    const close = timeToMinutes(window.close);
    for (let t = open; t < close; t += interval) {
      if (t < earliestAllowed) continue;
      slots.push(minutesToTime(t));
    }
  });
  return slots.sort();
}

// ---- Menu ----
app.get('/api/menu', (req, res) => {
  const data = db.read();
  res.json(data.menu);
});

// ---- Settings ----
app.get('/api/settings', (req, res) => {
  const data = db.read();
  res.json(data.settings);
});

app.put('/api/settings', (req, res) => {
  const data = db.read();
  data.settings = { ...data.settings, ...req.body };
  db.write(data);
  res.json(data.settings);
});

// ---- Slots ----
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

  const data = db.read();
  const allSlots = generateSlotsForDate(date, data.settings);

  const countsForDate = {};
  data.orders
    .filter((o) => o.pickupDate === date && o.status !== 'cancelled')
    .forEach((o) => {
      countsForDate[o.pickupTime] = (countsForDate[o.pickupTime] || 0) + 1;
    });

  const slots = allSlots.map((time) => {
    const used = countsForDate[time] || 0;
    return {
      time,
      capacity: data.settings.maxOrdersPerSlot,
      remaining: Math.max(0, data.settings.maxOrdersPerSlot - used),
      full: used >= data.settings.maxOrdersPerSlot,
    };
  });

  res.json(slots);
});

// ---- Orders ----
app.get('/api/orders', (req, res) => {
  const data = db.read();
  let orders = data.orders;
  if (req.query.date) orders = orders.filter((o) => o.pickupDate === req.query.date);
  if (req.query.status) orders = orders.filter((o) => o.status === req.query.status);
  orders = [...orders].sort((a, b) =>
    (a.pickupDate + a.pickupTime).localeCompare(b.pickupDate + b.pickupTime)
  );
  res.json(orders);
});

app.post('/api/orders', (req, res) => {
  const { customerName, phone, items, pickupDate, pickupTime, notes } = req.body;

  if (!customerName || !phone || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'customerName, phone, and at least one item are required' });
  }
  if (!pickupDate || !pickupTime) {
    return res.status(400).json({ error: 'pickupDate and pickupTime are required' });
  }

  const data = db.read();

  // Validate the slot is still open
  const availableSlots = generateSlotsForDate(pickupDate, data.settings);
  if (!availableSlots.includes(pickupTime)) {
    return res.status(400).json({ error: 'That pickup slot is no longer available. Please choose another.' });
  }
  const usedCount = data.orders.filter(
    (o) => o.pickupDate === pickupDate && o.pickupTime === pickupTime && o.status !== 'cancelled'
  ).length;
  if (usedCount >= data.settings.maxOrdersPerSlot) {
    return res.status(409).json({ error: 'That pickup slot just filled up. Please choose another.' });
  }

  // Validate items (and their modifiers) against the menu, pricing everything server-side
  const menuById = Object.fromEntries(data.menu.map((m) => [m.id, m]));
  let orderItems;
  try {
    orderItems = items.map((it) => {
      const menuItem = menuById[it.itemId];
      if (!menuItem) throw new Error(`Unknown item: ${it.itemId}`);
      return resolveOrderLine(menuItem, it);
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const total = round2(orderItems.reduce((sum, oi) => sum + oi.price, 0));

  const order = {
    id: 'o_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    customerName,
    phone,
    items: orderItems,
    total,
    pickupDate,
    pickupTime,
    notes: notes || '',
    status: 'pending', // pending -> confirmed -> ready -> completed | cancelled
    paymentStatus: 'unpaid', // unpaid -> paid
    createdAt: new Date().toISOString(),
  };

  data.orders.push(order);
  db.write(data);
  res.status(201).json(order);
});

// ---- Payments (Stripe Checkout) ----
app.post('/api/checkout/:orderId', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Payments are not configured yet.' });

  const data = db.read();
  const order = data.orders.find((o) => o.id === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.paymentStatus === 'paid') return res.status(400).json({ error: 'Order is already paid.' });

  const origin = `${req.protocol}://${req.get('host')}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: order.items.map((it) => {
        const modNames = (it.modifiers || []).flatMap((g) => g.selected.map((o) => o.label));
        return {
          quantity: it.qty,
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(it.unitPrice * 100),
            product_data: {
              name: it.name,
              description: modNames.length ? modNames.join(', ') : undefined,
            },
          },
        };
      }),
      metadata: { orderId: order.id },
      success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&order=${order.id}`,
      cancel_url: `${origin}/?cancelled=1&order=${order.id}`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/checkout/verify', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Payments are not configured yet.' });

  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id query param required' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const orderId = session.metadata && session.metadata.orderId;
    const data = db.read();
    const order = data.orders.find((o) => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (session.payment_status === 'paid' && order.paymentStatus !== 'paid') {
      order.paymentStatus = 'paid';
      db.write(data);
    }

    res.json({ order, paid: session.payment_status === 'paid' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id', (req, res) => {
  const data = db.read();
  const order = data.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const allowedStatuses = ['pending', 'confirmed', 'ready', 'completed', 'cancelled'];
  if (req.body.status) {
    if (!allowedStatuses.includes(req.body.status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    order.status = req.body.status;
  }
  db.write(data);
  res.json(order);
});

app.delete('/api/orders/:id', (req, res) => {
  const data = db.read();
  const idx = data.orders.findIndex((o) => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  data.orders.splice(idx, 1);
  db.write(data);
  res.status(204).end();
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`Pickup orders app running at http://localhost:${PORT}`);
  console.log(`  Customer order form: http://localhost:${PORT}/`);
  console.log(`  Owner dashboard:     http://localhost:${PORT}/admin.html`);
});
