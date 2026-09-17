const express = require('express');
const axios = require('axios');
const { extractContractData, shouldAutoFill, describeExtraction } = require('./contractExtractor');
const { getShop } = require('./config/shops');
const db = require('./database');
require('dotenv').config();
const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID;
// Comma-separated list of staff phone numbers (with country code, no +, e.g. "6695...,6681...") to broadcast notifications to.
const STAFF_NUMBERS = (process.env.STAFF_NUMBERS || '66950615202')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MY_NUMBER = process.env.MY_NUMBER;
// Optional: set DASHBOARD_TOKEN in Railway env vars to require ?token=... on /dashboard.
// Leave unset during testing; set it before sharing the URL anywhere.
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
// Optional second token for the boss (or anyone else) — same full access as
// DASHBOARD_TOKEN, but a distinct value so logs can show who did what.
const BOSS_TOKEN = process.env.BOSS_TOKEN || '';

// Checks the ?token= query param against every known valid token and
// returns which person it belongs to, so route handlers can both gate
// access and log a human-readable actor name for state-changing actions.
function checkDashboardAuth(req) {
  const token = req.query.token || '';
  if (!DASHBOARD_TOKEN) return { ok: true, user: 'Unknown (no token set)' };
  if (token === DASHBOARD_TOKEN) return { ok: true, user: 'Kris' };
  if (BOSS_TOKEN && token === BOSS_TOKEN) return { ok: true, user: 'TOH' };
  return { ok: false, user: null };
}

const conversations = {};
const processedMessages = new Set();

function clean(str) {
  if (!str) return '';
  return str.replace(/\*\*/g, '').replace(/\*/g, '').trim();
}

