const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { extractContractData, shouldAutoFill } = require('./contractExtractor');
const { getShop } = require('./config/shops');
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
const SHEET_ID = process.env.SHEET_ID;
const FLEET_SHEET_ID = process.env.FLEET_SHEET_ID || '1XvSdL_oQvEZccji43kg-2C7BQgZLXi3Don2y-lZicuY';
const CONTRACTS_FOLDER_ID = process.env.CONTRACTS_FOLDER_ID || '1r3YhaWFQl7hk2Y5WJY6rdPt3cLlLGIQ_';
const MY_NUMBER = process.env.MY_NUMBER;
// Optional: set DASHBOARD_TOKEN in Railway env vars to require ?token=... on /dashboard.
// Leave unset during testing; set it before sharing the URL anywhere.
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

const conversations = {};
const processedMessages = new Set();

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
  ],
});

function clean(str) {
  if (!str) return '';
  return str.replace(/\*\*/g, '').replace(/\*/g, '').trim();
}

async function ensureHeader() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A1:I1',
    });
    const firstRow = res.data.values?.[0];
    if (!firstRow || firstRow[0] !== 'Date') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Sheet1!A1:I1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Date', 'Customer Name', 'Phone Number', 'Bike Type', 'Start Date', 'End Date', 'Pickup Location', 'Price', 'Source']]
        }
      });
    }
  } catch (err) {
    console.error('Header error:', err.message);
  }
}

async function appendToSheet(data) {
  try {
    await ensureHeader();
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:I',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          now,
          clean(data.name),
          clean(data.phone),
          clean(data.bike),
          clean(data.startDate),
          clean(data.endDate),
          clean(data.location),
          clean(data.price),
          'WhatsApp Bot'
        ]]
      }
    });
    console.log('Booking logged to Google Sheets');
  } catch (err) {
    console.error('Sheets error:', err.message);
  }
}

async function ensureFinanceHeader() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Finance!A1:F1',
    });
    const firstRow = res.data.values?.[0];
    if (!firstRow || firstRow[0] !== 'Date') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Finance!A1:F1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['Date', 'Type', 'Bike', 'Amount (THB)', 'Description', 'Reported By']]
        }
      });
    }
  } catch (err) {
    console.error('Finance header error:', err.message);
  }
}

function parseThbAmount(str) {
  if (!str) return 0;
  const match = String(str).replace(/,/g, '').match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

async function logFinance(type, bike, amount, description, reportedBy) {
  try {
    await ensureFinanceHeader();
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Finance!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[now, type, bike || '-', amount, description || '-', reportedBy || 'WhatsApp Bot']]
      }
    });
    console.log(`${type} logged to Finance sheet`);
  } catch (err) {
    console.error('Finance log error:', err.message);
  }
}

async function getFinanceSummary() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Finance!A2:F',
    });
    const rows = res.data.values || [];
    let income = 0, expense = 0;
    rows.forEach(row => {
      const type = (row[1] || '').trim().toLowerCase();
      const amount = parseFloat(row[3]) || 0;
      if (type === 'income') income += amount;
      else if (type === 'expense') expense += amount;
    });
    return { income, expense, net: income - expense, count: rows.length };
  } catch (err) {
    console.error('Finance summary error:', err.message);
    return null;
  }
}

async function getTodayBookings() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:I',
    });
    const rows = res.data.values || [];
    const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });
    const todayRows = rows.filter(row => row[0] && row[0].startsWith(today));
    if (todayRows.length === 0) return 'No bookings today yet.';
    let msg = `*Today Bookings (${today}):*\n\n`;
    todayRows.forEach((row, i) => {
      msg += `${i+1}. ${row[3] || 'Unknown bike'}\n`;
      msg += `   Name: ${row[1] || '-'}\n`;
      msg += `   Phone: ${row[2] || '-'}\n`;
      msg += `   Start: ${row[4] || '-'}\n`;
      msg += `   End: ${row[5] || '-'}\n`;
      msg += `   Location: ${row[6] || '-'}\n\n`;
    });
    return msg;
  } catch (err) {
    console.error('Sheets read error:', err.message);
    return 'Could not read bookings.';
  }
}

