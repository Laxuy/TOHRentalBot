const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const session = require('express-session');
const { extractContractData, shouldAutoFill, describeExtraction } = require('./contractExtractor');
const { getShop } = require('./config/shops');
const db = require('./database');
require('dotenv').config();
const app = express();
app.set('trust proxy', 1);
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set. Refusing to start with an insecure default.');
  process.exit(1);
}

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID;
const STAFF_NUMBERS = (process.env.STAFF_NUMBERS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);
if (STAFF_NUMBERS.length === 0) {
  console.warn('WARNING: STAFF_NUMBERS environment variable is not set. Staff commands and notifications will not work until it is configured.');
}
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MY_NUMBER = process.env.MY_NUMBER;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

function verifyWebhookSignature(req) {
  if (!WHATSAPP_APP_SECRET) return { ok: false, reason: 'WHATSAPP_APP_SECRET not configured' };
  const signature = req.get('X-Hub-Signature-256') || '';
  if (!signature.startsWith('sha256=')) return { ok: false, reason: 'Missing or malformed signature header' };
  if (!req.rawBody) return { ok: false, reason: 'No raw body captured' };
  const expected = 'sha256=' + crypto.createHmac('sha256', WHATSAPP_APP_SECRET).update(req.rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return { ok: false, reason: 'Signature length mismatch' };
  const valid = crypto.timingSafeEqual(sigBuf, expBuf);
  return valid ? { ok: true } : { ok: false, reason: 'Signature mismatch' };
}

function checkDashboardAuth(req) {
  if (req.session && req.session.user) {
    return { ok: true, user: req.session.user.username, role: req.session.user.role };
  }
  return { ok: false, user: null };
}

function isBossRole(auth) {
  return auth.role === 'boss' || auth.role === 'admin';
}

// Simple in-memory rate limiter for login attempts (per IP address).
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return { blocked: false };
  const elapsed = Date.now() - entry.firstAttempt;
  if (elapsed > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { blocked: false };
  }
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    const retryInMin = Math.ceil((LOGIN_WINDOW_MS - elapsed) / 60000);
    return { blocked: true, retryInMin };
  }
  return { blocked: false };
}

function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

function loginPageHTML(error) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Login - TOH Operations OS</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">' +
    '<style>body{margin:0;font-family:Inter,sans-serif;background:#0f1115;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}' +
    '.box{background:#171a21;border:1px solid #262b35;border-radius:14px;padding:32px;width:100%;max-width:340px;}' +
    'h1{font-size:18px;margin:0 0 4px;}p.sub{color:#9aa1ac;font-size:13px;margin:0 0 20px;}' +
    'input{width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:12px;border-radius:8px;border:1px solid #262b35;background:#0f1115;color:#e8eaed;font-family:inherit;font-size:14px;}' +
    'button{width:100%;padding:11px;border:none;border-radius:8px;background:#4f83ff;color:#fff;font-weight:600;font-size:14px;cursor:pointer;}' +
    '.err{background:#3a1414;color:#f87171;font-size:12px;padding:8px 10px;border-radius:8px;margin-bottom:12px;}</style></head><body>' +
    '<div class="box"><h1>TOH Operations OS</h1><p class="sub">Sign in to continue</p>' +
    (error ? '<div class="err">' + error + '</div>' : '') +
    '<form method="POST" action="/login"><input name="username" placeholder="Username" autocomplete="username" required>' +
    '<input name="password" type="password" placeholder="Password" autocomplete="current-password" required>' +
    '<button type="submit">Sign In</button></form></div></body></html>';
}

app.get('/login', (req, res) => {
  res.send(loginPageHTML(null));
});

app.post('/login', async (req, res) => {
  const ip = req.ip;
  const rl = checkLoginRateLimit(ip);
  if (rl.blocked) {
    return res.send(loginPageHTML(`Too many failed attempts. Try again in ${rl.retryInMin} minute(s).`));
  }
  const { username, password } = req.body || {};
  if (!username || !password) return res.send(loginPageHTML('Enter username and password'));
  const user = db.getUserByUsername(username.trim());
  if (!user) {
    recordFailedLogin(ip);
    return res.send(loginPageHTML('Invalid username or password'));
  }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    recordFailedLogin(ip);
    return res.send(loginPageHTML('Invalid username or password'));
  }
  clearLoginAttempts(ip);
  req.session.user = { id: user.id, username: user.username, role: user.role, staffId: user.staff_id };
  db.updateUserLastLogin(user.id);
  const dest = (user.role === 'boss' || user.role === 'admin') ? '/overview' : '/staff';
  res.redirect(dest);
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/setup', async (req, res) => {
  const users = db.getAllUsers();
  if (users.length > 0) return res.status(403).send('Setup already completed. Go to <a href="/login">/login</a>.');
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>First-time Setup</title>' +
    '<style>body{font-family:sans-serif;max-width:340px;margin:60px auto;padding:0 20px;}input{width:100%;box-sizing:border-box;padding:10px;margin-bottom:10px;}button{width:100%;padding:10px;background:#2563eb;color:#fff;border:none;border-radius:6px;}</style></head><body>' +
    '<h2>Create your admin account</h2><form method="POST" action="/setup">' +
    '<input name="username" placeholder="Username" required>' +
    '<input name="password" type="password" placeholder="Password" required>' +
    '<button type="submit">Create Admin Account</button></form></body></html>');
});

app.post('/setup', async (req, res) => {
  const users = db.getAllUsers();
  if (users.length > 0) return res.status(403).send('Setup already completed.');
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).send('Username and password required');
  const hash = await bcrypt.hash(password, 10);
  db.createUser({ username: username.trim(), passwordHash: hash, role: 'admin', staffId: null });
  res.send('Admin account created. <a href="/login">Go to login</a>.');
});

const conversations = {};
const processedMessages = new Set();

function clean(str) {
  if (!str) return '';
  return str.replace(/\*\*/g, '').replace(/\*/g, '').trim();
}

async function recordBooking(data) {
  try {
    db.appendBooking(data);
    console.log('Booking saved to database');
  } catch (err) {
    console.error('Booking save error:', err.message);
  }
}

function parseThbAmount(str) {
  if (!str) return 0;
  const match = String(str).replace(/,/g, '').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

function resolveStaffLabel(phone) {
  const staff = db.getStaffByPhone(phone);
  return staff ? staff.name : `WhatsApp +${phone}`;
}

function parseCleanPrice(str) {
  if (!str) return null;
  const trimmed = String(str).trim();
  const match = trimmed.match(/^([\d,]+(?:\.\d+)?)\s*(THB)?$/i);
  if (!match) return null;
  const num = parseFloat(match[1].replace(/,/g, ''));
  return isNaN(num) ? null : num;
}

async function logFinance(type, bike, amount, description, reportedBy, status) {
  try {
    db.logFinance(type, bike, amount, description, reportedBy, status);
    console.log(`${type} logged to database${status === 'Pending' ? ' (pending)' : ''}`);
  } catch (err) {
    console.error('Finance log error:', err.message);
  }
}

async function logTask(type, description, contact) {
  try {
    db.logTask(type, description, contact);
    console.log(`Task logged: ${type}`);
  } catch (err) {
    console.error('Task log error:', err.message);
  }
}

async function getTasks() {
  try {
    return db.getTasks();
  } catch (err) {
    console.error('Tasks read error:', err.message);
    return [];
  }
}

async function resolveTask(taskId) {
  return db.resolveTask(taskId);
}

async function getBookingsWithIssues() {
  try {
    const bookings = db.getRecentBookings(500);
    const rows = bookings.map(b => [
      b.date, b.customer_name, b.phone, b.bike_type,
      b.start_date, b.end_date, b.location, b.price || ''
    ]);
    const issues = [];
    rows.forEach((row, i) => {
      const booking = {
        row: i + 2,
        date: row[0] || '',
        name: row[1] || '',
        phone: row[2] || '',
        bike: row[3] || '',
        startDate: row[4] || '',
        endDate: row[5] || '',
        location: row[6] || '',
        price: row[7] || '',
      };
      const problems = [];
      if (parseCleanPrice(booking.price) === null) problems.push('Price is not a clean number');
      const isCleanDate = (str) => /\d/.test(str || '') && !str.includes('[') && !str.includes(']');
      if (!isCleanDate(booking.startDate)) problems.push('Start Date looks invalid/placeholder');
      if (!isCleanDate(booking.endDate)) problems.push('End Date looks invalid/placeholder');
      if (problems.length > 0) issues.push({ ...booking, problems });
    });
    return { totalRows: rows.length, issues };
  } catch (err) {
    console.error('Bookings issues error:', err.message);
    return { totalRows: 0, issues: [] };
  }
}

async function getFinanceSummary() {
  try {
    return db.getFinanceSummary();
  } catch (err) {
    console.error('Finance summary error:', err.message);
    return { income: 0, expense: 0, net: 0, count: 0 };
  }
}

async function getTodayBookings() {
  try {
    const bookings = db.getTodayBookings();
    if (bookings.length === 0) return 'No bookings today yet.';
    const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });
    let msg = `*Today Bookings (${today}):*\n\n`;
    bookings.forEach((row, i) => {
      msg += `${i + 1}. ${row.bike_type || 'Unknown bike'}\n`;
      msg += `   Name: ${row.customer_name || '-'}\n`;
      msg += `   Phone: ${row.phone || '-'}\n`;
      msg += `   Start: ${row.start_date || '-'}\n`;
      msg += `   End: ${row.end_date || '-'}\n`;
      msg += `   Location: ${row.location || '-'}\n\n`;
    });
    return msg;
  } catch (err) {
    console.error('Bookings read error:', err.message);
    return 'Could not read bookings.';
  }
}

function daysBetweenEnGBDates(startStr, endStr) {
  const parse = (s) => {
    if (!s) return null;
    const parts = String(s).split('/').map(Number);
    const [d, m, y] = parts;
    if (!d || !m || !y) return null;
    return new Date(y, m - 1, d);
  };
  const start = parse(startStr);
  const end = parse(endStr);
  if (!start || !end) return null;
  const diffMs = end - start;
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
}

async function getAllRentalHistory() {
  try {
    return db.getAllRentalHistory();
  } catch (err) {
    console.error('Rental history error:', err.message);
    return [];
  }
}

