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

function wayfrontHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${WAYFRONT_API_KEY}`,
  };
}

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
  const meetingId = booking.meeting_id || "";

  const qas = booking.questions_and_answers || [];
  const phone = qas.find(q => q.question === "Phone Number")?.answer?.[0] || "N/A";
  const affiliateEmail = qas.find(q =>
    q.question === "What is your email, agent affiliate?" ||
    q.question === "¿Cual es tu correo electrónico, agente afiliado?"
  )?.answer?.[0] || "";

  console.log(`👤 Client: ${firstName} ${lastName} <${clientEmail}>`);
  console.log(`🌐 Language: ${language}`);
  console.log(`🤝 Affiliate email: ${affiliateEmail}`);

  try {
    // Look up affiliate's Wayfront user_id by email
    let userId = null;
    if (affiliateEmail) {
      console.log(`🔍 Looking up Wayfront user for: ${affiliateEmail}`);
      const teamRes = await fetch(
        `${WAYFRONT_BASE}/clients?filters[email][$eq][]=${encodeURIComponent(affiliateEmail)}`,
        { headers: wayfrontHeaders() }
      );
      const teamData = await teamRes.json();
      console.log(`👥 Team lookup response:`, JSON.stringify(teamData).substring(0, 300));
      userId = teamData?.data?.[0]?.id || null;
      console.log(`🆔 Found user_id: ${userId}`);
    }

    if (!userId) {
      console.error("❌ Could not find Wayfront user for affiliate email:", affiliateEmail);
      return res.status(200).json({ success: false, reason: "affiliate not found" });
    }

    // Create ticket assigned to affiliate
    const subject = `Zoom Booking - ${language} - ${firstName} ${lastName}`;
    const note = `📅 Zoom Meeting Booked!\nDate: ${startTime}\nClient: ${firstName} ${lastName}\nEmail: ${clientEmail}\nPhone: ${phone}\nLanguage: ${language}\nJoin URL: ${meetingUrl}\nMeeting ID: ${meetingId}`;

    console.log(`🎫 Creating ticket for user_id ${userId}...`);
    const createRes = await fetch(`${WAYFRONT_BASE}/tickets`, {
      method: "POST",
      headers: wayfrontHeaders(),
      body: JSON.stringify({ subject, note, user_id: userId }),
    });
    const createText = await createRes.text();
    console.log(`📬 Create ticket response ${createRes.status}:`, createText);

    if (!createRes.ok) {
      console.error("❌ Create ticket failed:", createRes.status, createText);
      return res.status(200).json({ success: false });
    }

    // Get the ticket number from the response to attach form fields
    const ticketData = JSON.parse(createText);
    const ticketNumber = ticketData?.number || ticketData?.data?.number || null;
    console.log(`✅ Ticket created! Number: ${ticketNumber}`);

    // Add client info as filled form fields
    if (ticketNumber) {
      const fields = [
        { name: "First Name", value: firstName },
        { name: "Last Name", value: lastName },
        { name: "Email", value: clientEmail },
        { name: "Phone", value: phone },
        { name: "Language", value: language },
        { name: "Meeting Date", value: startTime },
        { name: "Zoom Link", value: meetingUrl },
      ];

      for (const field of fields) {
        if (!field.value || field.value === "N/A") continue;
        const fdRes = await fetch(`${WAYFRONT_BASE}/form_data`, {
          method: "POST",
          headers: wayfrontHeaders(),
          body: JSON.stringify({ ticket: ticketNumber, name: field.name, type: "text", value: field.value }),
        });
        console.log(`📋 form_data [${field.name}]: ${fdRes.status}`);
      }
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