let fleetCache = { data: null, fetchedAt: 0 };
const FLEET_CACHE_TTL_MS = 60 * 1000; // 1 minute

async function findBikeRow(plateQuery) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: FLEET_SHEET_ID,
    range: 'A2:A',
  });
  const rows = res.data.values || [];
  const query = plateQuery.trim().toLowerCase();
  for (let i = 0; i < rows.length; i++) {
    const bikeId = (rows[i][0] || '').trim().toLowerCase();
    // Match if the plate/number appears as the last word of the Bike ID,
    // or the query matches the whole Bike ID (in case they type the full name).
    const lastWord = bikeId.split(' ').pop();
    if (lastWord === query || bikeId === query || bikeId.endsWith(' ' + query)) {
      return { rowNumber: i + 2, bikeId: rows[i][0] }; // +2: header row + 1-indexing
    }
  }
  return null;
}

async function setBikeStatus(plateQuery, status) {
  const match = await findBikeRow(plateQuery);
  if (!match) {
    return { ok: false, message: `Couldn't find a bike matching "${plateQuery}" in the fleet sheet.` };
  }
  const sheets = google.sheets({ version: 'v4', auth });
  const dateCol = status === 'Rented' ? 'G' : 'I'; // Rented Date or Returned Date
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok' });

  await sheets.spreadsheets.values.update({
    spreadsheetId: FLEET_SHEET_ID,
    range: `J${match.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[status]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: FLEET_SHEET_ID,
    range: `${dateCol}${match.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[today]] },
  });

  fleetCache = { data: null, fetchedAt: 0 }; // force refresh next lookup
  return { ok: true, message: `${match.bikeId} marked as ${status}.` };
}

/**
 * Writes extracted contract data (Renter Name, Renter Phone, Rented Date,
 * Expected Return, Status) into the matching Fleet Tracker row.
 * Fleet Tracker columns: A Bike ID, B Model, C Color, D Location,
 * E Renter Name, F Renter Phone, G Rented Date, H Expected Return,
 * I Returned Date, J Status, K Notes.
 */
async function autoFillContractToFleet(extracted) {
  const match = await findBikeRow(extracted.plate);
  if (!match) {
    return { ok: false, message: `Auto-fill skipped: no fleet row found for plate "${extracted.plate}".` };
  }
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.update({
    spreadsheetId: FLEET_SHEET_ID,
    range: `E${match.rowNumber}:H${match.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        extracted.renterName || '',
        extracted.renterPhone || '',
        extracted.rentedDate || '',
        extracted.expectedReturn || '',
      ]]
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: FLEET_SHEET_ID,
    range: `J${match.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [['Rented']] },
  });

  fleetCache = { data: null, fetchedAt: 0 }; // force refresh next lookup
  return { ok: true, message: `${match.bikeId} auto-filled from contract (${extracted.renterName}).` };
}

async function getFleetAvailability(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && fleetCache.data && (now - fleetCache.fetchedAt) < FLEET_CACHE_TTL_MS) {
    return fleetCache.data;
  }
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: FLEET_SHEET_ID,
      // Columns: Bike ID, Model, Color, Current Location, Status, Renter Name, Renter Phone, Rented Date, Expected Return, Returned Date, Notes
      range: 'A2:K',
    });
    const rows = res.data.values || [];
    const byType = {};
    rows.forEach(row => {
      const bikeId = (row[0] || '').trim();
      const model = (row[1] || '').trim();
      const color = (row[2] || '').trim();
      const status = (row[9] || '').trim().toLowerCase();
      if (!bikeId || !model) return;
      if (!byType[model]) byType[model] = { total: 0, available: 0, bikes: [] };
      byType[model].total += 1;
      const isAvailable = status === '' || status === 'available';
      if (isAvailable) byType[model].available += 1;
      byType[model].bikes.push({ bikeId, color, status: status || 'available' });
    });
    fleetCache = { data: byType, fetchedAt: now };
    return byType;
  } catch (err) {
    console.error('Fleet sheet error:', err.message);
    return fleetCache.data || {};
  }
}