async function appendToSheet(data) {
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

// Stricter than parseThbAmount above: used by the Dashboard aggregation so
// messy AI-parsed rows (e.g. a full sentence in the Price column instead of
// a number) get SKIPPED from revenue totals rather than silently mis-parsed.
// Only accepts a plain number, optionally with commas/decimals and a
// trailing "THB" - anything else (extra words, placeholders) returns null.
function parseCleanPrice(str) {
  if (!str) return null;
  const trimmed = String(str).trim();
  const match = trimmed.match(/^([\d,]+(?:\.\d+)?)\s*(THB)?$/i);
  if (!match) return null;
  const num = parseFloat(match[1].replace(/,/g, ''));
  return isNaN(num) ? null : num;
}

async function logFinance(type, bike, amount, description, reportedBy) {
  try {
    db.logFinance(type, bike, amount, description, reportedBy);
    console.log(`${type} logged to database`);
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

// Returns every task row with its sheet row number as `id` (used to target
// the right row when resolving). Most recent first.
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

// Reads bookings and flags rows with messy price or placeholder-looking
// dates, for the /data-quality diagnostic report.
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
      const isCleanDate = (str) => /\\d/.test(str || '') && !str.includes('[') && !str.includes(']');
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
      msg += `${i+1}. ${row.bike_type || 'Unknown bike'}\n`;
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

// Parses a DD/MM/YYYY string (the en-GB format used everywhere in this file)
// and returns the whole-day difference between two such dates, or null if
// either can't be parsed.
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

// Returns every logged history entry for one specific bike, most recent first.
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

async function setBikeStatus(plateQuery, status, fleetSheetId, options = {}) {
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
    db.createRental({
      plate: bike.plate,
      customer_name: options.renterName || '',
      customer_phone: options.renterPhone || '',
      start_date: options.rentedDate || today,
      end_date: options.expectedReturn || '',
      price: parseFloat(options.price) || 0,
      logged_by: options.loggedBy || '',
    });
    return { ok: true, message: `${bike.plate} marked as Rented.` };
  }

  if (status === 'Available') {
    if (bike.status === 'Available' || bike.status === '') {
      return { ok: false, message: `${bike.plate} is already Available. No active rental to return.` };
    }
    const result = db.completeRental(bike.plate, options.price || '0', options.loggedBy || '');
    if (!result.ok) return result;
    return { ok: true, message: `${bike.plate} marked as Available (returned from ${result.customer}).` };
  }

  // Other status changes (Maintenance, Reserved) — just update
  const statusMap = { 'Maintenance': 'Maintenance', 'maintenance': 'Maintenance', 'Reserved': 'Reserved', 'reserved': 'Reserved' };
  const newStatus = statusMap[status] || status;
  db.updateBikeStatus(bike.plate, newStatus);
  return { ok: true, message: `${bike.plate} marked as ${newStatus}.` };
}

/**
 * Writes extracted contract data (Renter Name, Renter Phone, Rented Date,
 * Expected Return, Status) into the matching Fleet Tracker row.
 */
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
  db.createRental({
    plate: bike.plate,
    customer_name: extracted.renterName || '',
    customer_phone: extracted.renterPhone || '',
    start_date: extracted.rentedDate || '',
    end_date: extracted.expectedReturn || '',
    price: extracted.price || 0,
    logged_by: 'Contract OCR',
  });
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
  return bikes.map(b => ({
    bikeId: b.plate,
    model: b.model,
    color: b.color,
    location: b.location,
    renterName: '',
    renterPhone: '',
    rentedDate: '',
    expectedReturn: '',
    returnedDate: '',
    status: b.status,
    notes: b.notes,
  }));
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

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getNearestBikes(custLat, custLon) {
  try {
    const bikes = db.getAllMotorbikes().filter(b => b.status === 'Available');
    if (bikes.length === 0) return "No bikes available right now.";
    let msg = '*Nearest Available Bikes:*\n\n';
    bikes.slice(0, 8).forEach((b, i) => {
      msg += `${i+1}. ${b.plate} — ${b.model} (${b.color || 'N/A'})\n`;
      msg += `   Location: ${b.location || 'Chaweng'} — Status: ${b.status}\n\n`;
    });
    if (bikes.length > 8) msg += `...and ${bikes.length - 8} more available bikes.\n`;
    msg += 'Share your location pin (📎 → Location) for distance-sorted results.';
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
  await Promise.all(STAFF_NUMBERS.map(num =>
    axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: num,
        type: 'image',
        image: { id: mediaId, caption },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    ).catch(err => console.error('Forward image error:', err.message))
  ));
}

async function handleIncomingPhoto(from, mediaId) {
  try {
    const metaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mimeType = metaRes.data.mime_type || 'image/jpeg';
    const mediaUrl = metaRes.data.url;

    try { await forwardImageToStaff(mediaId, `📄 Photo from +${from}`); } catch (fwdErr) { console.error('Forward step failed:', fwdErr.message); }
    try { await logPhotoReceived(from, mediaId, mimeType); } catch (logErr) { console.error('Log photo step failed:', logErr.message); }

    try {
      const extracted = await extractContractData(mediaUrl, `Bearer ${WHATSAPP_TOKEN}`);
      if (shouldAutoFill(extracted)) {
        const result = await autoFillContractToFleet(extracted);
        if (result.ok) {
          await notifyStaff(`✅ Auto-filled fleet from contract photo (+${from}):\n${result.message}`);
        } else {
          await notifyStaff(`⚠️ Contract read OK but couldn't auto-fill (+${from}):\n${result.message}\nPlease enter manually.`);
          await logTask('Contract Auto-fill Failed', result.message + '\n' + describeExtraction(extracted), `+${from}`);
        }
      } else {
        const taskDesc = describeExtraction(extracted);
        await notifyStaff(`⚠️ Contract photo from +${from} needs manual entry.\n${taskDesc}\nPlease check the photo above and use "rent <plate>".`);
        await logTask('Contract Needs Manual Entry', taskDesc, `+${from}`);
      }
    } catch (extractErr) {
      console.error('Contract extraction error:', extractErr.message);
      await notifyStaff(`⚠️ Couldn't auto-read contract photo from +${from} — please enter manually.`);
      await logTask('Contract Read Error', extractErr.message, `+${from}`);
    }

    await sendWhatsApp(from, 'Got it, sent to our team ✅');
  } catch (err) {
    console.error('Photo handling error:', err.message);
    await sendWhatsApp(from, "Sorry, I couldn't process that photo — please try sending it again.");
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
          if (cmd === 'list today') { const list = await getTodayBookings(); await sendWhatsApp(from, list); return res.sendStatus(200); }
          if (cmd === 'fleet') { const byType = await getFleetAvailability(); await sendWhatsApp(from, `*Fleet Availability:*\n\n${formatFleetSummary(byType)}`); return res.sendStatus(200); }
          const rentMatch = text.match(/^rent\s+(.+)$/i);
          if (rentMatch) { const result = await setBikeStatus(rentMatch[1], 'Rented'); await sendWhatsApp(from, result.message); return res.sendStatus(200); }
          const returnMatch = text.match(/^return\s+(\S+)(?:\s+(\d+(?:\.\d+)?))?\s*$/i);
          if (returnMatch) {
            const [, plate, priceStr] = returnMatch;
            const result = await setBikeStatus(plate, 'Available', '', { price: priceStr || '', loggedBy: `WhatsApp Staff +${from}` });
            await sendWhatsApp(from, result.message); return res.sendStatus(200);
          }
          const expenseMatch = text.match(/^expense\s+(\S+)\s+(\d+(?:\.\d+)?)\s*(.*)$/i);
          if (expenseMatch) {
            const [, bike, amountStr, description] = expenseMatch;
            await logFinance('Expense', bike, parseFloat(amountStr), description || 'No description', `+${from}`);
            await sendWhatsApp(from, `Logged: ${amountStr} THB expense for ${bike}${description ? ' — ' + description : ''}`);
            return res.sendStatus(200);
          }
          if (cmd === 'finance' || cmd === 'income') {
            const summary = await getFinanceSummary();
            if (!summary) { await sendWhatsApp(from, "Couldn't load finance data right now."); }
            else {
              await sendWhatsApp(from, `*Finance Summary:*\n\nTotal Income: ${summary.income.toLocaleString()} THB\nTotal Expenses: ${summary.expense.toLocaleString()} THB\nNet: ${summary.net.toLocaleString()} THB\n(${summary.count} entries)`);
            }
            return res.sendStatus(200);
          }
          if (cmd === 'help' || cmd === 'commands') {
            await sendWhatsApp(from, "Staff commands:\n- fleet: full bike availability\n- list today: today's bookings\n- rent <plate>: mark a bike as rented (e.g. rent 3990)\n- return <plate> [price]: mark a bike as available, optionally logging the price paid (e.g. return 3990 1200)\n- expense <plate> <amount> <description>: log an expense (e.g. expense 3990 500 broken mirror)\n- finance: income/expense/profit summary");
            return res.sendStatus(200);
          }
          await sendWhatsApp(from, "Didn't recognize that as a command. Text 'help' to see what I can do.");
          return res.sendStatus(200);
        }
        await handleMessage(from, text);
      } else if (message.type === 'location') {
        const { latitude, longitude } = message.location;
        console.log(`Location from ${from}: ${latitude}, ${longitude}`);
        const nearby = await getNearestBikes(latitude, longitude);
        await sendWhatsApp(from, nearby);
      } else if (message.type === 'image') {
        const mediaId = message.image.id;
        console.log(`Image from ${from}: media ${mediaId}`);
        await handleIncomingPhoto(from, mediaId);
      } else {
        await sendWhatsApp(from, 'Sorry, I can only read text messages, photos, or shared locations. Please type your question, send a photo, or share your location (tap 📎 attach → Location) so I can tell you the nearest available bikes.');
      }
    }
  }
  res.sendStatus(200);
});