async function getRentalHistoryForBike(bikeId) {
  try {
    return db.getRentalHistoryForBike(bikeId);
  } catch (err) {
    console.error('Bike history error:', err.message);
    return [];
  }
}

async function findBikeRow(plateQuery) {
  const bike = db.getMotorbikeByPlate(plateQuery);
  if (!bike) return null;
  return { bikeId: bike.plate, rowNumber: 0, status: bike.status, model: bike.model };
}

async function setBikeStatus(plateQuery, status, options = {}) {
  const result = await setBikeStatusInner(plateQuery, status, options);
  if (result.ok) {
    const who = options.loggedBy ? ` (by ${options.loggedBy})` : '';
    notifyStaff(`${result.message}${who}`).catch(err => console.error('Staff notify failed:', err.message));
  }
  return result;
}

async function setBikeStatusInner(plateQuery, status, options = {}) {
  const bike = db.getMotorbikeByPlate(plateQuery);
  if (!bike) {
    return { ok: false, message: `Couldn't find a bike matching "${plateQuery}".` };
  }

  if (status === 'Rented') {
    if (bike.status === 'Rented') {
      return { ok: false, message: `${bike.plate} is already Rented. Use "return ${bike.plate}" first.` };
    }
    if (bike.status === 'Maintenance') {
      return { ok: false, message: `${bike.plate} is in Maintenance and cannot be rented.` };
    }
    if (bike.status === 'Reserved') {
      return { ok: false, message: `${bike.plate} is Reserved. Resolve the reservation first.` };
    }
    const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });
    const result = db.createRental({
      plate: bike.plate,
      customer_name: options.renterName || '',
      customer_phone: options.renterPhone || '',
      start_date: options.rentedDate || today,
      end_date: options.expectedReturn || '',
      price: parseFloat(options.price) || 0,
      logged_by: options.loggedBy || '',
    });
    if (!result.ok) return result;
    if (options.paymentStatus === 'paid' && parseFloat(options.price) > 0) {
      await logFinance('Income', bike.plate, parseFloat(options.price), `Rental - ${options.renterName || result.customer || 'customer'}`, options.loggedBy || 'Staff', 'Confirmed');
      return { ok: true, message: `${bike.plate} marked as Rented. Payment of ${options.price} THB recorded.` };
    }
    if (options.paymentStatus === 'npy') {
      await logFinance('Income', bike.plate, parseFloat(options.price) || 0, `Rental - ${options.renterName || result.customer || 'customer'} (not paid yet)`, options.loggedBy || 'Staff', 'Pending');
      return { ok: true, message: `${bike.plate} marked as Rented. Payment marked as NOT paid yet — use "paid ${bike.plate} <amount>" once collected.` };
    }
    return { ok: true, message: `${bike.plate} marked as Rented.` };
  }

  if (status === 'Available') {
    if (bike.status === 'Available' || bike.status === '') {
      return { ok: false, message: `${bike.plate} is already Available. No active rental to return.` };
    }
    if (bike.status === 'Maintenance') {
      return { ok: false, message: `${bike.plate} is in Maintenance - clear that status first.` };
    }
    const result = db.completeRental(bike.plate, options.price || '0', options.loggedBy || '');
    if (!result.ok) return result;
    return { ok: true, message: `${bike.plate} marked as Available (returned from ${result.customer}).` };
  }

  const statusMap = { Maintenance: 'Maintenance', maintenance: 'Maintenance', Reserved: 'Reserved', reserved: 'Reserved' };
  const newStatus = statusMap[status] || status;
  db.updateBikeStatus(bike.plate, newStatus);
  return { ok: true, message: `${bike.plate} marked as ${newStatus}.` };
}

async function autoFillContractToFleet(extracted) {
  const bike = db.getMotorbikeByPlate(extracted.plate);
  if (!bike) {
    return { ok: false, message: `Auto-fill skipped: no bike found for plate "${extracted.plate}".` };
  }
  if (bike.status === 'Rented') {
    return { ok: false, message: `${bike.plate} is already Rented. Auto-fill blocked.` };
  }
  if (bike.status === 'Maintenance') {
    return { ok: false, message: `${bike.plate} is in Maintenance. Auto-fill blocked.` };
  }
  const result = db.createRental({
    plate: bike.plate,
    customer_name: extracted.renterName || '',
    customer_phone: extracted.renterPhone || '',
    start_date: extracted.rentedDate || '',
    end_date: extracted.expectedReturn || '',
    price: extracted.price || 0,
    logged_by: 'Contract OCR',
  });
  if (!result.ok) return result;
  return { ok: true, message: `${bike.plate} auto-filled from contract (${extracted.renterName}).` };
}

async function getFleetAvailability() {
  try {
    return db.getFleetAvailability();
  } catch (err) {
    console.error('Fleet availability error:', err.message);
    return {};
  }
}

async function getFleetList() {
  const bikes = db.getAllMotorbikes();
  const activeRentals = db.getActiveRentals();
  const byPlate = new Map(activeRentals.map(r => [r.plate, r]));
  return bikes.map(b => {
    const rental = byPlate.get(b.plate);
    return {
      bikeId: b.plate,
      model: b.model,
      color: b.color,
      location: b.location,
      renterName: rental?.customer_name || '',
      renterPhone: rental?.customer_phone || '',
      rentedDate: rental?.start_date || '',
      expectedReturn: rental?.end_date || '',
      returnedDate: '',
      loggedBy: rental?.logged_by || '',
      status: b.status,
      notes: b.notes,
    };
  });
}

function formatFleetSummary(byType) {
  const types = Object.keys(byType);
  if (types.length === 0) return 'Fleet data unavailable right now.';
  let msg = '';
  types.forEach(type => {
    const { total, available } = byType[type];
    msg += `- ${type}: ${available}/${total} available\n`;
  });
  return msg;
}

async function getNearestBikes() {
  try {
    const bikes = db.getAllMotorbikes().filter(b => b.status === 'Available');
    if (bikes.length === 0) return 'No bikes available right now.';
    let msg = '*Nearest Available Bikes:*\n\n';
    bikes.slice(0, 8).forEach((b, i) => {
      msg += `${i + 1}. ${b.plate} - ${b.model} (${b.color || 'N/A'})\n`;
      msg += `   Location: ${b.location || 'Chaweng'} - Status: ${b.status}\n\n`;
    });
    if (bikes.length > 8) msg += `...and ${bikes.length - 8} more available bikes.\n`;
    msg += 'Share your location pin (attach -> Location) for distance-sorted results.';
    return msg;
  } catch (err) {
    console.error('Nearest bikes error:', err.message);
    return 'Could not load fleet data right now.';
  }
}

async function logPhotoReceived(from, mediaId, mimeType) {
  try {
    db.logPhoto(from, mediaId, mimeType);
  } catch (err) {
    console.error('Photo log error:', err.message);
  }
}

