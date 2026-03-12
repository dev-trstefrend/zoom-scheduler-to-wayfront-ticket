const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const WAYFRONT_BASE = 'https://app.trusteefriend.com/api';
const WAYFRONT_API_KEY = process.env.WAYFRONT_API_KEY;

async function findTicketByEmail(email) {
  const res = await fetch(`${WAYFRONT_BASE}/tickets?search=${encodeURIComponent(email)}`, {
    headers: {
      'Authorization': `Bearer ${WAYFRONT_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await res.json();
  console.log('🔍 Search response:', JSON.stringify(data).substring(0, 300));
  const tickets = data.data || data.tickets || data || [];
  return Array.isArray(tickets) ? tickets[0] : null;
}

async function createTicket(booking, language) {
  const body = {
    subject: `Zoom Booking - ${language} - ${booking.first_name} ${booking.last_name}`,
    note: `Meeting scheduled: ${booking.start_time}\nClient: ${booking.first_name} ${booking.last_name}\nEmail: ${booking.email}\nPhone: ${booking.phone || 'N/A'}\nLanguage: ${language}`
  };

  const res = await fetch(`${WAYFRONT_BASE}/tickets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WAYFRONT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  console.log('🎫 Create ticket response:', JSON.stringify(data).substring(0, 300));
  return data;
}

async function updateTicket(ticketId, booking, language) {
  const body = {
    note: `[UPDATE] Meeting scheduled: ${booking.start_time}\nClient: ${booking.first_name} ${booking.last_name}\nEmail: ${booking.email}\nLanguage: ${language}`
  };

  const res = await fetch(`${WAYFRONT_BASE}/tickets/${ticketId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${WAYFRONT_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  console.log('✏️ Update ticket response:', JSON.stringify(data).substring(0, 300));
  return data;
}

async function upsertTicket(booking, language) {
  const email = booking.email || booking.invitee_email;
  console.log(`📧 Looking up ticket for email: ${email}`);
  const existing = await findTicketByEmail(email);
  if (existing) {
    console.log(`📝 Updating existing ticket ${existing.id} for ${email}`);
    return await updateTicket(existing.id, booking, language);
  } else {
    console.log(`🆕 Creating new ticket for ${email}`);
    return await createTicket(booking, language);
  }
}

module.exports = { upsertTicket };
