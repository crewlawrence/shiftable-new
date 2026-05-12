const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Claude helpers ───────────────────────────────────────────────────────────

async function parseShiftRequest(text) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: `You extract shift coverage details from employee messages.
Return ONLY a JSON object (no markdown) with these fields:
{
  "date": "string - the date of the shift (e.g. 'Monday June 9' or 'tomorrow')",
  "time": "string - shift time range (e.g. '9am-5pm')",
  "role": "string - job role if mentioned (e.g. 'cashier', 'barista') or null",
  "reason": "string - reason for needing coverage if mentioned, or null",
  "isShiftRequest": true/false
}
If the message is NOT a shift coverage request, set isShiftRequest to false.`,
    messages: [{ role: "user", content: text }],
  });
  try {
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return { isShiftRequest: false };
  }
}

function matchNamesToMembers(text, members) {
  const rawNames = text
    .split(/,|\band\b/i)
    .map((s) => s.replace(/[^a-zA-Z0-9 '\-]/g, "").trim())
    .filter(Boolean);

  const matched = [];
  const unmatched = [];
  const usedIds = new Set();

  for (const raw of rawNames) {
    const lower = raw.toLowerCase();
    const found = members.find((m) => {
      if (usedIds.has(m.id)) return false;
      const fullName    = (m.real_name || "").toLowerCase();
      const displayName = (m.profile?.display_name || "").toLowerCase();
      const username    = (m.name || "").toLowerCase();
      const firstName   = fullName.split(" ")[0];
      return fullName === lower || displayName === lower || username === lower || firstName === lower;
    });
    if (found) {
      usedIds.add(found.id);
      matched.push({ id: found.id, name: found.real_name || found.name });
    } else if (raw.length > 0) {
      unmatched.push(raw);
    }
  }
  return { matched, unmatched };
}

async function conductCandidateConversation(conversationHistory, requesterName, candidateName, shift) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: `You are a friendly colleague messaging ${candidateName} on Slack on behalf of ${requesterName}, trying to find out if they can cover a shift.

Shift details:
- Date: ${shift.date}
- Time: ${shift.time}${shift.role ? `\n- Role: ${shift.role}` : ""}${shift.reason ? `\n- Reason: ${shift.reason}` : ""}

Guidelines:
- Sound like a real person texting a coworker — casual, warm, brief.
- No bullet points, no corporate language, don't announce you're a bot.
- Answer reasonable questions (date, time, role). If you don't know something, say you'll find out.
- Gently encourage hesitant people but never pressure them.
- Recognize clear yes/no signals even when indirect:
  - Yes signals: "sure", "yeah I can do that", "no problem", "I'm free", "count me in"
  - No signals: "I can't", "I'm busy", "I have plans", "not available", "sorry", "no"
- Keep replies to 1–3 sentences.

Return ONLY a JSON object — no markdown, no explanation:
{
  "decision": "accept" | "decline" | "continue",
  "reply": "your next message to ${candidateName}"
}`,
    messages: conversationHistory,
  });
  try {
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return { decision: "continue", reply: response.content[0].text.trim() };
  }
}

async function generateOpeningMessage(requesterName, candidateName, shift) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 150,
    system: `Write a casual, friendly Slack message asking someone if they can cover a coworker's shift.
Sound like a real person, not a bot. Warm and direct. 1-2 sentences only.
Return ONLY the message text — no JSON, no formatting.`,
    messages: [{
      role: "user",
      content: `Ask ${candidateName} if they can cover a shift for ${requesterName}.
Shift: ${shift.date}, ${shift.time}${shift.role ? `, ${shift.role}` : ""}${shift.reason ? `. Reason: ${shift.reason}` : ""}.`,
    }],
  });
  return response.content[0].text.trim();
}

async function generateConfirmationMessage(requesterName, coverName, shift) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 120,
    system: `Write a short, warm Slack message. 2 sentences max. Sound human. Return ONLY the message text.`,
    messages: [{
      role: "user",
      content: `Tell ${requesterName} that ${coverName} agreed to cover their shift on ${shift.date} at ${shift.time}.`,
    }],
  });
  return response.content[0].text.trim();
}

// ─── Slack helpers ────────────────────────────────────────────────────────────

async function getUserName(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    return res.user.real_name || res.user.name;
  } catch {
    return "a teammate";
  }
}

async function openDM(client, userId) {
  const res = await client.conversations.open({ users: userId });
  return res.channel.id;
}

// ─── Core flow ────────────────────────────────────────────────────────────────