// Asks Gemini to extract booking fields from the confirmed booking summary
// text as structured JSON (constrained by responseSchema) instead of relying
// on regex against freeform text.
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
  const prompt = `Extract the booking details from this confirmed booking summary into the given JSON schema. The "price" field must be ONLY the total number in THB (no currency symbol, no words, no per-day rate) - e.g. if the summary says "Price: 3750 THB", price should be 3750. If a field is genuinely missing from the summary, use an empty string for text fields or 0 for price. Do not invent details that aren't in the summary.\n\nBooking summary:\n${summaryText}`;

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
      },
    }
  );
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
If a bike type shows 0 available, tell the customer it's fully booked right now and suggest a similar available alternative. Match the customer's wording to the closest bike type in this list (e.g. "Click" or "click 125" means "Honda Click 125"). Never say a bike is available if its available count is 0.

If a customer asks how far a bike is, where the nearest bike is, or anything about distance/location, ask them to share their location using WhatsApp's location-sharing feature (tap the attach/paperclip icon and choose Location). Do not guess distances yourself — the system will handle it once they share their pin.

ABOUT TOH:
- Located in Chaweng, Koh Samui (Chaweng Yai Soi 4 Bo Put, Surat Thani 84320)
- Over 5 years experience, fleet of 100+ well-maintained bikes
- Only Honda and Yamaha bikes
- Open 7 days a week
- Phone: +66 622 531 159