async function forwardImageToStaff(mediaId, caption) {
  await Promise.all(
    STAFF_NUMBERS.map(num =>
      axios
        .post(
          `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: 'whatsapp',
            to: num,
            type: 'image',
            image: { id: mediaId, caption },
          },
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        )
        .catch(err => console.error('Forward image error:', err.message))
    )
  );
}

async function handleIncomingPhoto(from, mediaId) {
  try {
    const metaRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const mimeType = metaRes.data.mime_type || 'image/jpeg';
    const mediaUrl = metaRes.data.url;

    try {
      await forwardImageToStaff(mediaId, `Photo from +${from}`);
    } catch (fwdErr) {
      console.error('Forward step failed:', fwdErr.message);
    }
    try {
      await logPhotoReceived(from, mediaId, mimeType);
    } catch (logErr) {
      console.error('Log photo step failed:', logErr.message);
    }

    try {
      const extracted = await extractContractData(mediaUrl, `Bearer ${WHATSAPP_TOKEN}`);
      if (shouldAutoFill(extracted)) {
        const result = await autoFillContractToFleet(extracted);
        if (result.ok) {
          await notifyStaff(`Auto-filled fleet from contract photo (+${from}):\n${result.message}`);
        } else {
          await notifyStaff(`Contract read OK but couldn't auto-fill (+${from}):\n${result.message}\nPlease enter manually.`);
          await logTask('Contract Auto-fill Failed', result.message + '\n' + describeExtraction(extracted), `+${from}`);
        }
      } else {
        const taskDesc = describeExtraction(extracted);
        await notifyStaff(`Contract photo from +${from} needs manual entry.\n${taskDesc}\nPlease check the photo above and use "rent <plate>".`);
        await logTask('Contract Needs Manual Entry', taskDesc, `+${from}`);
      }
    } catch (extractErr) {
      console.error('Contract extraction error:', extractErr.message);
      await notifyStaff(`Couldn't auto-read contract photo from +${from} - please enter manually.`);
      await logTask('Contract Read Error', extractErr.message, `+${from}`);
    }

    await sendWhatsApp(from, 'Got it, sent to our team.');
  } catch (err) {
    console.error('Photo handling error:', err.message);
    await sendWhatsApp(from, "Sorry, I couldn't process that photo - please try sending it again.");
  }
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const sigCheck = verifyWebhookSignature(req);
  if (!sigCheck.ok) {
    console.error('Webhook signature rejected:', sigCheck.reason);
    return res.sendStatus(401);
  }
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message) {
      const msgId = message.id;
      if (processedMessages.has(msgId)) return res.sendStatus(200);
      processedMessages.add(msgId);
      const from = message.from;

      if (message.type === 'text') {
        const text = message.text.body.trim();
        console.log(`Message from ${from}: ${text}`);

        const isStaff = STAFF_NUMBERS.includes(from);

        if (isStaff) {
          const cmd = text.toLowerCase();
          if (cmd === 'list today') {
            const list = await getTodayBookings();
            await sendWhatsApp(from, list);
            return res.sendStatus(200);
          }
          if (cmd === 'fleet') {
            const byType = await getFleetAvailability(true);
            await sendWhatsApp(from, `*Fleet Availability:*\n\n${formatFleetSummary(byType)}`);
            return res.sendStatus(200);
          }
          const rentMatch = text.match(/^rent\s+(\S+)(?:\s+(NPY|npy|\d+(?:\.\d+)?))?\s*$/i);
          if (rentMatch) {
            const [, plate, paymentInput] = rentMatch;
            let price = 0;
            let paymentStatus = 'unpaid';
            if (paymentInput && /^npy$/i.test(paymentInput)) {
              paymentStatus = 'npy';
            } else if (paymentInput) {
              price = parseFloat(paymentInput) || 0;
              paymentStatus = 'paid';
            }
            const result = await setBikeStatus(plate, 'Rented', {
              price,
              paymentStatus,
              loggedBy: resolveStaffLabel(from),
            });
            await sendWhatsApp(from, result.message);
            return res.sendStatus(200);
          }
          const paidMatch = text.match(/^paid\s+(\S+)\s+(\d+(?:\.\d+)?)\s*$/i);
          if (paidMatch) {
            const [, plate, priceStr] = paidMatch;
            const price = parseFloat(priceStr) || 0;
            await logFinance('Income', plate, price, `Payment received (was pending)`, resolveStaffLabel(from), 'Confirmed');
            await sendWhatsApp(from, `Payment of ${price} THB recorded for ${plate}.`);
            return res.sendStatus(200);
          }
          if (/^pending\s*$/i.test(text)) {
            const pending = db.getPendingPayments();
            if (pending.length === 0) {
              await sendWhatsApp(from, 'No pending payments right now.');
            } else {
              const lines = pending.map(p => `${p.bike} — ${p.amount} THB (${p.date})`).join('\n');
              await sendWhatsApp(from, `Pending payments:\n${lines}`);
            }
            return res.sendStatus(200);
          }
          const returnMatch = text.match(/^return\s+(\S+)(?:\s+(\d+(?:\.\d+)?))?\s*$/i);
          if (returnMatch) {
            const [, plate, priceStr] = returnMatch;
            const result = await setBikeStatus(plate, 'Available', {
              price: priceStr || '',
              loggedBy: resolveStaffLabel(from),
            });
            await sendWhatsApp(from, result.message);
            return res.sendStatus(200);
          }
          const expenseMatch = text.match(/^expense\s+(\S+)\s+(\d+(?:\.\d+)?)\s*(.*)$/i);
          if (expenseMatch) {
            const [, bike, amountStr, description] = expenseMatch;
            await logFinance('Expense', bike, parseFloat(amountStr), description || 'No description', resolveStaffLabel(from));
            await sendWhatsApp(from, `Logged: ${amountStr} THB expense for ${bike}${description ? ' - ' + description : ''}`);
            return res.sendStatus(200);
          }
          if (cmd === 'finance' || cmd === 'income') {
            const summary = await getFinanceSummary();
            if (!summary) {
              await sendWhatsApp(from, "Couldn't load finance data right now.");
            } else {
              await sendWhatsApp(
                from,
                `*Finance Summary:*\n\nTotal Income: ${summary.income.toLocaleString()} THB\nTotal Expenses: ${summary.expense.toLocaleString()} THB\nNet: ${summary.net.toLocaleString()} THB\n(${summary.count} entries)`
              );
            }
            return res.sendStatus(200);
          }
          if (cmd === 'help' || cmd === 'commands') {
            await sendWhatsApp(
              from,
              "Staff commands:\n- fleet: full bike availability\n- list today: today's bookings\n- rent <plate>: mark a bike as rented (e.g. rent 3990)\n- return <plate> [price]: mark a bike as available, optionally logging the price paid (e.g. return 3990 1200)\n- expense <plate> <amount> <description>: log an expense (e.g. expense 3990 500 broken mirror)\n- finance: income/expense/profit summary"
            );
            return res.sendStatus(200);
          }
          await sendWhatsApp(from, "Didn't recognize that as a command. Text 'help' to see what I can do.");
          return res.sendStatus(200);
        }

        await handleMessage(from, text);
      } else if (message.type === 'location') {
        const nearby = await getNearestBikes();
        await sendWhatsApp(from, nearby);
      } else if (message.type === 'image') {
        const mediaId = message.image.id;
        console.log(`Image from ${from}: media ${mediaId}`);
        await handleIncomingPhoto(from, mediaId);
      } else {
        await sendWhatsApp(from, 'Sorry, I can only read text messages, photos, or shared locations. Please type your question, send a photo, or share your location.');
      }
    }
  }
  res.sendStatus(200);
});

async function extractBookingJSON(summaryText) {
  const schema = {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING' },
      phone: { type: 'STRING' },
      bike: { type: 'STRING' },
      startDate: { type: 'STRING' },
      endDate: { type: 'STRING' },
      location: { type: 'STRING' },
      price: { type: 'NUMBER' },
    },
    required: ['name', 'phone', 'bike', 'startDate', 'endDate', 'location', 'price'],
  };
  const prompt = `Extract the booking details from this confirmed booking summary into the given JSON schema. The "price" field must be ONLY the total number in THB. If a field is genuinely missing from the summary, use an empty string for text fields or 0 for price. Do not invent details that aren't in the summary.\n\nBooking summary:\n${summaryText}`;

  const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  });
  const jsonText = response.data.candidates[0].content.parts[0].text;
  return JSON.parse(jsonText);
}

async function handleMessage(from, text) {
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  if (!conversations[from]) {
    conversations[from] = { history: [], bookingData: {}, stage: 'chat' };
  }
  const conv = conversations[from];
  conv.history.push({ role: 'user', parts: [{ text }] });

  const fleetData = await getFleetAvailability();
  const fleetSummary = formatFleetSummary(fleetData);

  const systemPrompt = `You are a helpful booking assistant for TOH Motorbike Rental in Koh Samui, Thailand. You help customers choose and book motorbikes.

CURRENT LIVE FLEET AVAILABILITY (bike type: available/total bikes right now):
${fleetSummary}
If a bike type shows 0 available, tell the customer it's fully booked right now and suggest a similar available alternative. Match the customer's wording to the closest bike type in this list. Never say a bike is available if its available count is 0.

If a customer asks how far a bike is, where the nearest bike is, or anything about distance/location, ask them to share their location using WhatsApp's location-sharing feature. Do not guess distances yourself.

ABOUT TOH:
- Located in Chaweng, Koh Samui
- Over 5 years experience, fleet of 100+ well-maintained bikes
- Only Honda and Yamaha bikes
- Open 7 days a week
- Phone: +66 622 531 159

OUR BIKES AND PRICES (THB per day - rate depends on rental length):
- Honda Scoopy 110cc (2022-2025): 300 THB/day for 1-2 days, 250 THB/day for 3+ days
- Honda Click 125cc (2022-2026): 300 THB/day for 1-2 days, 250 THB/day for 3+ days
- Honda Click 150cc (2022-2025): 300 THB/day for 1-2 days, 250 THB/day for 3+ days
- Yamaha Filano 125cc (2022-2025): 300 THB/day for 1-2 days, 250 THB/day for 3+ days
- Honda Click 160cc (2022-2025): 400 THB/day for 1-2 days, 350 THB/day for 3+ days
- Yamaha Aerox 155cc (2020-2022): 350 THB/day for 1-2 days, 300 THB/day for 3+ days
- Yamaha Nmax 155cc (2021-2026): 450 THB/day for 1-2 days, 400 THB/day for 3+ days
- Honda ADV 160cc (2024-2026): 450 THB/day for 1-2 days, 400 THB/day for 3+ days
- Honda PCX 160cc (2022-2025): 450 THB/day for 1-2 days, 400 THB/day for 3+ days
- Yamaha Xmax 300cc (2022-2025): 850 THB/day for 1-2 days, 800 THB/day for 3+ days
- Honda ADV 350cc (2022-2025): 900 THB/day for 1-2 days, 850 THB/day for 3+ days
- Honda XADV 750cc (2025): 2500 THB/day for 1-2 days, 2000 THB/day for 3+ days
- Honda Forza: 750 THB/day (single rate, confirm with staff for exact terms)

PRICING RULE: If the rental is 1 or 2 days, use the 1-2 days rate x number of days. If the rental is 3 or more days, use the 3+ days rate x number of days.
If a customer asks about a bike not in this price list, do not make up a price. Tell them you'll need to check with staff.

DELIVERY & PICKUP ZONES:
- In-zone: Chaweng, Chaweng Noi, Bo Put, Choeng Mon, Maenam, Bang Rak, Central Samui, Lamai
- Out-of-zone: Nathon, Taling Ngam, Lipa Noi, Baan Tai
- If the customer names a pickup location not in either list, do not guess which zone it's in.
- Never finalize a booking for an out-of-zone or unrecognized location without staff confirmation first.

BOOKING: Collect full name, phone number, bike type, rental start date, rental end date, pickup location.
- Today's date is ${todayStr} in Koh Samui.
- When summarizing booking details, do not use markdown formatting.
- Price must be the TOTAL cost for the full rental period.
Once you have all details say exactly: "BOOKING_COMPLETE" followed by a plain text summary.
If customer needs human help say exactly: "NEED_HUMAN_HELP".
Be friendly, helpful and concise. Answer in the same language the customer writes in.`;

  try {
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: conv.history,
    });
    const reply = response.data.candidates[0].content.parts[0].text;
    conv.history.push({ role: 'model', parts: [{ text: reply }] });

    if (reply.includes('BOOKING_COMPLETE')) {
      const cleanReply = reply.replace('BOOKING_COMPLETE', '').trim();
      await sendWhatsApp(from, 'Booking confirmed!\n\n' + cleanReply);
      await notifyStaff(`NEW BOOKING from +${from}:\n\n${cleanReply}`);

      let bookingData;
      try {
        const extracted = await extractBookingJSON(cleanReply);
        bookingData = {
          name: extracted.name,
          phone: extracted.phone || from,
          bike: extracted.bike,
          startDate: extracted.startDate,
          endDate: extracted.endDate,
          location: extracted.location,
          price: extracted.price ? `${extracted.price} THB` : '',
        };
      } catch (jsonErr) {
        console.error('Booking JSON extraction failed, falling back to regex:', jsonErr.message);
        bookingData = {
          name: cleanReply.match(/Full Name[:\s]+([^\n]+)/i)?.[1],
          phone: cleanReply.match(/Phone Number[:\s]+([^\n]+)/i)?.[1] || from,
          bike: cleanReply.match(/Bike Type[:\s]+([^\n]+)/i)?.[1],
          startDate: cleanReply.match(/Start Date[:\s]+([^\n]+)/i)?.[1],
          endDate: cleanReply.match(/End Date[:\s]+([^\n]+)/i)?.[1],
          location: cleanReply.match(/Pickup Location[:\s]+([^\n]+)/i)?.[1],
          price: cleanReply.match(/Price[:\s]+([^\n]+)/i)?.[1],
        };
      }
      await recordBooking(bookingData);
      // Note: income is no longer logged here. This is just a reservation from
      // the chat — real payment is only recorded when staff actually hand over
      // the bike via the "rent" command/dashboard (with a price, or NPY).
      console.log(`Booking completed for ${from}`);
    } else if (reply.includes('NEED_HUMAN_HELP')) {
      await sendWhatsApp(from, 'No problem! Our staff will contact you shortly.');
      await notifyStaff(`Customer +${from} needs human help!\nLast message: ${text}`);
      await logTask('Customer Needs Human Help', text, `+${from}`);
    } else {
      await sendWhatsApp(from, reply);
    }
  } catch (err) {
    console.error('Gemini error:', err.message);
    await sendWhatsApp(from, 'Sorry, something went wrong. Please try again.');
  }
}