async function askNextCandidate(client, request) {
  const { teamId, candidates, currentIndex, requesterId, shiftDetails } = request;

  if (currentIndex >= candidates.length) {
    await db.updateRequest(teamId, request.id, { status: "exhausted" });
    const channel = await openDM(client, requesterId);
    await client.chat.postMessage({
      channel,
      text: `I've reached out to everyone on your list and no one was able to cover your ${shiftDetails.date} shift (${shiftDetails.time}). You may need to contact your manager directly.`,
    });
    return;
  }

  const candidateId = candidates[currentIndex];
  const [requesterName, candidateName] = await Promise.all([
    getUserName(client, requesterId),
    getUserName(client, candidateId),
  ]);

  const openingMessage = await generateOpeningMessage(requesterName, candidateName, shiftDetails);
  const candidateChannel = await openDM(client, candidateId);
  await client.chat.postMessage({ channel: candidateChannel, text: openingMessage });

  await db.updateRequest(teamId, request.id, {
    status:                "pending",
    currentAskedUserId:    candidateId,
    currentAskedChannelId: candidateChannel,
    conversationHistory:   [{ role: "assistant", content: openingMessage }],
  });

  const requesterChannel = await openDM(client, requesterId);
  await client.chat.postMessage({
    channel: requesterChannel,
    text: `I just reached out to *${candidateName}*. I'll let you know what they say!`,
  });
}

async function handleCandidateReply({ teamId, message, client }) {
  const candidateId = message.user;
  const text = message.text || "";

  const request = await db.getRequestForCandidate(teamId, candidateId);
  if (!request) return;

  const [requesterName, candidateName] = await Promise.all([
    getUserName(client, request.requesterId),
    getUserName(client, candidateId),
  ]);

  const history = [
    ...(request.conversationHistory || []),
    { role: "user", content: text },
  ];

  const { decision, reply } = await conductCandidateConversation(
    history, requesterName, candidateName, request.shiftDetails
  );

  await client.chat.postMessage({ channel: request.currentAskedChannelId, text: reply });

  await db.updateRequest(teamId, request.id, {
    conversationHistory: [...history, { role: "assistant", content: reply }],
  });

  if (decision === "accept") {
    await db.updateRequest(teamId, request.id, { status: "accepted", acceptedBy: candidateId });
    const confirmText = await generateConfirmationMessage(requesterName, candidateName, request.shiftDetails);
    const requesterChannel = await openDM(client, request.requesterId);
    await client.chat.postMessage({ channel: requesterChannel, text: confirmText });

  } else if (decision === "decline") {
    const updated = await db.updateRequest(teamId, request.id, {
      currentIndex:          request.currentIndex + 1,
      currentAskedUserId:    null,
      currentAskedChannelId: null,
      conversationHistory:   [],
    });
    await askNextCandidate(client, updated);
  }
}

async function handleNamesReply({ teamId, message, client, request }) {
  const text = message.text || "";
  const channel = await openDM(client, request.requesterId);

  const res = await client.users.list();
  const members = res.members.filter(
    (u) => !u.is_bot && !u.deleted && u.id !== "USLACKBOT" && u.id !== request.requesterId
  );

  const { matched, unmatched } = matchNamesToMembers(text, members);

  if (matched.length === 0) {
    await client.chat.postMessage({
      channel,
      text: `I couldn't match any of those names to someone on the team. Just type their names separated by commas — for example: _Alex, Jordan, Sam_`,
    });
    return;
  }

  if (unmatched.length > 0) {
    const skipped = unmatched.map((n) => `*${n}*`).join(", ");
    await client.chat.postMessage({
      channel,
      text: `Heads up — I couldn't find ${skipped} in the workspace, so I'll skip them.`,
    });
  }

  const nameList = matched.map((m) => `*${m.name}*`).join(", ");
  const updated = await db.updateRequest(teamId, request.id, {
    candidates:   matched.map((m) => m.id),
    currentIndex: 0,
  });

  await client.chat.postMessage({
    channel,
    text: `Got it! I'll reach out to ${nameList} one at a time, in that order.`,
  });

  await askNextCandidate(client, updated);
}

// ─── Exported handler ─────────────────────────────────────────────────────────

async function handleMessage({ teamId, message, client }) {
  const userId = message.user;
  const text   = message.text || "";

  const say = (t) => openDM(client, userId).then((ch) =>
    client.chat.postMessage({ channel: ch, text: t })
  );

  const asCandidate = await db.getRequestForCandidate(teamId, userId);
  if (asCandidate) {
    await handleCandidateReply({ teamId, message, client });
    return;
  }

  const asRequester = await db.getActiveRequestForUser(teamId, userId);
  if (asRequester) {
    if (asRequester.status === "awaiting_names") {
      await handleNamesReply({ teamId, message, client, request: asRequester });
    } else {
      await say(`I'm still waiting to hear back from someone on your list — I'll update you as soon as I know!`);
    }
    return;
  }

  const parsed = await parseShiftRequest(text);

  if (!parsed.isShiftRequest) {
    await say(
      `Hey! I'm the ShiftSwap Bot. Tell me about the shift you need covered and I'll reach out to your teammates.\n\nExample: _"I need someone to cover my Saturday June 14 shift from 9am–5pm, I'm a cashier."_`
    );
    return;
  }

  await say(
    `Got it — your *${parsed.date}* shift, ${parsed.time}${parsed.role ? `, ${parsed.role}` : ""}.\n\nWho would you like me to reach out to? Just type their names separated by commas and I'll contact them one at a time.\n\nExample: _Alex, Jordan, Sam_`
  );

  await db.createRequest(teamId, userId, parsed, []);
}

module.exports = { handleMessage };
