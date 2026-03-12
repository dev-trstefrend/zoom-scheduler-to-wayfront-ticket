// ============================================================
// wayfront.js — Search-first ticket upsert
// Searches by agent affiliate email → updates if found, creates if not
// ============================================================

const WAYFRONT_BASE_URL  = "https://api.wayfront.com/v1"; // ⚠️ confirm from your dashboard
const WAYFRONT_API_KEY   = process.env.WAYFRONT_API_KEY;
const WAYFRONT_WORKSPACE = process.env.WAYFRONT_WORKSPACE;

const headers = {
  "Content-Type":  "application/json",
  "Authorization": `Bearer ${WAYFRONT_API_KEY}`,
  "X-Workspace":   WAYFRONT_WORKSPACE,
};

// Main entry point
async function upsertWayfrontTicket(bookingData) {
  const { agentEmail, client, meeting } = bookingData;

  console.log(`🔍 Searching for ticket with agent email: ${agentEmail}`);
  const existing = await findTicketByAgentEmail(agentEmail);

  if (existing) {
    console.log(`✅ Found ticket #${existing.id} — updating...`);
    return await updateTicket(existing.id, { client, meeting });
  } else {
    console.log(`🆕 No existing ticket — creating new...`);
    return await createTicket({ agentEmail, client, meeting });
  }
}

// Search for existing ticket by agent affiliate email
async function findTicketByAgentEmail(agentEmail) {
  try {
    // ⚠️ Confirm exact query param name from your Wayfront API docs
    const url = `${WAYFRONT_BASE_URL}/tickets?agent_email=${encodeURIComponent(agentEmail)}`;
    const response = await fetch(url, { method: "GET", headers });

    if (!response.ok) {
      console.error(`Search failed: ${response.status}`);
      return null;
    }

    const data    = await response.json();
    const tickets = Array.isArray(data) ? data : (data.data || data.items || []);

    if (tickets.length === 0) return null;

    // Return most recently created ticket
    return tickets.sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    )[0];

  } catch (err) {
    console.error("Search error:", err.message);
    return null; // fail safe — fall through to create
  }
}

// Update existing ticket
async function updateTicket(ticketId, { client, meeting }) {
  // ⚠️ Confirm PATCH vs PUT from your Wayfront API docs
  const response = await fetch(`${WAYFRONT_BASE_URL}/tickets/${ticketId}`, {
    method:  "PATCH",
    headers,
    body: JSON.stringify({
      ...buildTicketBody({ client, meeting }),
      note: `[Updated ${new Date().toLocaleString()}]\n${formatNotes(meeting, client)}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Update failed: ${response.status} ${await response.text()}`);
  }

  return { action: "updated", ticket: await response.json() };
}

// Create new ticket
async function createTicket({ agentEmail, client, meeting }) {
  // ⚠️ Confirm POST endpoint from your Wayfront API docs
  const response = await fetch(`${WAYFRONT_BASE_URL}/tickets`, {
    method:  "POST",
    headers,
    body: JSON.stringify({
      ...buildTicketBody({ client, meeting }),
      agent_email: agentEmail,
    }),
  });

  if (!response.ok) {
    throw new Error(`Create failed: ${response.status} ${await response.text()}`);
  }

  return { action: "created", ticket: await response.json() };
}

// Shared body builder
function buildTicketBody({ client, meeting }) {
  return {
    subject:      `[${meeting.language}] Free Consultation — ${client.first_name} ${client.last_name}`,
    notes:        formatNotes(meeting, client),
    client_name:  `${client.first_name} ${client.last_name}`,
    client_email: client.email,
    client_phone: client.phone || "",
    tags: [
      meeting.language === "Spanish" ? "spanish" : "english",
      "zoom-booking",
      "free-consultation",
    ],
    custom_fields: {
      zoom_link:    meeting.zoom_link,
      meeting_time: meeting.start_time,
      language:     meeting.language,
      assigned_to:  meeting.host,
      meeting_id:   meeting.meeting_id,
    },
  };
}

function formatNotes(meeting, client) {
  return [
    `📅 ${new Date(meeting.start_time).toLocaleString("en-US", { timeZone: "America/New_York" })}`,
    `⏱  Duration: ${meeting.duration} mins`,
    `🔗 Zoom: ${meeting.zoom_link}`,
    `👤 Host: ${meeting.host}`,
    `🌐 Language: ${meeting.language}`,
    `📧 ${client.email}`,
    `📞 ${client.phone || "No phone provided"}`,
  ].join("\n");
}

module.exports = { upsertWayfrontTicket };