OUR BIKES AND PRICES (THB per day — rate depends on rental length):
- Honda Scoopy 110cc (2022-2025): 300 THB/day for 1-2 days, 250 THB/day for 3+ days - Cheapest option
- Honda Click 125cc (2022-2026): 300 THB/day for 1-2 days, 250 THB/day for 3+ days - Popular
- Honda Click 150cc (2022-2025): 300 THB/day for 1-2 days, 250 THB/day for 3+ days
- Yamaha Filano 125cc (2022-2025): 300 THB/day for 1-2 days, 250 THB/day for 3+ days
- Honda Click 160cc (2022-2025): 400 THB/day for 1-2 days, 350 THB/day for 3+ days - Popular
- Yamaha Aerox 155cc (2020-2022): 350 THB/day for 1-2 days, 300 THB/day for 3+ days
- Yamaha Nmax 155cc (2021-2026): 450 THB/day for 1-2 days, 400 THB/day for 3+ days
- Honda ADV 160cc (2024-2026): 450 THB/day for 1-2 days, 400 THB/day for 3+ days - Best Value
- Honda PCX 160cc (2022-2025): 450 THB/day for 1-2 days, 400 THB/day for 3+ days
- Yamaha Xmax 300cc (2022-2025): 850 THB/day for 1-2 days, 800 THB/day for 3+ days
- Honda ADV 350cc (2022-2025): 900 THB/day for 1-2 days, 850 THB/day for 3+ days
- Honda XADV 750cc (2025): 2500 THB/day for 1-2 days, 2000 THB/day for 3+ days
- Honda Forza: 750 THB/day (single rate, not listed on official site — confirm with staff for exact terms)

PRICING RULE: If the rental is 1 or 2 days, use the "1-2 days" rate × number of days. If the rental is 3 or more days, use the "3+ days" rate × number of days. Always apply the correct per-day rate for the actual length being booked — never default to one rate regardless of duration.
If a customer asks about a bike not in this price list (e.g. Honda PCX with unconfirmed cc), do NOT make up a price. Tell them you'll need to check with staff for that model's price and offer to connect them.

