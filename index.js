const express = require('express');
const axios = require('axios');
require('dotenv').config();
const app = express();
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const conversations = {};
const processedMessages = new Set();

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
      if (processedMessages.has(msgId)) {
        return res.sendStatus(200);
      }
      processedMessages.add(msgId);

      const from = message.from;

      if (message.type === 'text') {
        const text = message.text.body;
        console.log(`Message from ${from}: ${text}`);
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

  const systemPrompt = `You are a helpful assistant for TOH Motorbike Rental on Koh Samui, Thailand.
You help customers with information about bike rentals and take bookings.
When a customer wants to book, collect: full name, phone number, bike type, rental start date, rental end date, and pickup location.
Once you have all booking details, say exactly: "BOOKING_COMPLETE" followed by a summary.
If customer needs human help, say exactly: "NEED_HUMAN_HELP".
Be friendly, helpful and concise.`;

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
      console.log(`Booking completed for ${from}`);
    } else if (reply.includes('NEED_HUMAN_HELP')) {
      await sendWhatsApp(from, 'No problem! Our staff will contact you shortly.');
      await sendWhatsApp(STAFF_GROUP_ID, `Customer +${from} needs human help!\nLast message: ${text}`);
      console.log(`Human help requested by ${from}`);
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
