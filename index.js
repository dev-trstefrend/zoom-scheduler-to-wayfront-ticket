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
  "muu3-3f4": "English",
};


const HOST_PMI_LINKS = {
  'Alex Ramirez': 'https://trusteefriend.zoom.us/j/7142537721',
  'Lisa Bui': 'https://trusteefriend.zoom.us/j/5313786112',
  'Stephanie Clark': 'https://trusteefriend.zoom.us/j/7026702109',
  'Amell Martinez': 'https://trusteefriend.zoom.us/j/8422731668',
  'Barry Kozak': 'https://trusteefriend.zoom.us/j/8011171543',
  'Daniel Quijano': 'https://trusteefriend.zoom.us/j/9495422142',
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

  // Filter: only process bookings from our two pages (identified by affiliate question text)
  const qasCheck = booking.questions_and_answers || [];
  const isEnglish = qasCheck.some(q => q.question === "What is your email, agent affiliate?");
  const isSpanish = qasCheck.some(q => q.question === "¿Cual es tu correo electrónico, agente afiliado?");
  if (!isEnglish && !isSpanish) {
    console.log("⏭️ Not a TrusteeFriend booking page, ignoring.");
    return res.status(200).json({ received: true });
  }
  const language = isSpanish ? "Spanish" : "English";

  const clientEmail = booking.invitee_email || "";
  const firstName = booking.invitee_first_name || "";
  const lastName = booking.invitee_last_name || "";
  const scheduledEvent = booking.scheduled_event || {};
  const startTime = scheduledEvent.start_date_time || "";
  const meetingId = scheduledEvent.external_location?.meeting_id || "";
  const meetingUrl = scheduledEvent.external_location?.meeting_join_url || "";
  const hostName = scheduledEvent.attendees?.[0]?.display_name || "";
  const timeZone = booking.time_zone || "America/Los_Angeles";
  console.log(`🔗 Meeting URL: ${meetingUrl} (host: ${hostName})`);
  console.log(`📅 Start time: ${startTime} (tz: ${timeZone})`);

  const qas = booking.questions_and_answers || [];
  const phone = qas.find(q => q.question === "Phone Number")?.answer?.[0] || "N/A";
  const affiliateEmail = qas.find(q =>
    q.question === "What is your email, agent affiliate?" ||
    q.question === "¿Cual es tu correo electrónico, agente afiliado?"
  )?.answer?.[0] || "";

  console.log(`📦 Full booking object:`, JSON.stringify(booking));
  console.log(`👤 Client: ${firstName} ${lastName} <${clientEmail}>`);
  console.log(`🌐 Language: ${language}`);
  console.log(`🤝 Affiliate email: ${affiliateEmail}`);

  try {
    // Look up affiliate's Wayfront user_id by email
    let userId = null;
    let affiliateName = "Affiliate";
    if (affiliateEmail) {
      console.log(`🔍 Looking up Wayfront user for: ${affiliateEmail}`);
      const teamRes = await fetch(
        `${WAYFRONT_BASE}/clients?filters[email][$eq][]=${encodeURIComponent(affiliateEmail)}`,
        { headers: wayfrontHeaders() }
      );
      const teamData = await teamRes.json();
      console.log(`👥 Client lookup response:`, JSON.stringify(teamData).substring(0, 300));
      const affiliateRecord = teamData?.data?.[0];
      userId = affiliateRecord?.id || null;
      affiliateName = affiliateRecord?.name_f || affiliateRecord?.name || "Affiliate";
      console.log(`🆔 Found user_id: ${userId}, name: ${affiliateName}`);
    }

    if (!userId) {
      console.error("❌ Could not find Wayfront user for affiliate email:", affiliateEmail);
      return res.status(200).json({ success: false, reason: "affiliate not found" });
    }

    // Create ticket assigned to affiliate
    const subject = `Referral for ${firstName} ${lastName}`;
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
    const ticketNumber = ticketData?.number || ticketData?.id || ticketData?.data?.number || ticketData?.data?.id || null;
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

    // Post confirmation message to ticket
    if (ticketNumber) {
      // Parse date, time, timezone from startTime (e.g. "2026-03-13T08:00:00-07:00")
      let meetingDate = "";
      let meetingTime = "";
      try {
        const dt = new Date(startTime);
        meetingDate = dt.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
        const pt = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
        const mt = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" });
        const ct = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
        const et = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
        const ht = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Pacific/Honolulu" });
        meetingTime = `${pt} PT / ${mt} MT / ${ct} CT / ${et} ET / ${ht} HT`;
      } catch {}

      const dateStr = meetingDate && !meetingDate.includes('Invalid') ? meetingDate : null;
      const timeStr = meetingTime && !meetingTime.includes('Invalid') ? meetingTime : null;
      const linkStr = meetingUrl || null;
      let message = `Hello ${affiliateName},\n\nYou've successfully booked a meeting for your referral! 🎉\n\n`;
      if (dateStr) message += `📅 Date: ${dateStr}\n`;
      if (timeStr) message += `🕐 Time: ${timeStr}\n`;
      if (linkStr) message += `🔗 Zoom Link: ${linkStr}\n`;
      if (hostName) message += `\nYou'll be meeting with ${hostName}.\n`;
      message += `\nWe look forward to speaking soon!\n `;

      const msgRes = await fetch(`${WAYFRONT_BASE}/ticket_messages/${ticketNumber}`, {
        method: "POST",
        headers: wayfrontHeaders(),
        body: JSON.stringify({ message, staff_only: false }),
      });
      console.log(`💬 Message posted: ${msgRes.status}`);
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