DELIVERY & PICKUP ZONES:
- In-zone (normal booking, no extra steps, no fee — delivery is always free): Chaweng, Chaweng Noi, Bo Put, Choeng Mon, Maenam, Bang Rak, Central Samui, Lamai
- Out-of-zone (do NOT confirm booking yourself — tell the customer their location is outside our normal delivery range and a staff member will confirm if it's possible, then flag for human help): Nathon, Taling Ngam, Lipa Noi, Baan Tai
- If the customer names a pickup location not in either list, do not guess which zone it's in — ask them to confirm it's within our normal area, or say a staff member will confirm if unsure.
- Never finalize a booking (never say "BOOKING_COMPLETE") for an out-of-zone or unrecognized location without staff confirmation first.

INCLUDED: Helmet provided, optional comprehensive insurance available. No hidden fees. Delivery is always free within our zone.

BOOKING: Collect full name, phone number, bike type, rental start date, rental end date, pickup location.
- Today's date is ${todayStr} in Koh Samui (Thailand, GMT+7). Use this exact date for all "today", "tomorrow", and "X days from today" calculations.
- If customer says "today", use today as start date automatically.
- If customer says "X days from today" or "X days starting today", calculate the end date automatically. Example: "5 days from today" = start today, end = today + 5 days.
- If customer says "1 week", that means 7 days. Calculate end date automatically.
- NEVER ask for start or end date again if the customer already gave you enough info to calculate them.
- When summarizing booking details, do NOT use markdown formatting like ** or *. Use plain text only.
- Price must be the TOTAL cost for the full rental period (daily rate × number of days), not just the per-day rate. Show the calculation briefly if helpful, but the "Price" field itself must be the final total number in THB.
Once you have all details say exactly: "BOOKING_COMPLETE" followed by a plain text summary with each field on its own line like:
Full Name: ...
Phone Number: ...
Bike Type: ...
Start Date: ...
End Date: ...
Pickup Location: ...
Price: ... (total THB for the full rental, e.g. "1250 THB")
If customer needs human help say exactly: "NEED_HUMAN_HELP".
Be friendly, helpful and concise. Answer in the same language the customer writes in.`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: conv.history
      }
    );
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
      await appendToSheet(bookingData);
      const totalAmount = parseThbAmount(bookingData.price);
      if (totalAmount > 0) {
        await logFinance('Income', bookingData.bike, totalAmount, `Booking - ${bookingData.name || 'customer'}`, 'WhatsApp Bot');
      }
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
        text: { body: message }
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

async function getRecentBookings(limit = 10) {
  try {
    return db.getRecentBookings(limit);
  } catch (err) {
    console.error('Recent bookings error:', err.message);
    return [];
  }
}

async function getRecentPhotos(limit = 10) {
  try {
    return db.getRecentPhotos(limit);
  } catch (err) {
    console.error('Recent photos error:', err.message);
    return [];
  }
}

async function getDashboardStats(shop) {
  try {
    const stats = db.getDashboardStats();
    const bikes = db.getAllMotorbikes();
    return {
      fleet: {
        total: bikes.length,
        available: bikes.filter(b => b.status === 'Available').length,
        rented: bikes.filter(b => b.status === 'Rented').length,
        other: bikes.filter(b => b.status === 'Maintenance' || b.status === 'Reserved').length,
      },
      bookings: {
        totalCount: stats.todayBookings,
        cleanBookingCount: stats.todayBookings,
        skippedBookingCount: 0,
        totalRevenue: stats.finance.income,
      },
      recentBookings: db.getRecentBookings(5),
      activeRentals: stats.activeRentals,
      openTasks: stats.openTasks,
    };
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    return {
      fleet: { total: 0, available: 0, rented: 0, other: 0 },
      bookings: { totalCount: 0, cleanBookingCount: 0, skippedBookingCount: 0, totalRevenue: 0 },
      recentBookings: [],
      activeRentals: 0,
      openTasks: 0,
    };
  }
}

app.get('/api/dashboard-data', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const [bookings, photos, fleet, finance] = await Promise.all([
      getRecentBookings(10).catch(() => []),
      getRecentPhotos(10).catch(() => []),
      getFleetAvailability().catch(() => ({})),
      getFinanceSummary().catch(() => null),
    ]);
    res.json({ bookings, photos, fleet, finance, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Dashboard data error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

app.get('/api/:shopId/motorbikes', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const shop = getShop(req.params.shopId);
    const bikes = await getFleetList();
    res.json({ shop: shop.name, bikes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Motorbikes API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/:shopId/motorbikes/:bikeId/status', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const shop = getShop(req.params.shopId);
    const { status, price, renterName, renterPhone, rentedDate, expectedReturn } = req.body || {};
    if (!['Rented', 'Available'].includes(status)) {
      return res.status(400).json({ error: 'status must be "Rented" or "Available"' });
    }
    const result = await setBikeStatus(req.params.bikeId, status, '', {
      price: price || '',
      loggedBy: auth.user,
      renterName: renterName || '',
      renterPhone: renterPhone || '',
      rentedDate: rentedDate || '',
      expectedReturn: expectedReturn || '',
    });
    if (result.ok) {
      console.log(`${auth.user} marked ${req.params.bikeId} as ${status} via Operations OS`);
    }
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    console.error('Update bike status error:', err.message);
    const httpStatus = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(httpStatus).json({ error: err.message });
  }
});

app.get('/api/:shopId/motorbikes/:bikeId/history', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const shop = getShop(req.params.shopId);
    const bikes = await getFleetList();
    const bike = bikes.find(b => b.bikeId === req.params.bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found' });
    const history = await getRentalHistoryForBike(req.params.bikeId);
    res.json({ bike, history, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Bike history API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/:shopId/rentals', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const shop = getShop(req.params.shopId);
    const bookings = await getRecentBookings(50);
    res.json({ shop: shop.name, bookings, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Rentals API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/:shopId/dashboard', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const shop = getShop(req.params.shopId);
    const stats = await getDashboardStats(shop);
    res.json({ shop: shop.name, ...stats, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Dashboard API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/:shopId/tasks', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const shop = getShop(req.params.shopId);
    const tasks = await getTasks();
    res.json({ shop: shop.name, tasks, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Tasks API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/:shopId/tasks/:taskId/resolve', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const shop = getShop(req.params.shopId);
    const taskId = parseInt(req.params.taskId, 10);
    if (!taskId || taskId < 1) { return res.status(400).json({ error: 'Invalid task id' }); }
    const result = await resolveTask(taskId);
    console.log(`${auth.user} marked task ${taskId} as Resolved`);
    res.json(result);
  } catch (err) {
    console.error('Resolve task error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/:shopId/data-quality', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const shop = getShop(req.params.shopId);
    const report = await getBookingsWithIssues();
    res.json({ shop: shop.name, ...report, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Data quality API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/:shopId/rental-history', async (req, res) => {
  try {
    const auth = checkDashboardAuth(req);
    if (!auth.ok) { return res.status(401).json({ error: 'Unauthorized' }); }
    const shop = getShop(req.params.shopId);
    const history = await getAllRentalHistory();
    res.json({ shop: shop.name, history, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Rental history API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/overview', (req, res) => {
  const auth = checkDashboardAuth(req);
  if (!auth.ok) { return res.status(401).send('Unauthorized. Add ?token=YOUR_TOKEN to the URL.'); }
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html><html class="light" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1.0" name="viewport">
<title>Overview - TOH Rental</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com" rel="preconnect">
<link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
<script id="tailwind-config">
  tailwind.config = {
    darkMode: "class",
    theme: { extend: {
      "colors": {
        "outline-variant": "#c1c6d7", "background": "#faf8ff", "surface-container": "#eaedff",
        "primary-container": "#0070eb", "surface-bright": "#faf8ff", "on-surface-variant": "#414755",
        "surface-container-low": "#f2f3ff", "on-background": "#131b2e", "surface-container-lowest": "#ffffff",
        "outline": "#717786", "secondary-container": "#d5e3fd", "on-surface": "#131b2e",
        "surface": "#faf8ff", "surface-tint": "#005bc1", "secondary": "#515f74",
        "surface-container-high": "#e2e7ff", "surface-container-highest": "#dae2fd",
        "primary": "#0058bc", "on-primary": "#ffffff", "on-primary-container": "#fefcff",
        "on-secondary-container": "#57657b", "error": "#ba1a1a"
      },
      "borderRadius": { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" },
      "spacing": { "gutter": "16px", "md": "16px", "xs": "8px", "base": "4px", "margin-mobile": "16px", "margin-desktop": "32px", "sm": "12px", "xl": "32px", "lg": "24px" },
      "fontFamily": { "status-badge": ["Inter"], "headline-md": ["Inter"], "body-md": ["Inter"], "body-lg": ["Inter"], "label-caps": ["JetBrains Mono"], "headline-lg": ["Inter"] },
      "fontSize": {
        "status-badge": ["12px", { "lineHeight": "12px", "fontWeight": "700" }],
        "headline-md": ["20px", { "lineHeight": "28px", "fontWeight": "600" }],
        "body-md": ["14px", { "lineHeight": "20px", "fontWeight": "400" }],
        "label-caps": ["12px", { "lineHeight": "16px", "letterSpacing": "0.05em", "fontWeight": "600" }],
        "headline-lg": ["24px", { "lineHeight": "32px", "fontWeight": "600" }]
      }
    } }
  }
</script>
<style>
  .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
  .no-scrollbar::-webkit-scrollbar { display: none; }
  .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  body { min-height: max(884px, 100dvh); }
</style>
</head>
<body class="bg-surface text-on-surface font-body-md min-h-screen flex flex-col md:flex-row">
<header class="flex justify-between items-center w-full px-margin-mobile h-16 z-50 bg-surface border-b border-outline-variant md:hidden sticky top-0">
<h1 class="font-headline-lg text-headline-lg font-bold text-primary tracking-tight">TOH Rental</h1>
</header>
<aside class="hidden md:flex flex-col h-full py-lg gap-xs bg-surface border-r border-outline-variant fixed left-0 top-0 w-[280px] z-40 overflow-y-auto no-scrollbar">
<div class="px-4 mb-6">
<h1 class="font-headline-md text-headline-md text-primary mb-6">TOH Rental</h1>
</div>
<nav class="flex flex-col gap-2">
<a class="flex items-center gap-4 bg-secondary-container text-on-secondary-container rounded-lg px-4 py-3 mx-2" href="#">
<span class="material-symbols-outlined">dashboard</span>
<span class="font-label-caps text-label-caps">Overview</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/motorbikes?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">two_wheeler</span>
<span class="font-label-caps text-label-caps">Motorbikes</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/rentals?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">receipt_long</span>
<span class="font-label-caps text-label-caps">Rentals</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/ai-tasks?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">smart_toy</span>
<span class="font-label-caps text-label-caps">AI Tasks</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/data-quality?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">verified</span>
<span class="font-label-caps text-label-caps">Data Quality</span>
</a>
<a class="flex items-center gap-4 text-on-surface-variant px-4 py-3 mx-2 hover:bg-surface-container-high transition-colors rounded-lg" href="/rental-history?token=${encodeURIComponent(token)}">
<span class="material-symbols-outlined">history</span>
<span class="font-label-caps text-label-caps">Rental History</span>
</a>
</nav>
</aside>
<main class="flex-1 md:ml-[280px] pb-24 md:pb-8">
<header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0">
<h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Overview</h2>
</header>
<div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6">
<div class="grid grid-cols-2 md:grid-cols-4 gap-4" id="stats"></div>
<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
<div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-6">
<h3 class="font-headline-md text-headline-md mb-4">Recent Rentals</h3>
<div id="recentBookings" class="text-on-surface-variant text-sm space-y-3"></div>
</div>
<div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-6">
<h3 class="font-headline-md text-headline-md mb-4">Fleet Status</h3>
<div id="fleetStatus" class="space-y-3"></div>
</div>
</div>
</div>
</main>
<script>
  const TOKEN = ${JSON.stringify(token)};
  async function load() {
    try {
      const res = await fetch('/api/toh/dashboard' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const d = await res.json();
      if (d.error) { document.getElementById('stats').innerHTML = '<span class="text-error">' + d.error + '</span>'; return; }
      const f = d.fleet || {};
      document.getElementById('stats').innerHTML = [
        { label: 'Active Rentals', value: d.activeRentals || 0, color: 'bg-amber-500' },
        { label: 'Available', value: f.available || 0, color: 'bg-emerald-500' },
        { label: 'Rented', value: f.rented || 0, color: 'bg-blue-500' },
        { label: 'AI Tasks', value: d.openTasks || 0, color: 'bg-violet-500' },
      ].map(s => '<div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-4"><div class="text-2xl font-bold">' + s.value + '</div><div class="text-xs text-on-surface-variant mt-1">' + s.label + '</div></div>').join('');
      const rb = d.recentBookings || [];
      document.getElementById('recentBookings').innerHTML = rb.length ? rb.map(b => '<div class="flex justify-between items-center py-2 border-b border-outline-variant last:border-0"><div><span class="font-semibold">' + (b.customer_name || b.name || '-') + '</span><br><span class="text-xs">' + (b.bike_type || b.bike || '-') + '</span></div><div class="text-right text-xs"><div>' + (b.start_date || b.startDate || '') + ' - ' + (b.end_date || b.endDate || '') + '</div><div class="font-semibold mt-1">' + (b.price || '-') + '</div></div></div>').join('') : '<div class="text-sm">No recent bookings</div>';
      document.getElementById('fleetStatus').innerHTML = '<div class="flex items-center gap-2"><div class="w-full bg-outline-variant rounded-full h-2"><div class="bg-emerald-500 h-2 rounded-full" style="width:' + (f.total ? (f.available/f.total*100) : 0) + '%"></div></div><span class="text-xs whitespace-nowrap">' + (f.available || 0) + '/' + (f.total || 0) + ' avail</span></div><div class="flex justify-between text-xs text-on-surface-variant"><span>Rented: ' + (f.rented || 0) + '</span><span>Other: ' + (f.other || 0) + '</span></div>';
    } catch (err) { document.getElementById('stats').innerHTML = '<span class="text-error">Failed to load</span>'; }
  }
  load();
  setInterval(load, 30000);
</script>
</body></html>`);
});

app.listen(3000, () => console.log('TOH Rental Bot running on port 3000'));
