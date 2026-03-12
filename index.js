require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const {
  ZOOM_WEBHOOK_SECRET,
  WAYFRONT_API_KEY,
  PORT = 3000,
} = process.env;

const BOOKING_PAGES = {
  "8lpnmxio": "Spanish",
  "8pakjwo3": "English",
};

const WAYFRONT_BASE = "https://app.trusteefriend.com/api";

// Healthcheck
app.get("/", (req, res) => res.json({ status: "ok" }));

// Zoom CRC challenge
app.get("/webhook/zoom", (req, res) => {
  const { challenge } = req.query;
  res.json({ plainToken: challenge });
});

// Main webhook
app.post("/webhook/zoom", async (req, res) => {
  console.log("📨 Webhook received, event:", req.body?.event);

  if (!verifyZoomSignature(req)) {
    console.error("❌ Invalid Zoom signature");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { event, payload } = req.body;

  if (event === "endpoint.url_validation") {
    const hash = crypto
      .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
      .update(payload.plainToken)
      .digest("hex");
    return res.json({ plainToken: payload.plainToken, encryptedToken: hash });
  }

  if (event !== "scheduler.scheduled_event_created") {
    console.log("⏭️ Ignoring event:", event);
    return res.status(200).json({ received: true });
  }

  console.log("📅 Booking event! Processing...");

  const booking = payload?.object || payload || {};
  const eventId = booking.event_id || "";
  const language = Object.entries(BOOKING_PAGES).find(([id]) => eventId.includes(id))?.[1] || "English";

  const clientEmail = booking.invitee_email || "";
  const firstName = booking.invitee_first_name || "";
  const lastName = booking.invitee_last_name || "";
  const startTime = booking.start_date_time || "";
  const meetingUrl = booking.meeting_join_url || "";
  const phone = (booking.questions_and_answers || []).find(q => q.question === "Phone Number")?.["answer"]?.[0] || "N/A";

  console.log(`👤 Client: ${firstName} ${lastName} <${clientEmail}>`);
  console.log(`🌐 Language: ${language}`);

  try {
    // Search for existing ticket by client email in form_data
    console.log(`🔍 Searching for ticket with client email: ${clientEmail}`);
    const searchUrl = `${WAYFRONT_BASE}/tickets?filters[form_data.Email][$eq][]=${encodeURIComponent(clientEmail)}`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WAYFRONT_API_KEY}`,
      }
    });
    const searchData = await searchRes.json();
    console.log(`🔍 Search result: ${searchData?.data?.length || 0} tickets found`);

    const existingTicket = searchData?.data?.[0];

    const zoomNote = `📅 Zoom Meeting Booked!\nDate: ${startTime}\nClient: ${firstName} ${lastName}\nEmail: ${clientEmail}\nPhone: ${phone}\nLanguage: ${language}\nJoin URL: ${meetingUrl}`;

    if (existingTicket) {
      console.log(`✏️ Updating ticket ${existingTicket.id} for ${clientEmail}`);
      const updateRes = await fetch(`${WAYFRONT_BASE}/tickets/${existingTicket.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${WAYFRONT_API_KEY}`,
        },
        body: JSON.stringify({ note: zoomNote }),
      });
      const updateText = await updateRes.text();
      console.log(`📬 Update response ${updateRes.status}:`, updateText);
      if (updateRes.ok) {
        console.log("✅ Ticket updated successfully!");
      } else {
        console.error("❌ Update failed:", updateRes.status, updateText);
      }
    } else {
      console.log(`⚠️ No existing ticket found for ${clientEmail}`);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("💥 Exception:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

function verifyZoomSignature(req) {
  try {
    const timestamp = req.headers["x-zm-request-timestamp"];
    const signature = req.headers["x-zm-signature"];
    const message = `v0:${timestamp}:${JSON.stringify(req.body)}`;
    const hash = "v0=" + crypto
      .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
      .update(message)
      .digest("hex");
    return hash === signature;
  } catch {
    return false;
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