// Returns every individual bike row from a fleet sheet (used by the
// multi-shop /api/:shopId/motorbikes endpoint below).
async function getFleetList(fleetSheetId) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: fleetSheetId,
    range: 'A2:K',
  });
  const rows = res.data.values || [];
  return rows
    .filter(row => row[0]) // has a Bike ID
    .map(row => ({
      bikeId: row[0] || '',
      model: row[1] || '',
      color: row[2] || '',
      location: row[3] || '',
      renterName: row[4] || '',
      renterPhone: row[5] || '',
      rentedDate: row[6] || '',
      expectedReturn: row[7] || '',
      returnedDate: row[8] || '',
      status: row[9] || 'Available',
      notes: row[10] || '',
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
  const R = 6371; // Earth radius km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getNearestBikes(custLat, custLon) {
  const byType = await getFleetAvailability();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: FLEET_SHEET_ID,
    range: 'A2:K',
  });
  const rows = res.data.values || [];
  const results = [];
  rows.forEach(row => {
    const bikeId = (row[0] || '').trim();
    const model = (row[1] || '').trim();
    const location = (row[3] || '').trim(); // "lat,lon"
    const status = (row[9] || '').trim().toLowerCase();
    if (!bikeId || !location) return;
    const isAvailable = status === '' || status === 'available';
    if (!isAvailable) return;
    const [latStr, lonStr] = location.split(',').map(s => s.trim());
    const lat = parseFloat(latStr);
    const lon = parseFloat(lonStr);
    if (isNaN(lat) || isNaN(lon)) return;
    const distKm = haversineKm(custLat, custLon, lat, lon);
    results.push({ bikeId, model, distKm });
  });
  results.sort((a, b) => a.distKm - b.distKm);
  if (results.length === 0) {
    return "I couldn't find bike location data yet — let me connect you with staff to check what's nearest.";
  }
  const top = results.slice(0, 5);
  let msg = '*Nearest available bikes to you:*\n\n';
  top.forEach(b => {
    msg += `- ${b.model} (${b.bikeId}): ${b.distKm.toFixed(1)} km away\n`;
  });
  return msg;
}

