const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
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
    // Get mime type (needed for the log) without keeping the file bytes around —
    // Drive storage isn't available on this Google account (personal Gmail service
    // account storage-quota limitation), so photos are forwarded live to staff
    // instead of archived. WhatsApp keeps the media accessible via mediaId for ~30 days.
    const metaRes = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mimeType = metaRes.data.mime_type || 'image/jpeg';

    await forwardImageToStaff(mediaId, `📄 Photo from +${from}`);
    await logPhotoReceived(from, mediaId, mimeType);
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
          if (cmd === 'help' || cmd === 'commands') {
            await sendWhatsApp(from, 'Staff commands:\n- fleet: full bike availability\n- list today: today\'s bookings');
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
- Honda Scoopy 110cc (2022-2025): 250 THB/day - Cheapest option
- Honda Click 125cc (2022-2026): 250 THB/day - Popular
- Honda Click 150cc (2022-2025): 250 THB/day
- Yamaha Filano 125cc (2022-2025): 250 THB/day
- Honda Click 160cc (2022-2025): 350 THB/day - Popular
- Yamaha Aerox 155cc (2020-2022): 300 THB/day
- Yamaha Nmax 155cc (2021-2026): 400 THB/day
- Honda ADV 160cc (2024-2026): 400 THB/day - Best Value
- Honda PCX 160cc (2022-2025): 400 THB/day
- Yamaha Xmax 300cc (2022-2025): 800 THB/day
- Honda ADV 350cc (2022-2025): 850 THB/day
- Honda XADV 750cc (2025): 2000 THB/day
- Honda Forza: 750 THB/day

If a customer asks about a bike not in this price list (e.g. Honda PCX with unconfirmed cc), do NOT make up a price. Tell them you'll need to check with staff for that model's price and offer to connect them.

DELIVERY & PICKUP ZONES:
- In-zone (normal booking, no extra steps, no fee — delivery is always free): Chaweng, Chaweng Noi, Bo Put, Choeng Mon, Maenam, Bang Rak, Central Samui, Lamai
- Out-of-zone (do NOT confirm booking yourself — tell the customer their location is outside our normal delivery range and a staff member will confirm if it's possible, then flag for human help): Nathon, Taling Ngam, Lipa Noi, Baan Tai
- If the customer names a pickup location not in either list, do not guess which zone it's in — ask them to confirm it's within our normal area, or say a staff member will confirm if unsure.
- Never finalize a booking (never say "BOOKING_COMPLETE") for an out-of-zone or unrecognized location without staff confirmation first.

INCLUDED: Helmet provided, optional comprehensive insurance available. No hidden fees. Delivery is always free within our zone.

BOOKING: Collect full name, phone number, bike type, rental start date, rental end date, pickup location.
- Today's date is always the current date in Koh Samui (Thailand, GMT+7).
- If customer says "today", use today as start date automatically.
- If customer says "X days from today" or "X days starting today", calculate the end date automatically. Example: "5 days from today" = start today, end = today + 5 days.
- If customer says "1 week", that means 7 days. Calculate end date automatically.
- NEVER ask for start or end date again if the customer already gave you enough info to calculate them.
- When summarizing booking details, do NOT use markdown formatting like ** or *. Use plain text only.
Once you have all details say exactly: "BOOKING_COMPLETE" followed by a plain text summary with each field on its own line like:
Full Name: ...
Phone Number: ...
Bike Type: ...
Start Date: ...
End Date: ...
Pickup Location: ...
Price: ...
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

app.listen(3000, () => console.log('TOH Rental Bot running on port 3000'));
