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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const MY_NUMBER = process.env.MY_NUMBER;

const conversations = {};
const processedMessages = new Set();

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
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

        if (text.toLowerCase() === 'list today' && from === MY_NUMBER) {
          const list = await getTodayBookings();
          await sendWhatsApp(from, list);
          return res.sendStatus(200);
        }

        await handleMessage(from, text);
      } else {
        await sendWhatsApp(from, 'Sorry, I can only read text messages. Please type your question.');
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

  const systemPrompt = `You are a helpful booking assistant for TOH Motorbike Rental in Koh Samui, Thailand. You help customers choose and book motorbikes.

ABOUT TOH:
- Located in Chaweng, Koh Samui (Chaweng Yai Soi 4 Bo Put, Surat Thani 84320)
- Over 5 years experience, fleet of 100+ well-maintained bikes
- Only Honda and Yamaha bikes
- Open 7 days a week
- Phone: +66 622 531 159

OUR BIKES AND PRICES (starting from per day):
- Honda Scoopy 110cc (2022-2025): 250 THB/day - Cheapest option
- Honda Click 125cc (2022-2025): 250 THB/day - Popular
- Honda Click 150cc (2022-2025): 250 THB/day
- Yamaha Filano 125cc (2022-2025): 250 THB/day
- Honda Click 160cc (2022-2025): 350 THB/day - Popular
- Yamaha Aerox 155cc (2020-2022): 300 THB/day
- Yamaha Nmax 155cc (2020-2024): 400 THB/day
- Honda ADV 160cc (2024-2025): 400 THB/day - Best Value
- Honda PCX 160cc (2022-2025): 400 THB/day
- Yamaha Xmax 300cc (2022-2025): 800 THB/day
- Honda ADV 350cc (2022-2025): 850 THB/day

DELIVERY & PICKUP:
- We deliver and pick up within Chaweng and Bo Put area only (max 25 minutes away)
- Outside this area: customer must come to our shop in Chaweng

INCLUDED: Helmet provided, optional comprehensive insurance available. No hidden fees.

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
      await sendWhatsApp(STAFF_GROUP_ID, `NEW BOOKING from +${from}:\n\n${cleanReply}`);

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
      await sendWhatsApp(STAFF_GROUP_ID, `Customer +${from} needs human help!\nLast message: ${text}`);
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

app.listen(3000, () => console.log('TOH Rental Bot running on port 3000'));