async function logPhotoReceived(from, mediaId, mimeType) {
  const sheets = google.sheets({ version: 'v4', auth });
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Photos!A:D',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[now, `+${from}`, mediaId, mimeType]]
    }
  });
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
    // Get mime type + media URL. mediaUrl is needed to feed the image to Gemini
    // for contract extraction; it requires the same Bearer auth header to fetch.
    const metaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mimeType = metaRes.data.mime_type || 'image/jpeg';
    const mediaUrl = metaRes.data.url;

    // Forward to staff and log the photo — each wrapped separately so a
    // failure in one (e.g. missing sheet tab) never blocks the rest.
    try {
      await forwardImageToStaff(mediaId, `📄 Photo from +${from}`);
    } catch (fwdErr) {
      console.error('Forward step failed:', fwdErr.message);
    }
    try {
      await logPhotoReceived(from, mediaId, mimeType);
    } catch (logErr) {
      console.error('Log photo step failed:', logErr.message);
    }

    // Attempt contract auto-extraction (best effort — never blocks the customer reply)
    let autoFillNote = '';
    try {
      const extracted = await extractContractData(mediaUrl, `Bearer ${WHATSAPP_TOKEN}`);
      if (shouldAutoFill(extracted)) {
        const result = await autoFillContractToFleet(extracted);
        if (result.ok) {
          await notifyStaff(`✅ Auto-filled fleet sheet from contract photo (+${from}):\n${result.message}`);
        } else {
          await notifyStaff(`⚠️ Contract read OK but couldn't auto-fill (+${from}):\n${result.message}\nPlease enter manually.`);
        }
      } else {
        await notifyStaff(`⚠️ Contract photo from +${from} needs manual entry (low confidence or missing plate/name). Please check the photo above and use "rent <plate>".`);
      }
    } catch (extractErr) {
      console.error('Contract extraction error:', extractErr.message);
      await notifyStaff(`⚠️ Couldn't auto-read contract photo from +${from} — please enter manually.`);
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
          const rentMatch = text.match(/^rent\s+(.+)$/i);
          if (rentMatch) {
            const result = await setBikeStatus(rentMatch[1], 'Rented');
            await sendWhatsApp(from, result.message);
            return res.sendStatus(200);
          }
          const returnMatch = text.match(/^return\s+(.+)$/i);
          if (returnMatch) {
            const result = await setBikeStatus(returnMatch[1], 'Available');
            await sendWhatsApp(from, result.message);
            return res.sendStatus(200);
          }
          // expense <plate> <amount> <description...>  e.g. "expense 3990 500 broken mirror"
          const expenseMatch = text.match(/^expense\s+(\S+)\s+(\d+(?:\.\d+)?)\s*(.*)$/i);
          if (expenseMatch) {
            const [, bike, amountStr, description] = expenseMatch;
            await logFinance('Expense', bike, parseFloat(amountStr), description || 'No description', `+${from}`);
            await sendWhatsApp(from, `Logged: ${amountStr} THB expense for ${bike}${description ? ' — ' + description : ''}`);
            return res.sendStatus(200);
          }
          if (cmd === 'finance' || cmd === 'income') {
            const summary = await getFinanceSummary();
            if (!summary) {
              await sendWhatsApp(from, "Couldn't load finance data right now.");
            } else {
              await sendWhatsApp(from, `*Finance Summary:*\n\nTotal Income: ${summary.income.toLocaleString()} THB\nTotal Expenses: ${summary.expense.toLocaleString()} THB\nNet: ${summary.net.toLocaleString()} THB\n(${summary.count} entries)`);
            }
            return res.sendStatus(200);
          }
          if (cmd === 'help' || cmd === 'commands') {
            await sendWhatsApp(from, "Staff commands:\n- fleet: full bike availability\n- list today: today's bookings\n- rent <plate>: mark a bike as rented (e.g. rent 3990)\n- return <plate>: mark a bike as available (e.g. return 3990)\n- expense <plate> <amount> <description>: log an expense (e.g. expense 3990 500 broken mirror)\n- finance: income/expense/profit summary");
            return res.sendStatus(200);
          }
          // Any other message from a staff number is treated as internal chat,
          // not a customer booking request — don't send it to the customer AI.
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

OUR BIKES AND PRICES (starting from per day):
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

      const bookingData = {
        name: cleanReply.match(/Full Name[:\s]+([^\n]+)/i)?.[1],
        phone: cleanReply.match(/Phone Number[:\s]+([^\n]+)/i)?.[1] || from,
        bike: cleanReply.match(/Bike Type[:\s]+([^\n]+)/i)?.[1],
        startDate: cleanReply.match(/Start Date[:\s]+([^\n]+)/i)?.[1],
        endDate: cleanReply.match(/End Date[:\s]+([^\n]+)/i)?.[1],
        location: cleanReply.match(/Pickup Location[:\s]+([^\n]+)/i)?.[1],
        price: cleanReply.match(/Price[:\s]+([^\n]+)/i)?.[1],
      };
      await appendToSheet(bookingData);
      const totalAmount = parseThbAmount(bookingData.price);
      if (totalAmount > 0) {
        await logFinance('Income', bookingData.bike, totalAmount, `Booking - ${bookingData.name || 'customer'}`, 'WhatsApp Bot');
      }
      console.log(`Booking completed for ${from}`);
    } else if (reply.includes('NEED_HUMAN_HELP')) {
      await sendWhatsApp(from, 'No problem! Our staff will contact you shortly.');
      await notifyStaff(`Customer +${from} needs human help!\nLast message: ${text}`);
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
  // Sends the same message individually to every number in STAFF_NUMBERS.
  // (WhatsApp's Business API doesn't support posting into group chats, so this
  // broadcasts to each staff member's own number instead.)
  await Promise.all(STAFF_NUMBERS.map(num => sendWhatsApp(num, message)));
}

