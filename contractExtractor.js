/**
 * contractExtractor.js
 *
 * Extracts rental contract data from a photo using Gemini 2.5 Flash vision.
 * Plug this into the WhatsApp webhook handler wherever incoming images
 * are currently forwarded to staff — call extractContractData() first,
 * then still forward the photo to staff as before.
 *
 * Requires: GEMINI_API_KEY env var (same one already used by the bot)
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Fields we want pulled off the contract. Keep this in sync with the
// Fleet Tracker sheet columns: Renter Name, Renter Phone, Rented Date,
// Expected Return, Status (we set this ourselves, not extracted).
const EXTRACTION_PROMPT = `
You are reading a photo of a motorbike rental contract for TOH Motorbike Rental.
Extract the following fields and return ONLY raw JSON, no markdown, no code fences, no explanation.

{
  "plate": string or null,          // bike plate number as written
  "renterName": string or null,     // customer's full name
  "renterPhone": string or null,    // customer's phone number, digits only
  "rentedDate": string or null,     // rental start date, format YYYY-MM-DD if determinable
  "expectedReturn": string or null, // expected return date, format YYYY-MM-DD if determinable
  "price": number or null,          // total agreed price in THB, numeric only
  "confidence": "high" | "medium" | "low"  // your overall confidence reading this contract
}

Rules:
- If a field is illegible, unclear, or not present, set it to null. Never guess.
- Dates on contracts may be handwritten in DD/MM/YY or DD/MM/YYYY format — convert to YYYY-MM-DD.
- If ANY field is uncertain or the handwriting is hard to read, set confidence to "low" or "medium" accordingly.
- Set confidence to "high" only if the photo is clear and every field was read with certainty.
`.trim();

/**
 * Fetches an image from a URL (e.g. WhatsApp media URL) and returns
 * base64 + mime type, ready for Gemini's inline_data field.
 */
async function fetchImageAsBase64(imageUrl, authHeader) {
  const res = await fetch(imageUrl, {
    headers: authHeader ? { Authorization: authHeader } : undefined,
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
  }
  const mimeType = res.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { base64, mimeType };
}

/**
 * Calls Gemini vision to extract structured contract data from a photo.
 *
 * @param {string} imageUrl - URL of the contract photo (e.g. from WhatsApp media API)
 * @param {string} [authHeader] - Optional auth header if the image URL needs it (WhatsApp media URLs usually do)
 * @returns {Promise<object>} extracted fields, or a fallback object with confidence "low" on failure
 */
async function extractContractData(imageUrl, authHeader) {
  try {
    const { base64, mimeType } = await fetchImageAsBase64(imageUrl, authHeader);

    const body = {
      contents: [
        {
          parts: [
            { text: EXTRACTION_PROMPT },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 500,
      },
    };

    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error: ${res.status} ${errText}`);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Strip accidental code fences just in case the model adds them
    const cleaned = rawText.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("Failed to parse Gemini contract extraction response:", cleaned);
      return fallbackResult("Could not parse model response");
    }

    // Defensive defaults in case the model omits a key
    return {
      plate: parsed.plate ?? null,
      renterName: parsed.renterName ?? null,
      renterPhone: parsed.renterPhone ?? null,
      rentedDate: parsed.rentedDate ?? null,
      expectedReturn: parsed.expectedReturn ?? null,
      price: parsed.price ?? null,
      confidence: parsed.confidence ?? "low",
    };
  } catch (err) {
    console.error("extractContractData failed:", err);
    return fallbackResult(err.message);
  }
}

function fallbackResult(reason) {
  return {
    plate: null,
    renterName: null,
    renterPhone: null,
    rentedDate: null,
    expectedReturn: null,
    price: null,
    confidence: "low",
    error: reason,
  };
}

/**
 * Decides whether extracted data is trustworthy enough to auto-fill,
 * or should be flagged to staff for manual entry instead.
 *
 * Use this as the gate before writing to the Fleet Tracker sheet.
 */
function shouldAutoFill(extracted) {
  if (!extracted || extracted.error) return false;
  if (extracted.confidence === "low") return false;
  // Require at minimum a plate + renter name to auto-fill anything
  return Boolean(extracted.plate && extracted.renterName);
}

module.exports = {
  extractContractData,
  shouldAutoFill,
};