async function sendWhatsApp(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
  }
}

async function notifyStaff(message) {
  await Promise.all(STAFF_NUMBERS.map(num => sendWhatsApp(num, message)));
}

async function getRecentBookings() {
  return db.getRecentBookings(10);
}

async function getRecentPhotos() {
  return db.getRecentPhotos(10);
}

async function getDashboardStats() {
  const stats = db.getDashboardStats();
  return {
    activeRentals: stats.activeRentals || 0,
    openTasks: stats.openTasks || 0,
    recentBookings: db.getRecentBookings(10),
    finance: stats.finance,
    fleet: {
      total: stats.totalBikes || 0,
      available: stats.available || 0,
      rented: stats.rented || 0,
      other: stats.maintenance || 0,
    },
  };
}

app.get('/api/dashboard-data', async (req, res) => {
  try {
    const stats = await getDashboardStats();
    const bookings = await getRecentBookings();
    const photos = await getRecentPhotos();
    res.json({ stats, bookings, photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/:shopId/motorbikes', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const bikes = await getFleetList();
    res.json({ bikes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/:shopId/motorbikes/:bikeId/status', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const { status, renterName, renterPhone, expectedReturn, price, paymentStatus } = req.body || {};
    const result = await setBikeStatus(req.params.bikeId, status, {
      renterName,
      renterPhone,
      expectedReturn,
      price,
      paymentStatus,
      loggedBy: auth.user,
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/:shopId/motorbikes/:bikeId/history', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const history = await getRentalHistoryForBike(req.params.bikeId);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/:shopId/rentals', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const bookings = db.getActiveRentals();
    res.json({ bookings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/:shopId/dashboard', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const data = await getDashboardStats();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/:shopId/tasks', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const tasks = await getTasks();
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/:shopId/tasks/:taskId/resolve', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const result = await resolveTask(req.params.taskId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/:shopId/data-quality', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const report = await getBookingsWithIssues();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/:shopId/rental-history', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const history = await getAllRentalHistory();
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/:shopId/staff', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const staff = db.getAllStaff();
    res.json({ staff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/:shopId/staff', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  if (!isBossRole(auth)) return res.status(403).json({ error: 'Boss access only' });
  try {
    getShop(req.params.shopId);
    const { name, phone, role, shiftStart, shiftEnd } = req.body || {};
    if (!name || !role) return res.status(400).json({ error: 'name and role are required' });
    const result = db.addStaff({ name, phone, role, shiftStart, shiftEnd });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/:shopId/staff/:staffId', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  if (!isBossRole(auth)) return res.status(403).json({ error: 'Boss access only' });
  try {
    getShop(req.params.shopId);
    const result = db.removeStaff(req.params.staffId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/:shopId/staff/:staffId/checkin', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const result = db.checkInStaff(req.params.staffId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/:shopId/staff/:staffId/checkout', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const result = db.checkOutStaff(req.params.staffId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/:shopId/staff/:staffId/leave', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  try {
    getShop(req.params.shopId);
    const result = db.setStaffLeave(req.params.staffId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/:shopId/staff/:staffId/shift', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  if (!isBossRole(auth)) return res.status(403).json({ error: 'Boss access only' });
  try {
    getShop(req.params.shopId);
    const { shiftStart, shiftEnd } = req.body || {};
    const result = db.updateStaffShift(req.params.staffId, shiftStart, shiftEnd, auth.user);
    if (result.ok && result.staff && result.staff.phone) {
      sendWhatsApp(result.staff.phone, `Hi ${result.staff.name}, your shift has been updated to ${shiftStart} - ${shiftEnd}.`)
        .catch(err => console.error('Shift notify failed:', err.message));
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/:shopId/staff/:staffId/hours', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  if (!isBossRole(auth)) return res.status(403).json({ error: 'Boss access only' });
  try {
    getShop(req.params.shopId);
    const { todayHours, weekHours } = req.body || {};
    const result = db.editStaffHours(req.params.staffId, todayHours, weekHours, auth.user);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/:shopId/staff/:staffId/create-login', async (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  if (!isBossRole(auth)) return res.status(403).json({ error: 'Boss access only' });
  try {
    getShop(req.params.shopId);
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const staff = db.getStaffById(req.params.staffId);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    const existing = db.getUserByUsername(username.trim());
    if (existing) return res.status(400).json({ error: 'Username already taken' });
    const hash = await bcrypt.hash(password, 10);
    const result = db.createUser({
      username: username.trim(),
      passwordHash: hash,
      role: staff.role === 'boss' ? 'boss' : 'staff',
      staffId: staff.id,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function dashboardShell(token, title, bodyAttrs, bodyHTML, isBoss) {
  if (isBoss === undefined) isBoss = true;
  const active = page =>
    title.includes(page)
      ? ' bg-secondary-container text-on-secondary-container rounded-lg'
      : ' text-on-surface-variant hover:bg-surface-container-high transition-colors rounded-lg';
  const t = encodeURIComponent(token);
  return '<!DOCTYPE html><html class="light" lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta content="width=device-width, initial-scale=1.0" name="viewport">' +
    '<title>' + title + ' - TOH Rental</title>' +
    '<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>' +
    '<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">' +
    '<link href="https://fonts.googleapis.com" rel="preconnect">' +
    '<link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect">' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">' +
    '<script id="tailwind-config">tailwind.config={darkMode:"class",theme:{extend:{"colors":{"outline-variant":"#c1c6d7","background":"#faf8ff","surface-container":"#eaedff","primary-container":"#0070eb","surface-bright":"#faf8ff","on-surface-variant":"#414755","surface-container-low":"#f2f3ff","on-background":"#131b2e","surface-container-lowest":"#ffffff","outline":"#717786","secondary-container":"#d5e3fd","on-surface":"#131b2e","surface":"#faf8ff","surface-tint":"#005bc1","secondary":"#515f74","surface-container-high":"#e2e7ff","surface-container-highest":"#dae2fd","primary":"#0058bc","on-primary":"#ffffff","on-primary-container":"#fefcff","on-secondary-container":"#57657b","error":"#ba1a1a"},"borderRadius":{"DEFAULT":"0.125rem","lg":"0.25rem","xl":"0.5rem","full":"0.75rem"},"spacing":{"gutter":"16px","md":"16px","xs":"8px","base":"4px","margin-mobile":"16px","margin-desktop":"32px","sm":"12px","xl":"32px","lg":"24px"},"fontFamily":{"status-badge":["Inter"],"headline-md":["Inter"],"body-md":["Inter"],"body-lg":["Inter"],"label-caps":["JetBrains Mono"],"headline-lg":["Inter"]},"fontSize":{"status-badge":["12px",{"lineHeight":"12px","fontWeight":"700"}],"headline-md":["20px",{"lineHeight":"28px","fontWeight":"600"}],"body-md":["14px",{"lineHeight":"20px","fontWeight":"400"}],"label-caps":["12px",{"lineHeight":"16px","letterSpacing":"0.05em","fontWeight":"600"}],"headline-lg":["24px",{"lineHeight":"32px","fontWeight":"600"}]}}}};</script>' +
    '<style>.material-symbols-outlined{font-variation-settings:"FILL" 0,"wght" 400,"GRAD" 0,"opsz" 24}.no-scrollbar::-webkit-scrollbar{display:none}.no-scrollbar{-ms-overflow-style:none;scrollbar-width:none}body{min-height:max(884px,100dvh)}.pill-available{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}.pill-rented{background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe}.pill-maintenance{background:#fef3c7;color:#92400e;border:1px solid #fde68a}.pill-reserved{background:#ede9fe;color:#5b21b6;border:1px solid #ddd6fe}.pill-active{background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe}.pill-done{background:#f3f4f6;color:#374151;border:1px solid #e5e7eb}.pill-open{background:#fef3c7;color:#92400e;border:1px solid #fde68a}.pill-resolved{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}</style>' +
    '</head><body class="bg-surface text-on-surface font-body-md min-h-screen flex flex-col md:flex-row"' + (bodyAttrs || '') + '>' +
    '<header class="flex justify-between items-center w-full px-margin-mobile h-16 z-50 bg-surface border-b border-outline-variant md:hidden sticky top-0"><h1 class="font-headline-lg text-headline-lg font-bold text-primary tracking-tight">TOH Rental</h1></header>' +
    '<aside class="hidden md:flex flex-col h-full py-lg gap-xs bg-surface border-r border-outline-variant fixed left-0 top-0 w-[280px] z-40 overflow-y-auto no-scrollbar"><div class="px-4 mb-6"><h1 class="font-headline-md text-headline-md text-primary mb-6">TOH Rental</h1></div><nav class="flex flex-col gap-2">' +
    (isBoss ? '<a class="flex items-center gap-4' + active('Overview') + ' px-4 py-3 mx-2" href="/overview?token=' + t + '"><span class="material-symbols-outlined">dashboard</span><span class="font-label-caps text-label-caps">Overview</span></a>' : '') +
    '<a class="flex items-center gap-4' + active('Motorbikes') + ' px-4 py-3 mx-2" href="/motorbikes?token=' + t + '"><span class="material-symbols-outlined">two_wheeler</span><span class="font-label-caps text-label-caps">Motorbikes</span></a>' +
    '<a class="flex items-center gap-4' + active('Rentals') + ' px-4 py-3 mx-2" href="/rentals?token=' + t + '"><span class="material-symbols-outlined">receipt_long</span><span class="font-label-caps text-label-caps">Rentals</span></a>' +
    (isBoss ? '<a class="flex items-center gap-4' + active('AI Task') + ' px-4 py-3 mx-2" href="/ai-tasks?token=' + t + '"><span class="material-symbols-outlined">smart_toy</span><span class="font-label-caps text-label-caps">AI Tasks</span></a>' : '') +
    (isBoss ? '<a class="flex items-center gap-4' + active('Data Quality') + ' px-4 py-3 mx-2" href="/data-quality?token=' + t + '"><span class="material-symbols-outlined">verified</span><span class="font-label-caps text-label-caps">Data Quality</span></a>' : '') +
    '<a class="flex items-center gap-4' + active('Rental History') + ' px-4 py-3 mx-2" href="/rental-history?token=' + t + '"><span class="material-symbols-outlined">history</span><span class="font-label-caps text-label-caps">Rental History</span></a>' +
    '<a class="flex items-center gap-4' + active('Staff') + ' px-4 py-3 mx-2" href="/staff?token=' + t + '"><span class="material-symbols-outlined">badge</span><span class="font-label-caps text-label-caps">Staff</span></a>' +
    '</nav></aside>' + bodyHTML + '</body></html>';
}

app.get('/overview', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.redirect('/login');
  if (!isBossRole(auth)) return res.redirect('/motorbikes');
  const token = req.query.token || '';
  res.send(dashboardShell(token, 'Overview', '', '<main class="flex-1 md:ml-[280px] pb-24 md:pb-8"><header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0"><h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Overview</h2></header><div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6"><div class="grid grid-cols-2 md:grid-cols-4 gap-4" id="stats"></div><div class="grid grid-cols-1 lg:grid-cols-2 gap-6"><div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-6"><h3 class="font-headline-md text-headline-md mb-4">Active Rentals</h3><div id="activeRentals" class="text-on-surface-variant text-sm space-y-3"></div></div><div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-6"><h3 class="font-headline-md text-headline-md mb-4">Fleet Status</h3><div id="fleetStatus" class="space-y-3"></div></div></div><div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-6"><h3 class="font-headline-md text-headline-md mb-4">Pending AI Reviews</h3><div id="pendingTasks" class="text-on-surface-variant text-sm space-y-2"></div></div></div></main><script>const TOKEN=' + JSON.stringify(token) + ';async function load(){try{const [dRes,tRes,bRes]=await Promise.all([fetch("/api/toh/dashboard"+(TOKEN?"?token="+encodeURIComponent(TOKEN):"")),fetch("/api/toh/tasks"+(TOKEN?"?token="+encodeURIComponent(TOKEN):"")),fetch("/api/toh/motorbikes"+(TOKEN?"?token="+encodeURIComponent(TOKEN):""))]);const d=await dRes.json(),tasks=await tRes.json(),mb=await bRes.json();if(d.error){document.getElementById("stats").innerHTML="<span class=\\"text-error\\">"+d.error+"</span>";return;}const f={available:d.available||0,rented:d.rented||0,other:d.maintenance||0,total:d.totalBikes||0};const bikes=mb.bikes||[];document.getElementById("stats").innerHTML=[{label:"Active Rentals",value:d.activeRentals||0,icon:"receipt_long",color:"#3b82f6"},{label:"Available Now",value:f.available||0,icon:"check_circle",color:"#10b981"},{label:"Currently Rented",value:f.rented||0,icon:"directions_bike",color:"#6366f1"},{label:"Today Income",value:(d.finance?d.finance.income.toLocaleString():"0")+" THB",icon:"payments",color:"#f59e0b"}].map(function(s){return "<div class=\\"bg-surface-container-lowest border border-outline-variant rounded-xl p-4 flex flex-col gap-1\\"><div class=\\"flex items-center gap-2\\"><span class=\\"material-symbols-outlined text-sm\\" style=\\"color:"+s.color+"\\">"+s.icon+"</span><span class=\\"text-xs text-on-surface-variant\\">"+s.label+"</span></div><div class=\\"text-2xl font-bold font-label-caps tracking-tight\\">"+s.value+"</div></div>";}).join("");const rentedBikes=bikes.filter(function(b){return b.status==="Rented";});document.getElementById("activeRentals").innerHTML=rentedBikes.length?rentedBikes.map(function(b){return "<div class=\\"flex justify-between items-center py-2 border-b border-outline-variant last:border-0\\"><div><span class=\\"font-semibold font-label-caps\\">"+b.bikeId+"</span> <span class=\\"text-xs\\">"+b.model+"</span></div><span class=\\"pill-rented text-xs px-2 py-1 rounded-full font-status-badge\\">Rented</span></div>";}).join(""):"<div class=\\"text-sm\\">No active rentals</div>";const pct=f.total?Math.round(f.available/f.total*100):0;document.getElementById("fleetStatus").innerHTML="<div class=\\"flex items-center gap-3 mb-3\\"><div class=\\"flex-1 bg-outline-variant rounded-full h-3\\"><div class=\\"bg-emerald-500 h-3 rounded-full transition-all\\" style=\\"width:"+pct+"%\\"></div></div><span class=\\"text-sm font-label-caps\\">"+(f.available||0)+"/"+(f.total||0)+"</span></div><div class=\\"grid grid-cols-3 gap-3 text-center\\"><div class=\\"bg-emerald-50 rounded-lg p-3\\"><div class=\\"text-lg font-bold text-emerald-700 font-label-caps\\">"+(f.available||0)+"</div><div class=\\"text-xs text-emerald-600\\">Available</div></div><div class=\\"bg-blue-50 rounded-lg p-3\\"><div class=\\"text-lg font-bold text-blue-700 font-label-caps\\">"+(f.rented||0)+"</div><div class=\\"text-xs text-blue-600\\">Rented</div></div><div class=\\"bg-amber-50 rounded-lg p-3\\"><div class=\\"text-lg font-bold text-amber-700 font-label-caps\\">"+(f.other||0)+"</div><div class=\\"text-xs text-amber-600\\">Other</div></div></div>";const openTasks=(tasks.tasks||[]).filter(function(t){return t.status==="Open";});document.getElementById("pendingTasks").innerHTML=openTasks.length?openTasks.slice(0,5).map(function(t){return "<div class=\\"flex justify-between items-center py-2 border-b border-outline-variant last:border-0\\"><div><span class=\\"text-xs px-2 py-0.5 rounded-full font-status-badge "+(t.type.indexOf(\"Contract\")>=0?\"pill-maintenance\":\"pill-open\")+"\\">"+t.type+"</span></div><div class=\\"text-xs truncate max-w-[250px]\\">"+(t.description||"").split("\\n")[0].substring(0,80)+"</div><div class=\\"text-xs text-on-surface-variant\\">"+(t.date||"")+"</div></div>";}).join(""):"<div class=\\"text-sm\\">No pending tasks</div>";}catch(err){document.getElementById("stats").innerHTML="<span class=\\"text-error\\">Failed to load</span>";}}load();setInterval(load,30000);</script>', isBossRole(auth)));
});

app.get('/dashboard', (req, res) => {
  const token = req.query.token || '';
  res.redirect('/overview' + (token ? '?token=' + encodeURIComponent(token) : ''));
});

app.get('/motorbikes', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.redirect('/login');
  const token = req.query.token || '';
  res.send(dashboardShell(token, 'Motorbikes Inventory', '', '<main class="flex-1 md:ml-[280px] pb-24 md:pb-8"><header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0"><h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Motorbikes</h2><div class="flex items-center gap-3"><select id="statusFilter" class="text-sm border border-outline-variant rounded-lg px-3 py-1.5 bg-surface" onchange="render()"><option value="all">All Statuses</option><option value="Available">Available</option><option value="Rented">Rented</option><option value="Maintenance">Maintenance</option><option value="Reserved">Reserved</option></select></div></header><div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-4"><div class="flex justify-between items-center"><div id="bikeCount" class="text-sm text-on-surface-variant"></div></div><div id="grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"></div></div></main>' +
  '<div id="rentModal" class="fixed inset-0 bg-black/40 items-center justify-center z-50" style="display:none"><div class="bg-surface-container-lowest rounded-xl p-6 w-[300px]"><h3 class="font-headline-md text-headline-md mb-4">Mark Rented</h3><input id="rentName" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface" placeholder="Customer name"><input id="rentPhone" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface" placeholder="Phone (optional)"><label class="text-xs text-on-surface-variant">Expected return</label><input id="rentReturn" type="date" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface"><input id="rentPrice" type="number" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface" placeholder="Price (THB)"><label class="flex items-center gap-2 text-xs mb-2"><input type="checkbox" id="rentNPY" onchange="document.getElementById(\'rentPrice\').disabled=this.checked;"> Not paid yet (NPY)</label><div id="rentMsg" class="text-xs text-error mb-2"></div><div class="flex gap-2 justify-end"><button class="text-xs px-3 py-2 rounded-lg bg-surface-container-high" onclick="closeRentModal()">Cancel</button><button class="text-xs px-3 py-2 rounded-lg bg-primary text-on-primary" onclick="confirmRent()">Confirm</button></div></div></div>' +
  '<div id="returnModal" class="fixed inset-0 bg-black/40 items-center justify-center z-50" style="display:none"><div class="bg-surface-container-lowest rounded-xl p-6 w-[300px]"><h3 class="font-headline-md text-headline-md mb-4">Mark Returned</h3><input id="returnPrice" type="number" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface" placeholder="Final price (THB, optional)"><div id="returnMsg" class="text-xs text-error mb-2"></div><div class="flex gap-2 justify-end"><button class="text-xs px-3 py-2 rounded-lg bg-surface-container-high" onclick="closeReturnModal()">Cancel</button><button class="text-xs px-3 py-2 rounded-lg bg-primary text-on-primary" onclick="confirmReturn()">Confirm</button></div></div></div>' +
  '<script>var TOKEN=' + JSON.stringify(token) + ';var allBikes=[];var pill={Available:"pill-available",Rented:"pill-rented",Maintenance:"pill-maintenance",Reserved:"pill-reserved"};' +
  'function qs(p){return "/api/toh/"+p+(TOKEN?(p.indexOf("?")>=0?"&":"?")+"token="+encodeURIComponent(TOKEN):"");}' +
  'async function load(){try{var res=await fetch(qs("motorbikes"));var data=await res.json();if(data.error){document.getElementById("grid").innerHTML="<div class=\\"col-span-full text-error\\">"+data.error+"</div>";return;}allBikes=data.bikes||[];render();}catch(err){document.getElementById("grid").innerHTML="<div class=\\"col-span-full text-error\\">Failed to load</div>";}}' +
  'var rentTarget=null;function openRentModal(id){rentTarget=id;document.getElementById("rentName").value="";document.getElementById("rentPhone").value="";document.getElementById("rentReturn").value="";document.getElementById("rentPrice").value="";document.getElementById("rentPrice").disabled=false;document.getElementById("rentNPY").checked=false;document.getElementById("rentMsg").textContent="";document.getElementById("rentModal").style.display="flex";}' +
  'function closeRentModal(){document.getElementById("rentModal").style.display="none";}' +
  'async function confirmRent(){var name=document.getElementById("rentName").value.trim();if(!name){document.getElementById("rentMsg").textContent="Enter customer name";return;}var isNPY=document.getElementById("rentNPY").checked;var priceVal=document.getElementById("rentPrice").value;var body={status:"Rented",renterName:name,renterPhone:document.getElementById("rentPhone").value.trim(),expectedReturn:document.getElementById("rentReturn").value,price:priceVal,paymentStatus:isNPY?"npy":(priceVal?"paid":"unpaid")};var res=await fetch(qs("motorbikes/"+rentTarget+"/status"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});var data=await res.json();if(data.error||data.ok===false){document.getElementById("rentMsg").textContent=data.error||data.message||"Failed";return;}closeRentModal();load();}' +
  'var returnTarget=null;function openReturnModal(id){returnTarget=id;document.getElementById("returnPrice").value="";document.getElementById("returnMsg").textContent="";document.getElementById("returnModal").style.display="flex";}' +
  'function closeReturnModal(){document.getElementById("returnModal").style.display="none";}' +
  'async function confirmReturn(){var body={status:"Available",price:document.getElementById("returnPrice").value};var res=await fetch(qs("motorbikes/"+returnTarget+"/status"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});var data=await res.json();if(data.error||data.ok===false){document.getElementById("returnMsg").textContent=data.error||data.message||"Failed";return;}closeReturnModal();load();}' +
  'function render(){var f=document.getElementById("statusFilter").value;var bikes=f==="all"?allBikes:allBikes.filter(function(b){return b.status===f;});document.getElementById("bikeCount").textContent=bikes.length+" bike"+(bikes.length!==1?"s":"");document.getElementById("grid").innerHTML=bikes.map(function(b){var p=pill[b.status]||"pill-done";var actionBtn="";if(b.status==="Available"){actionBtn="<button onclick=\\"openRentModal(\'"+b.bikeId+"\')\\" class=\\"text-xs px-2 py-1 rounded-lg bg-primary text-on-primary w-full mt-2\\">Mark Rented</button>";}else if(b.status==="Rented"){actionBtn="<button onclick=\\"openReturnModal(\'"+b.bikeId+"\')\\" class=\\"text-xs px-2 py-1 rounded-lg bg-surface-container-high w-full mt-2\\">Mark Returned</button>";}return "<div onclick=\\"window.location=\'/bike-history/\'+encodeURIComponent(\'"+b.bikeId+"\')+(TOKEN?\'?token=\'+encodeURIComponent(TOKEN):\'\')\\" class=\\"bg-surface-container-lowest border border-outline-variant rounded-xl p-4 hover:shadow-sm transition-shadow cursor-pointer\\"><div class=\\"flex justify-between items-start mb-2\\"><div><div class=\\"font-label-caps text-lg text-primary\\">"+b.bikeId+"</div><div class=\\"text-sm font-semibold mt-0.5\\">"+b.model+"</div></div><span class=\\"text-xs px-2 py-1 rounded-full font-status-badge "+p+"\\">"+b.status+"</span></div><div class=\\"text-xs text-on-surface-variant space-y-1\\"><div class=\\"flex gap-4\\"><span>Location: "+(b.location||"Chaweng")+"</span>"+(b.color?"<span>Color: "+b.color+"</span>":"")+"</div>"+(b.notes?"<div class=\\"text-on-surface-variant italic opacity-60\\">"+b.notes+"</div>":"")+"</div>"+actionBtn+"</div>";}).join("");}load();setInterval(load,60000);</script>'
, isBossRole(auth)));
});

app.get('/bike-history/:bikeId', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.redirect('/login');
  const token = req.query.token || '';
  const bikeId = req.params.bikeId;
  const safeBikeId = String(bikeId).replace(/[<>]/g, '');
  res.send(dashboardShell(token, 'Motorbikes Inventory', '', '<main class="flex-1 md:ml-[280px] pb-24 md:pb-8"><header class="hidden md:flex items-center gap-3 w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0"><a href="/motorbikes?token=' + encodeURIComponent(token) + '" class="text-on-surface-variant hover:text-primary"><span class="material-symbols-outlined">arrow_back</span></a><h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Bike History</h2></header><div class="p-margin-mobile md:p-margin-desktop max-w-3xl mx-auto space-y-4"><div><h3 class="font-headline-md text-headline-md">' + safeBikeId + '</h3><div id="bikeCount" class="text-sm text-on-surface-variant mt-1"></div></div><div id="historyList" class="space-y-3"></div></div></main>' +
    '<script>var TOKEN=' + JSON.stringify(token) + ';var BIKE_ID=' + JSON.stringify(bikeId) + ';' +
    'function qs(p){return "/api/toh/"+p+(TOKEN?(p.indexOf("?")>=0?"&":"?")+"token="+encodeURIComponent(TOKEN):"");}' +
    'async function load(){try{var res=await fetch(qs("motorbikes/"+encodeURIComponent(BIKE_ID)+"/history"));var data=await res.json();var items=data.history||[];document.getElementById("bikeCount").textContent=items.length+" rental"+(items.length!==1?"s":"")+" recorded";if(!items.length){document.getElementById("historyList").innerHTML="<div class=\\"text-on-surface-variant text-sm text-center py-12\\">No rental history for this bike yet</div>";return;}document.getElementById("historyList").innerHTML=items.map(function(h){return "<div class=\\"bg-surface-container-lowest border border-outline-variant rounded-xl p-4\\"><div class=\\"font-semibold text-sm\\">"+(h.renter_name||"-")+"</div><div class=\\"text-xs text-on-surface-variant mt-1\\">"+(h.start_date||"")+" -&gt; "+(h.end_date||"")+(h.days?" &middot; "+h.days+" days":"")+"</div><div class=\\"text-sm font-semibold mt-2\\">"+(h.price?h.price+" THB":"-")+"</div>"+(h.logged_by?"<div class=\\"text-xs text-on-surface-variant mt-1\\">by "+h.logged_by+"</div>":"")+"</div>";}).join("");}catch(err){document.getElementById("historyList").innerHTML="<div class=\\"text-error\\">Failed to load</div>";}}' +
    'load();</script>', isBossRole(auth)));
});

app.get('/rentals', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.redirect('/login');
  const token = req.query.token || '';
  res.send(dashboardShell(token, 'Rentals', '', '<main class="flex-1 md:ml-[280px] pb-24 md:pb-8"><header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0"><h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Rentals</h2><div class="flex items-center gap-3"><select id="statusFilter" class="text-sm border border-outline-variant rounded-lg px-3 py-1.5 bg-surface" onchange="renderRentals()"><option value="all">All</option><option value="active" selected>Active</option><option value="done">Completed</option></select></div></header><div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-3"><div id="rentalList" class="space-y-3"></div></div></main><script>var TOKEN=' + JSON.stringify(token) + ';var allRentals=[];async function loadRentals(){try{var bRes=await fetch("/api/toh/motorbikes"+(TOKEN?"?token="+encodeURIComponent(TOKEN):""));var bikes=(await bRes.json()).bikes||[];allRentals=bikes.filter(function(b){return b.status==="Rented";}).map(function(b){return {plate:b.bikeId,model:b.model,renter:b.renterName||"-",status:"active",start:b.rentedDate,end:b.expectedReturn,loggedBy:b.loggedBy||""};});try{var hRes=await fetch("/api/toh/rental-history"+(TOKEN?"?token="+encodeURIComponent(TOKEN):""));var history=(await hRes.json()).history||[];history.forEach(function(h){allRentals.push({plate:h.bike_id,model:h.model||"-",renter:h.renter_name||"-",status:"done",start:h.start_date,end:h.end_date,days:h.days,price:h.price,loggedBy:h.logged_by||""});});}catch(e){}renderRentals();}catch(err){document.getElementById("rentalList").innerHTML="<div class=\\"text-error\\">Failed to load</div>";}}function renderRentals(){var f=document.getElementById("statusFilter").value;var items=f==="all"?allRentals:allRentals.filter(function(r){return r.status===f;});document.getElementById("rentalList").innerHTML=items.length?items.map(function(r){return "<div class=\\"bg-surface-container-lowest border border-outline-variant rounded-xl p-4 flex items-center gap-4\\"><div class=\\"font-label-caps text-primary font-bold min-w-[60px]\\">"+r.plate+"</div><div class=\\"flex-1\\"><div class=\\"font-semibold text-sm\\">"+r.renter+"</div><div class=\\"text-xs text-on-surface-variant\\">"+r.model+(r.start?" · "+r.start+" -> "+r.end:"")+(r.days?" · "+r.days+"d":"")+(r.loggedBy?" - by "+r.loggedBy:"")+"</div></div><div class=\\"text-right\\"><span class=\\"text-xs px-2 py-1 rounded-full font-status-badge "+(r.status==="active"?"pill-active":"pill-done")+"\\">"+(r.status==="active"?"Active":"Done")+"</span>"+(r.price?"<div class=\\"text-sm font-semibold mt-1 font-label-caps\\">"+r.price+" THB</div>":"")+"</div></div>";}).join(""):"<div class=\\"text-on-surface-variant text-sm text-center py-8\\">No rentals found</div>";}loadRentals();setInterval(loadRentals,60000);</script>', isBossRole(auth)));
});

app.get('/ai-tasks', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.redirect('/login');
  if (!isBossRole(auth)) return res.redirect('/motorbikes');
  const token = req.query.token || '';
  res.send(dashboardShell(token, 'AI Task Queue', '', '<main class="flex-1 md:ml-[280px] pb-24 md:pb-8"><header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0"><h2 class="font-headline-md text-headline-md text-on-surface font-semibold">AI Task Queue</h2><div id="taskCount" class="text-sm text-on-surface-variant"></div></header><div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-3"><div id="taskList" class="space-y-3"></div></div></main><script>var TOKEN=' + JSON.stringify(token) + ';async function loadTasks(){try{var res=await fetch("/api/toh/tasks"+(TOKEN?"?token="+encodeURIComponent(TOKEN):""));var data=await res.json();if(data.error){document.getElementById("taskList").innerHTML="<div class=\\"text-error\\">"+data.error+"</div>";return;}var tasks=data.tasks||[];var open=tasks.filter(function(t){return t.status==="Open";});document.getElementById("taskCount").textContent=open.length+" open · "+tasks.length+" total";document.getElementById("taskList").innerHTML=tasks.length?tasks.map(function(t){var isOpen=t.status==="Open";var descLines=(t.description||"-").split("\\n");return "<div class=\\"bg-surface-container-lowest border border-outline-variant rounded-xl p-4"+(!isOpen?" opacity-60":"")+"\\"><div class=\\"flex justify-between items-start mb-2\\"><div class=\\"flex items-center gap-2\\"><span class=\\"text-xs px-2 py-1 rounded-full font-status-badge "+(t.type.indexOf(\"Contract\")>=0?\"pill-maintenance\":\"pill-open\")+"\\">"+t.type+"</span><span class=\\"text-xs text-on-surface-variant\\">"+(t.date||"")+"</span></div><span class=\\"text-xs px-2 py-1 rounded-full font-status-badge "+(isOpen?\"pill-open\":\"pill-resolved\")+"\\">"+t.status+"</span></div><div class=\\"text-sm mb-2\\">"+descLines.map(function(l){return "<div>"+l+"</div>";}).join("")+"</div><div class=\\"text-xs text-on-surface-variant mb-3\\">Contact: "+(t.contact||"-")+"</div>"+(isOpen?"<div class=\\"flex gap-2\\"><button class=\\"text-xs px-4 py-2 bg-primary text-on-primary rounded-lg font-status-badge hover:opacity-90\\" onclick=\\"resolveTaskRow("+t.id+")\\">Mark Resolved</button></div>":"<div class=\\"text-xs text-on-surface-variant\\">Resolved: "+(t.resolvedAt||"-")+"</div>")+"</div>";}).join(""):"<div class=\\"text-on-surface-variant text-sm text-center py-12\\">No tasks yet</div>";}catch(err){document.getElementById("taskList").innerHTML="<div class=\\"text-error\\">Failed to load</div>";}}async function resolveTaskRow(id){try{await fetch("/api/toh/tasks/"+id+"/resolve"+(TOKEN?"?token="+encodeURIComponent(TOKEN):""),{method:"POST"});loadTasks();}catch(e){}}loadTasks();setInterval(loadTasks,30000);</script>', isBossRole(auth)));
});

app.get('/data-quality', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.redirect('/login');
  if (!isBossRole(auth)) return res.redirect('/motorbikes');
  const token = req.query.token || '';
  res.send(dashboardShell(token, 'Data Quality Report', '', '<main class="flex-1 md:ml-[280px] pb-24 md:pb-8"><header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0"><h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Data Quality</h2></header><div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6"><div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-6"><h3 class="font-headline-md text-headline-md mb-4">Booking Issues</h3><div id="summary" class="text-sm text-on-surface-variant mb-4"></div><div id="bookingIssues" class="space-y-3"></div></div><div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-6"><h3 class="font-headline-md text-headline-md mb-4">Fleet Issues</h3><div id="fleetIssues" class="space-y-3"></div></div></div></main><script>var TOKEN=' + JSON.stringify(token) + ';async function loadDQ(){try{var dqRes=await fetch("/api/toh/data-quality"+(TOKEN?"?token="+encodeURIComponent(TOKEN):""));var mbRes=await fetch("/api/toh/motorbikes"+(TOKEN?"?token="+encodeURIComponent(TOKEN):""));var dq=await dqRes.json(),mb=await mbRes.json();var issues=dq.issues||[];document.getElementById("summary").textContent=issues.length?issues.length+" of "+(dq.totalRows||0)+" booking rows flagged":"All booking rows look clean";document.getElementById("bookingIssues").innerHTML=issues.length?issues.map(function(r){return "<div class=\\"border border-outline-variant rounded-lg p-3\\"><div class=\\"flex justify-between items-start\\"><span class=\\"font-semibold text-sm\\">Row "+r.row+" — "+(r.name||"Unknown")+" · "+(r.bike||"-")+"</span><span class=\\"text-xs text-on-surface-variant\\">"+(r.date||"")+"</span></div><div class=\\"flex flex-wrap gap-1 mt-2\\">"+r.problems.map(function(p){return "<span class=\\"text-xs px-2 py-1 rounded-full pill-maintenance\\">"+p+"</span>";}).join("")+"</div></div>";}).join(""):"<div class=\\"text-sm text-on-surface-variant\\">No booking issues found</div>";var bikes=mb.bikes||[];var fleetProbs=bikes.filter(function(b){return !b.model||!b.location||(b.status==="Maintenance"&&!b.notes);});document.getElementById("fleetIssues").innerHTML=fleetProbs.length?fleetProbs.map(function(b){var probs=[];if(!b.model)probs.push("Missing model");if(!b.location)probs.push("Missing location");if(b.status==="Maintenance"&&!b.notes)probs.push("Maintenance without reason");return "<div class=\\"border border-outline-variant rounded-lg p-3\\"><div class=\\"flex justify-between items-start\\"><span class=\\"font-label-caps text-primary font-bold\\">"+b.bikeId+"</span><span class=\\"text-xs px-2 py-1 rounded-full font-status-badge pill-maintenance\\">"+b.status+"</span></div><div class=\\"flex flex-wrap gap-1 mt-2\\">"+probs.map(function(p){return "<span class=\\"text-xs px-2 py-1 rounded-full pill-open\\">"+p+"</span>";}).join("")+"</div></div>";}).join(""):"<div class=\\"text-sm text-on-surface-variant\\">All fleet records look complete</div>";}catch(err){document.getElementById("summary").textContent="Failed to load data";}}loadDQ();</script>', isBossRole(auth)));
});

app.get('/rental-history', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.redirect('/login');
  const token = req.query.token || '';
  res.send(dashboardShell(token, 'Rental History', '', '<main class="flex-1 md:ml-[280px] pb-24 md:pb-8"><header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0"><h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Rental History</h2><div class="flex items-center gap-3"><input id="searchInput" class="text-sm border border-outline-variant rounded-lg px-3 py-1.5 bg-surface w-[200px]" placeholder="Search plate or name..." oninput="renderHistory()"></div></header><div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-3"><div id="count" class="text-sm text-on-surface-variant"></div><div id="historyList" class="space-y-3"></div></div></main><script>var TOKEN=' + JSON.stringify(token) + ';var allHistory=[];async function loadHistory(){try{var res=await fetch("/api/toh/rental-history"+(TOKEN?"?token="+encodeURIComponent(TOKEN):""));var data=await res.json();if(data.error){document.getElementById("historyList").innerHTML="<div class=\\"text-error\\">"+data.error+"</div>";return;}allHistory=data.history||[];renderHistory();}catch(err){document.getElementById("historyList").innerHTML="<div class=\\"text-error\\">Failed to load</div>";}}function renderHistory(){var q=(document.getElementById("searchInput").value||"").toLowerCase();var items=q?allHistory.filter(function(h){return (h.bike_id||"").toLowerCase().indexOf(q)>=0||(h.renter_name||"").toLowerCase().indexOf(q)>=0;}):allHistory;document.getElementById("count").textContent=items.length+" rental"+(items.length!==1?"s":"")+" logged";document.getElementById("historyList").innerHTML=items.length?items.map(function(h){return "<div class=\\"bg-surface-container-lowest border border-outline-variant rounded-xl p-4 flex flex-wrap items-center gap-3\\"><div class=\\"font-label-caps text-primary font-bold min-w-[50px]\\">"+(h.bike_id||"-")+"</div><div class=\\"flex-1 min-w-0\\"><div class=\\"font-semibold text-sm\\">"+(h.renter_name||"-")+"</div><div class=\\"text-xs text-on-surface-variant\\">"+(h.start_date||"")+" -> "+(h.end_date||"")+(h.days?" · "+h.days+" days":"")+"</div></div><div class=\\"flex items-center gap-3 ml-auto\\"><div class=\\"text-sm font-semibold font-label-caps\\">"+(h.price?h.price+" THB":"-")+"</div><div class=\\"text-xs text-on-surface-variant\\">"+(h.date_logged||"")+(h.logged_by?"<div class=\\"text-xs text-on-surface-variant\\">by "+h.logged_by+"</div>":"")+"</div></div></div>";}).join(""):"<div class=\\"text-on-surface-variant text-sm text-center py-12\\">No rental history yet</div>";}loadHistory();setInterval(loadHistory,120000);</script>', isBossRole(auth)));
});

app.get('/staff', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) return res.redirect('/login');
  const token = req.query.token || '';
  const isBoss = isBossRole(auth);
  const adminControlsHTML = isBoss
    ? '<button id="adminToggle" class="text-xs px-3 py-2 rounded-lg font-status-badge bg-surface-container-high hover:opacity-80" onclick="toggleAdmin()">Admin mode: Off</button><button id="addBtn" class="text-xs px-3 py-2 rounded-lg font-status-badge bg-primary text-on-primary hover:opacity-90" style="display:none" onclick="openAddModal()">+ Add Staff</button>'
    : '';
  res.send(dashboardShell(token, 'Staff', '', '<main class="flex-1 md:ml-[280px] pb-24 md:pb-8"><header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0"><h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Staff</h2><div class="flex items-center gap-3"><span id="countBadge" class="text-sm text-on-surface-variant"></span>' + adminControlsHTML + '</div></header><div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6"><div><h3 class="font-headline-md text-headline-md mb-3">Boss</h3><div id="bossGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"></div></div><div><h3 class="font-headline-md text-headline-md mb-3">Staff</h3><div id="staffGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"></div></div></div></main>' +
  '<div id="addModal" class="fixed inset-0 bg-black/40 items-center justify-center z-50" style="display:none"><div class="bg-surface-container-lowest rounded-xl p-6 w-[300px]"><h3 class="font-headline-md text-headline-md mb-4">Add Staff</h3><input id="newName" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface" placeholder="Name"><input id="newPhone" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface" placeholder="Phone (with country code)"><select id="newRole" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface"><option value="staff">Staff</option><option value="boss">Boss</option></select><div class="flex gap-2 mb-3"><input id="newShiftStart" type="time" value="08:00" class="flex-1 border border-outline-variant rounded-lg px-2 py-2 text-sm bg-surface"><input id="newShiftEnd" type="time" value="18:00" class="flex-1 border border-outline-variant rounded-lg px-2 py-2 text-sm bg-surface"></div><div class="flex gap-2 justify-end"><button class="text-xs px-3 py-2 rounded-lg bg-surface-container-high" onclick="closeAddModal()">Cancel</button><button class="text-xs px-3 py-2 rounded-lg bg-primary text-on-primary" onclick="confirmAdd()">Add</button></div></div></div>' +
  '<div id="editModal" class="fixed inset-0 bg-black/40 items-center justify-center z-50" style="display:none"><div class="bg-surface-container-lowest rounded-xl p-6 w-[300px]"><h3 id="editTitle" class="font-headline-md text-headline-md mb-4">Edit</h3><label class="text-xs text-on-surface-variant">Shift start</label><input id="editStart" type="time" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface"><label class="text-xs text-on-surface-variant">Shift end</label><input id="editEnd" type="time" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface"><label class="text-xs text-on-surface-variant">Today hours</label><input id="editToday" type="number" step="0.1" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface"><label class="text-xs text-on-surface-variant">Week hours</label><input id="editWeek" type="number" step="0.1" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-3 text-sm bg-surface"><div class="flex gap-2 justify-end"><button class="text-xs px-3 py-2 rounded-lg bg-surface-container-high" onclick="closeEditModal()">Cancel</button><button class="text-xs px-3 py-2 rounded-lg bg-primary text-on-primary" onclick="confirmEdit()">Save</button></div></div></div>' +
  '<div id="loginModal" class="fixed inset-0 bg-black/40 items-center justify-center z-50" style="display:none"><div class="bg-surface-container-lowest rounded-xl p-6 w-[300px]"><h3 id="loginModalTitle" class="font-headline-md text-headline-md mb-4">Create Login</h3><input id="loginUsername" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface" placeholder="Username"><input id="loginPassword" type="password" class="w-full border border-outline-variant rounded-lg px-3 py-2 mb-2 text-sm bg-surface" placeholder="Password"><div id="loginModalMsg" class="text-xs text-error mb-2"></div><div class="flex gap-2 justify-end"><button class="text-xs px-3 py-2 rounded-lg bg-surface-container-high" onclick="closeLoginModal()">Cancel</button><button class="text-xs px-3 py-2 rounded-lg bg-primary text-on-primary" onclick="confirmCreateLogin()">Create</button></div></div></div>' +
  '<script>var TOKEN=' + JSON.stringify(token) + ';var adminMode=false;var allStaff=[];var editingId=null;' +
  'function qs(p){return "/api/toh/"+p+(TOKEN?(p.indexOf("?")>=0?"&":"?")+"token="+encodeURIComponent(TOKEN):"");}' +
  'function toggleAdmin(){adminMode=!adminMode;document.getElementById("adminToggle").textContent="Admin mode: "+(adminMode?"On":"Off");document.getElementById("addBtn").style.display=adminMode?"inline-block":"none";render();}' +
  'function openAddModal(){document.getElementById("addModal").style.display="flex";}' +
  'function closeAddModal(){document.getElementById("addModal").style.display="none";}' +
  'function openEditModal(id){editingId=id;var s=allStaff.find(function(x){return x.id==id;});document.getElementById("editTitle").textContent="Edit - "+s.name;document.getElementById("editStart").value=s.shift_start;document.getElementById("editEnd").value=s.shift_end;document.getElementById("editToday").value=s.today_hours;document.getElementById("editWeek").value=s.week_hours;document.getElementById("editModal").style.display="flex";}' +
  'function closeEditModal(){document.getElementById("editModal").style.display="none";}' +
  'var loginTargetId=null;function openLoginModal(id){loginTargetId=id;document.getElementById("loginUsername").value="";document.getElementById("loginPassword").value="";document.getElementById("loginModalMsg").textContent="";document.getElementById("loginModal").style.display="flex";}' +
  'function closeLoginModal(){document.getElementById("loginModal").style.display="none";}' +
  'async function confirmCreateLogin(){var u=document.getElementById("loginUsername").value.trim(),p=document.getElementById("loginPassword").value;if(!u||!p){document.getElementById("loginModalMsg").textContent="Enter username and password";return;}var res=await fetch(qs("staff/"+loginTargetId+"/create-login"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})});var data=await res.json();if(data.error){document.getElementById("loginModalMsg").textContent=data.error;return;}closeLoginModal();alert("Login created for username: "+u);}' +
  'async function confirmAdd(){var name=document.getElementById("newName").value.trim();if(!name)return;var body={name:name,phone:document.getElementById("newPhone").value.trim(),role:document.getElementById("newRole").value,shiftStart:document.getElementById("newShiftStart").value,shiftEnd:document.getElementById("newShiftEnd").value};await fetch(qs("staff"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});closeAddModal();document.getElementById("newName").value="";load();}' +
  'async function confirmEdit(){var shiftStart=document.getElementById("editStart").value,shiftEnd=document.getElementById("editEnd").value,todayHours=parseFloat(document.getElementById("editToday").value)||0,weekHours=parseFloat(document.getElementById("editWeek").value)||0;await fetch(qs("staff/"+editingId+"/shift"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({shiftStart:shiftStart,shiftEnd:shiftEnd})});await fetch(qs("staff/"+editingId+"/hours"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({todayHours:todayHours,weekHours:weekHours})});closeEditModal();load();}' +
  'async function removeStaffRow(id){if(!confirm("Remove this staff member?"))return;await fetch(qs("staff/"+id),{method:"DELETE"});load();}' +
  'async function checkIn(id){await fetch(qs("staff/"+id+"/checkin"),{method:"POST"});load();}' +
  'async function checkOut(id){await fetch(qs("staff/"+id+"/checkout"),{method:"POST"});load();}' +
  'async function setLeave(id){await fetch(qs("staff/"+id+"/leave"),{method:"POST"});load();}' +
  'function statusLabel(s){return s==="active"?"Active":s==="leave"?"Medical Leave":"Inactive";}' +
  'function statusPill(s){return s==="active"?"pill-available":s==="leave"?"pill-maintenance":"pill-done";}' +
  'function card(s){var isBoss=s.role==="boss";var late=s.check_in_at&&s.check_in_at>s.shift_start&&s.status==="active";var html="<div class=\\"bg-surface-container-lowest border border-outline-variant rounded-xl p-4 relative\\">";if(adminMode){html+="<button onclick=\\"removeStaffRow("+s.id+")\\" class=\\"absolute top-3 right-3 text-on-surface-variant hover:text-error\\">&times;</button>";}html+="<div class=\\"flex justify-between items-start mb-2\\"><div class=\\"font-semibold text-sm\\">"+s.name+"</div><span class=\\"text-xs px-2 py-1 rounded-full font-status-badge "+(isBoss?"pill-reserved":"pill-active")+"\\">"+s.role+"</span></div>";if(!isBoss){html+="<div class=\\"text-xs text-on-surface-variant font-label-caps mb-2\\">Shift "+s.shift_start+" - "+s.shift_end+(adminMode?" <button onclick=\\"openEditModal("+s.id+")\\" class=\\"text-primary\\">&#9998;</button>":"")+"</div>";html+="<div class=\\"text-xs text-on-surface-variant mb-1\\">Today: "+s.today_hours+"h &middot; Week: "+s.week_hours+"h</div>";}html+="<span class=\\"text-xs px-2 py-1 rounded-full font-status-badge "+statusPill(s.status)+"\\">"+statusLabel(s.status)+"</span>";if(late){html+="<div class=\\"text-xs text-error mt-1\\">Late check-in ("+s.check_in_at+")</div>";}if(!isBoss){html+="<div class=\\"flex gap-2 flex-wrap mt-3\\"><button onclick=\\"checkIn("+s.id+")\\" class=\\"text-xs px-2 py-1 rounded-lg bg-surface-container-high\\">Check In</button><button onclick=\\"checkOut("+s.id+")\\" class=\\"text-xs px-2 py-1 rounded-lg bg-surface-container-high\\">Check Out</button><button onclick=\\"setLeave("+s.id+")\\" class=\\"text-xs px-2 py-1 rounded-lg pill-maintenance\\">Leave</button></div>";}if(adminMode){html+="<div class=\\"mt-2\\"><button onclick=\\"openLoginModal("+s.id+")\\" class=\\"text-xs px-2 py-1 rounded-lg bg-primary text-on-primary w-full\\">Create Login</button></div>";}html+="</div>";return html;}' +
  'async function load(){try{var res=await fetch(qs("staff"));var data=await res.json();allStaff=data.staff||[];render();}catch(e){}}' +
  'function render(){var boss=allStaff.filter(function(s){return s.role==="boss";});var staff=allStaff.filter(function(s){return s.role==="staff";});document.getElementById("countBadge").textContent=allStaff.length+" total, "+staff.length+" staff, "+boss.length+" boss";document.getElementById("bossGrid").innerHTML=boss.map(card).join("")||"<div class=\\"text-sm text-on-surface-variant\\">No boss added</div>";document.getElementById("staffGrid").innerHTML=staff.map(card).join("")||"<div class=\\"text-sm text-on-surface-variant\\">No staff added</div>";}' +
  'load();setInterval(load,30000);</script>', isBossRole(auth)));
});

app.listen(3000, () => console.log('TOH Rental Bot running on port 3000'));