async function getRecentBookings(limit = 10) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A2:I',
  });
  const rows = res.data.values || [];
  return rows.slice(-limit).reverse().map(row => ({
    date: row[0] || '',
    name: row[1] || '',
    phone: row[2] || '',
    bike: row[3] || '',
    startDate: row[4] || '',
    endDate: row[5] || '',
    location: row[6] || '',
    price: row[7] || '',
    source: row[8] || '',
  }));
}

async function getRecentPhotos(limit = 10) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Photos!A2:D',
  });
  const rows = res.data.values || [];
  return rows.slice(-limit).reverse().map(row => ({
    date: row[0] || '',
    from: row[1] || '',
    mediaId: row[2] || '',
    mimeType: row[3] || '',
  }));
}

app.get('/api/dashboard-data', async (req, res) => {
  try {
    if (DASHBOARD_TOKEN && req.query.token !== DASHBOARD_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const [bookings, photos, fleet, finance] = await Promise.all([
      getRecentBookings(10).catch(() => []),
      getRecentPhotos(10).catch(() => []),
      getFleetAvailability(true).catch(() => ({})),
      getFinanceSummary().catch(() => null),
    ]);
    res.json({ bookings, photos, fleet, finance, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Dashboard data error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// Multi-shop endpoint: returns the full individual-bike list for one shop's
// fleet sheet, looked up via config/shops.js. TOH is the "toh" shop for now;
// future shops get added to that config file with their own fleetSheetId.
app.get('/api/:shopId/motorbikes', async (req, res) => {
  try {
    if (DASHBOARD_TOKEN && req.query.token !== DASHBOARD_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const shop = getShop(req.params.shopId);
    const bikes = await getFleetList(shop.fleetSheetId);
    res.json({ shop: shop.name, bikes, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Motorbikes API error:', err.message);
    const status = err.message.startsWith('Unknown shop') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/dashboard', (req, res) => {
  if (DASHBOARD_TOKEN && req.query.token !== DASHBOARD_TOKEN) {
    return res.status(401).send('Unauthorized. Add ?token=YOUR_TOKEN to the URL.');
  }
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>TOH RentalBot Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, sans-serif; background:#0f0f10; color:#eee; margin:0; padding:20px; }
  h1 { font-size:20px; margin-bottom:4px; }
  .updated { color:#888; font-size:12px; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:20px; }
  @media (max-width:800px) { .grid { grid-template-columns: 1fr; } }
  .card { background:#1a1a1c; border-radius:10px; padding:16px; }
  .card h2 { font-size:15px; margin:0 0 10px; color:#ccc; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 4px; border-bottom:1px solid #2a2a2c; }
  th { color:#888; font-weight:500; }
  .stat { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #2a2a2c; font-size:14px; }
  .stat:last-child { border-bottom:none; }
  .empty { color:#666; font-size:13px; padding:8px 0; }
</style>
</head>
<body>
  <h1>TOH RentalBot Dashboard</h1>
  <div class="updated" id="updated">Loading...</div>
  <div class="grid">
    <div class="card"><h2>Recent bookings</h2><div id="bookings">Loading...</div></div>
    <div class="card"><h2>Recent contract photos</h2><div id="photos">Loading...</div></div>
    <div class="card"><h2>Fleet availability</h2><div id="fleet">Loading...</div></div>
    <div class="card"><h2>Finance summary</h2><div id="finance">Loading...</div></div>
  </div>
<script>
  const TOKEN = ${JSON.stringify(token)};
  async function load() {
    try {
      const res = await fetch('/api/dashboard-data' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const data = await res.json();
      if (data.error) { document.getElementById('updated').textContent = data.error; return; }
      document.getElementById('updated').textContent = 'Updated ' + new Date(data.updatedAt).toLocaleTimeString();

      document.getElementById('bookings').innerHTML = data.bookings.length ? '<table><tr><th>Name</th><th>Bike</th><th>Dates</th><th>Price</th></tr>' +
        data.bookings.map(b => \`<tr><td>\${b.name}</td><td>\${b.bike}</td><td>\${b.startDate} - \${b.endDate}</td><td>\${b.price}</td></tr>\`).join('') + '</table>'
        : '<div class="empty">No bookings yet</div>';

      document.getElementById('photos').innerHTML = data.photos.length ? '<table><tr><th>From</th><th>Time</th></tr>' +
        data.photos.map(p => \`<tr><td>+\${p.from}</td><td>\${p.date}</td></tr>\`).join('') + '</table>'
        : '<div class="empty">No photos yet</div>';

      const fleetRows = Object.entries(data.fleet).map(([type, v]) => \`<div class="stat"><span>\${type}</span><span>\${v.available}/\${v.total}</span></div>\`).join('');
      document.getElementById('fleet').innerHTML = fleetRows || '<div class="empty">No fleet data</div>';

      document.getElementById('finance').innerHTML = data.finance ?
        \`<div class="stat"><span>Income</span><span>\${data.finance.income.toLocaleString()} THB</span></div>
         <div class="stat"><span>Expenses</span><span>\${data.finance.expense.toLocaleString()} THB</span></div>
         <div class="stat"><span>Net</span><span>\${data.finance.net.toLocaleString()} THB</span></div>\`
        : '<div class="empty">No finance data</div>';
    } catch (err) {
      document.getElementById('updated').textContent = 'Error loading data';
    }
  }
  load();
  setInterval(load, 5000);
</script>
</body>
</html>`);
});

app.get('/motorbikes', (req, res) => {
  if (DASHBOARD_TOKEN && req.query.token !== DASHBOARD_TOKEN) {
    return res.status(401).send('Unauthorized. Add ?token=YOUR_TOKEN to the URL.');
  }
  const token = req.query.token || '';
  res.send(`<!DOCTYPE html><html class="light" lang="en"><head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1.0" name="viewport">
<title>Motorbikes Inventory - TOH Rental</title>
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
<span class="material-symbols-outlined">two_wheeler</span>
<span class="font-label-caps text-label-caps">Motorbikes</span>
</a>
</nav>
</aside>
<main class="flex-1 md:ml-[280px] pb-24 md:pb-8">
<header class="hidden md:flex justify-between items-center w-full px-margin-desktop h-16 z-30 bg-surface/80 backdrop-blur-md border-b border-outline-variant sticky top-0">
<h2 class="font-headline-md text-headline-md text-on-surface font-semibold">Motorbike Inventory</h2>
</header>
<div class="p-margin-mobile md:p-margin-desktop max-w-7xl mx-auto space-y-6">
<div class="flex flex-col md:flex-row gap-4 mb-6">
<div class="relative flex-1">
<span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span>
<input id="search-input" class="w-full pl-10 pr-4 py-3 bg-surface-container-lowest border border-outline-variant rounded-xl focus:outline-none focus:ring-2 focus:ring-primary font-body-md text-body-md" placeholder="Search by model, plate, or status..." type="text">
</div>
<div id="filter-bar" class="flex gap-2 overflow-x-auto no-scrollbar pb-2 md:pb-0">
<button data-filter="all" class="filter-btn whitespace-nowrap px-4 py-2 bg-primary text-on-primary rounded-full font-label-caps text-label-caps border border-primary">All</button>
<button data-filter="available" class="filter-btn whitespace-nowrap px-4 py-2 bg-surface-container-lowest text-on-surface rounded-full font-label-caps text-label-caps border border-outline-variant">Available</button>
<button data-filter="rented" class="filter-btn whitespace-nowrap px-4 py-2 bg-surface-container-lowest text-on-surface rounded-full font-label-caps text-label-caps border border-outline-variant">Rented</button>
</div>
</div>
<div id="bike-grid" class="grid grid-cols-1 xl:grid-cols-2 gap-4">
<div class="text-on-surface-variant">Loading fleet...</div>
</div>
</div>
</main>
<script>
  const TOKEN = ${JSON.stringify(token)};
  let ALL_BIKES = [];
  let activeFilter = 'all';

  function badgeClasses(status) {
    const s = (status || '').toLowerCase();
    if (s === 'rented') return 'bg-blue-100 text-blue-800 border-blue-200';
    if (s === 'maintenance') return 'bg-amber-100 text-amber-800 border-amber-200';
    return 'bg-green-100 text-green-800 border-green-200';
  }

  function bikeCard(b) {
    const badge = badgeClasses(b.status);
    const extra = (b.status || '').toLowerCase() === 'rented'
      ? \`<div class="mt-3 bg-surface-container-low p-2 rounded border border-outline-variant/50">
           <p class="font-body-md text-body-md"><span class="font-semibold">Renter:</span> \${b.renterName || '-'}</p>
           <p class="font-body-md text-body-md text-on-surface-variant mt-1">Expected return: \${b.expectedReturn || '-'}</p>
         </div>\`
      : '';
    return \`<article class="bg-surface-container-lowest border border-outline-variant rounded-xl p-4 flex flex-col gap-3 hover:shadow-md transition-shadow">
      <div class="flex justify-between items-start">
        <div>
          <h3 class="font-headline-md text-headline-md text-on-surface font-semibold">\${b.model || b.bikeId}</h3>
          <p class="font-label-caps text-label-caps text-on-surface-variant mt-1">\${b.bikeId}\${b.color ? ' • ' + b.color : ''}</p>
        </div>
        <div class="px-3 py-1 rounded-full font-status-badge text-status-badge uppercase border \${badge}">\${b.status || 'Available'}</div>
      </div>
      \${extra}
    </article>\`;
  }

  function renderBikes() {
    const grid = document.getElementById('bike-grid');
    const query = document.getElementById('search-input').value.trim().toLowerCase();
    let filtered = ALL_BIKES.filter(b => {
      const status = (b.status || 'available').toLowerCase();
      if (activeFilter === 'available' && status !== 'available' && status !== '') return false;
      if (activeFilter === 'rented' && status !== 'rented') return false;
      if (query) {
        const haystack = \`\${b.bikeId} \${b.model} \${b.status}\`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    grid.innerHTML = filtered.length
      ? filtered.map(bikeCard).join('')
      : '<div class="text-on-surface-variant">No bikes match.</div>';
  }

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.remove('bg-primary', 'text-on-primary', 'border-primary');
        b.classList.add('bg-surface-container-lowest', 'text-on-surface', 'border-outline-variant');
      });
      btn.classList.remove('bg-surface-container-lowest', 'text-on-surface', 'border-outline-variant');
      btn.classList.add('bg-primary', 'text-on-primary', 'border-primary');
      renderBikes();
    });
  });
  document.getElementById('search-input').addEventListener('input', renderBikes);

  async function loadBikes() {
    try {
      const res = await fetch('/api/toh/motorbikes' + (TOKEN ? '?token=' + encodeURIComponent(TOKEN) : ''));
      const data = await res.json();
      if (data.error) {
        document.getElementById('bike-grid').innerHTML = '<div class="text-error">' + data.error + '</div>';
        return;
      }
      ALL_BIKES = data.bikes;
      renderBikes();
    } catch (err) {
      document.getElementById('bike-grid').innerHTML = '<div class="text-error">Failed to load fleet data</div>';
    }
  }
  loadBikes();
</script>
</body></html>`);
});

app.listen(3000, () => console.log('TOH Rental Bot running on port 3000'));
