require("dotenv").config();
const express = require("express");
const crypto  = require("crypto");
const { upsertWayfrontTicket } = require("./wayfront");

const app = express();
app.use(express.json());

const {
  ZOOM_WEBHOOK_SECRET,
  PORT = 3000,
} = process.env;

// Detect language from which Zoom booking page was used
// Key = the ID in the booking page URL, Value = language
const BOOKING_PAGES = {
  "8lpnmxio": "Spanish", // trusteefriend.zoom.us/zbook/d/8lpnmxio/reuni-n-con-trusteefriend
  "8pakjwo3": "English", // trusteefriend.zoom.us/zbook/d/8pakjwo3/meeting-with-trusteefriend
};

// Zoom CRC challenge on webhook registration
app.get("/webhook/zoom", (req, res) => {
  res.json({ plainToken: req.query.challenge });
});

// Main webhook endpoint
app.post("/webhook/zoom", async (req, res) => {
  if (!verifyZoomSignature(req)) {
    console.error("❌ Invalid Zoom signature");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { event, payload } = req.body;

  // Zoom URL validation on first setup
  if (event === "endpoint.url_validation") {
    const hash = crypto
      .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
      .update(payload.plainToken)
      .digest("hex");
    return res.json({ plainToken: payload.plainToken, encryptedToken: hash });
  }

  if (event !== "scheduler.booking_created") {
    return res.status(200).json({ received: true });
  }

  console.log("📅 New Zoom booking received");

  const booking  = payload.object;
  const attendee = booking.attendees?.[0] || {};

  // Detect language from booking page ID in the schedule URL
  const scheduleId = booking.schedule_id || booking.booking_page_id || booking.id || "";
  const language   = Object.entries(BOOKING_PAGES).find(
    ([id]) => scheduleId.includes(id)
  )?.[1] || "English";

  console.log(`🌐 Language detected: ${language} (schedule: ${scheduleId})`);

  const ticketData = {
    agentEmail: booking.registrant?.email || booking.agent_email || "",
    client: {
      first_name: attendee.first_name || "",
      last_name:  attendee.last_name  || "",
      email:      attendee.email      || "",
      phone:      attendee.phone      || "",
    },
    meeting: {
      topic:      booking.topic,
      start_time: booking.start_time,
      duration:   booking.duration,
      zoom_link:  booking.join_url,
      host:       booking.host_email || "",
      language,
      meeting_id: booking.id,
    },
  };

  try {
    const result = await upsertWayfrontTicket(ticketData);
    console.log(`✅ Ticket ${result.action}: #${result.ticket?.id}`);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("❌ Error:", err.message);
    return res.status(500).json({ error: "Failed to upsert ticket" });
  }
});

function verifyZoomSignature(req) {
  try {
    const timestamp = req.headers["x-zm-request-timestamp"];
    const signature = req.headers["x-zm-signature"];
    const message   = `v0:${timestamp}:${JSON.stringify(req.body)}`;
    const hash      = "v0=" + crypto
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
