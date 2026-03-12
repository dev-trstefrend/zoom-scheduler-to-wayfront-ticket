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
  console.log("📦 Raw body:", JSON.stringify(req.body, null, 2));

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

  const email = booking.invitee_email || "";
  const firstName = booking.invitee_first_name || "";
  const lastName = booking.invitee_last_name || "";
  const startTime = booking.start_date_time || "";
  const phone = (booking.questions_and_answers || []).find(q => q.question === "Phone Number")?.["answer"]?.[0] || "N/A";

  console.log(`👤 Attendee: ${firstName} ${lastName} <${email}>`);
  console.log(`🌐 Language: ${language}`);

  try {
    const subject = `Zoom Booking - ${language} - ${firstName} ${lastName}`;
    const note = `Meeting scheduled: ${startTime}\nClient: ${firstName} ${lastName}\nEmail: ${email}\nPhone: ${phone}\nLanguage: ${language}`;

    console.log("🎫 Creating Wayfront ticket...");
    const response = await fetch("https://app.trusteefriend.com/api/tickets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WAYFRONT_API_KEY}`,
      },
      body: JSON.stringify({ subject, note }),
    });

    const text = await response.text();
    console.log(`📬 Wayfront response ${response.status}:`, text);

    if (response.ok) {
      console.log("✅ Ticket created successfully!");
    } else {
      console.error("❌ Wayfront error:", response.status, text);
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
