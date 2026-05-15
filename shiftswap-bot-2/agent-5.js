const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Single AI brain ──────────────────────────────────────────────────────────

/**
 * The entire agent is one Claude call. Claude reads the full context —
 * who the person is, what state the request is in, the conversation history —
 * and decides what to do and what to say. No if/then routing.
 */
async function runAgent(context) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 600,
    system: `You are ShiftSwap, a friendly AI agent embedded in Slack that helps employees find shift coverage. You talk like a real, warm human colleague — casual, brief, never robotic.

You will receive a JSON context object describing the current situation. Based on that, you decide what action to take and what message to send.

Always return ONLY a JSON object in this shape:
{
  "action": "one of the actions listed below",
  "message": "the message to send to the current user",
  "notifyRequesterId": "optional — a separate message to send to the requester if needed",
  "notifyRequesterMessage": "the message content if notifyRequesterId is set"
}

Available actions:
- "ask_for_shift_details"   → user greeted the bot or sent something unclear; ask them what shift they need covered
- "ask_for_names"           → shift details are understood; ask who they want you to reach out to
- "start_outreach"          → names have been provided; confirm and begin reaching out to the first person
- "candidate_continue"      → candidate replied but hasn't clearly accepted or declined; keep the conversation going naturally
- "candidate_accepted"      → candidate clearly said yes; thank them and notify the requester
- "candidate_declined"      → candidate clearly said no; say no worries and move to the next person
- "outreach_exhausted"      → no more candidates; tell the requester everyone was unavailable
- "requester_update"        → requester messaged while outreach is in progress; reassure them

Rules:
- Be conversational. Sound human. Keep messages to 1-3 sentences.
- Recognize indirect yes/no: "sure thing" = accepted, "I've got plans" = declined.
- Never mention JSON, actions, or that you're an AI agent.
- When asking for names, tell them to just type names separated by commas (no @ needed).`,
    messages: [
      { role: "user", content: JSON.stringify(context) }
    ],
  });

  try {
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return {
      action: "ask_for_shift_details",
      message: "Hey! I'm ShiftSwap. Tell me about the shift you need covered and I'll reach out to your team for you.",
    };
  }
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

async function send(client, userId, text) {
  const channel = await openDM(client, userId);
  await client.chat.postMessage({ channel, text });
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

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleMessage({ teamId, message, client }) {
  const userId   = message.user;
  const text     = message.text || "";

  // Gather all the context Claude needs to make decisions
  const userName      = await getUserName(client, userId);
  const activeRequest = await db.getActiveRequestForUser(teamId, userId);
  const candidateOf   = await db.getRequestForCandidate(teamId, userId);

  // Build a rich context object — Claude reads this and decides everything
  const context = {
    whoIsMessaging: userName,
    userId,
    theirMessage: text,
    currentRole: candidateOf
      ? "candidate"
      : activeRequest
        ? "requester"
        : "new_user",
    requestStatus: activeRequest?.status || candidateOf?.status || null,
    shiftDetails:  activeRequest?.shiftDetails || candidateOf?.shiftDetails || null,
    conversationHistory: candidateOf?.conversationHistory || [],
    candidatesRemaining: activeRequest
      ? activeRequest.candidates.length - activeRequest.currentIndex
      : null,
  };

  const result = await runAgent(context);
  console.log("🤖 Agent decision:", result.action, "| message:", result.message?.slice(0, 60));

  // ── Execute the action Claude chose ──────────────────────────────────────

  if (result.action === "ask_for_shift_details" || result.action === "requester_update") {
    await send(client, userId, result.message);
    // Don't create a DB record yet — wait until we have real shift details
  }

  else if (result.action === "ask_for_names") {
    // Claude understood the shift — parse and save it, then ask for names
    const shiftDetails = await parseShiftFromText(text);
    await db.createRequest(teamId, userId, shiftDetails, []);
    await send(client, userId, result.message);
  }

  else if (result.action === "start_outreach") {
    if (!activeRequest) {
      await send(client, userId, `Let me get your shift details first — what date and time is the shift you need covered?`);
      return;
    }

    const membersRes = await client.users.list();
    const members = membersRes.members.filter(
      (u) => !u.is_bot && !u.deleted && u.id !== "USLACKBOT" && u.id !== userId
    );

    const { matched, unmatched } = matchNamesToMembers(text, members);

    if (matched.length === 0) {
      await send(client, userId, `I couldn't find those names in the workspace. Could you try again? Just type their names separated by commas.`);
      return;
    }

    if (unmatched.length > 0) {
      const skipped = unmatched.map((n) => `*${n}*`).join(", ");
      await send(client, userId, `Heads up — I couldn't find ${skipped}, so I'll skip them.`);
    }

    const updated = await db.updateRequest(teamId, activeRequest.id, {
      candidates:   matched.map((m) => m.id),
      currentIndex: 0,
    });

    await send(client, userId, result.message);
    await reachOutToNext(client, teamId, updated);
  }

  else if (result.action === "candidate_continue") {
    // Append exchange to history and wait for next reply
    const history = [
      ...(candidateOf.conversationHistory || []),
      { role: "user",      content: text },
      { role: "assistant", content: result.message },
    ];
    await db.updateRequest(teamId, candidateOf.id, { conversationHistory: history });
    await send(client, userId, result.message);
  }

  else if (result.action === "candidate_accepted") {
    await db.updateRequest(teamId, candidateOf.id, {
      status:     "accepted",
      acceptedBy: userId,
    });
    await send(client, userId, result.message);

    // Notify the requester
    if (result.notifyRequesterId || candidateOf.requesterId) {
      const requesterId = result.notifyRequesterId || candidateOf.requesterId;
      const notifyMsg   = result.notifyRequesterMessage ||
        `Great news — ${userName} can cover your shift! You're all set.`;
      await send(client, requesterId, notifyMsg);
    }
  }

  else if (result.action === "candidate_declined") {
    await send(client, userId, result.message);

    const updated = await db.updateRequest(teamId, candidateOf.id, {
      currentIndex:          candidateOf.currentIndex + 1,
      currentAskedUserId:    null,
      currentAskedChannelId: null,
      conversationHistory:   [],
    });
    await reachOutToNext(client, teamId, updated);
  }

  else if (result.action === "outreach_exhausted") {
    await send(client, userId, result.message);
    await db.updateRequest(teamId, activeRequest.id, { status: "exhausted" });
  }
}

/**
 * Reach out to the next candidate on the list using the AI to write the message.
 */
async function reachOutToNext(client, teamId, request) {
  const { candidates, currentIndex, requesterId, shiftDetails } = request;

  if (currentIndex >= candidates.length) {
    await db.updateRequest(teamId, request.id, { status: "exhausted" });
    await send(client, requesterId, `I reached out to everyone on your list but no one was available for your ${shiftDetails.date || ""} shift. You may want to contact your manager.`);
    return;
  }

  const candidateId   = candidates[currentIndex];
  const requesterName = await getUserName(client, requesterId);
  const candidateName = await getUserName(client, candidateId);

  // Ask Claude to write a natural opening message
  const openingResult = await runAgent({
    whoIsMessaging: "ShiftSwap Bot",
    task:           "write_opening",
    requesterName,
    candidateName,
    shiftDetails,
    instruction:    `Write a short, casual opening message to ${candidateName} asking if they can cover a shift for ${requesterName}. 1-2 sentences, sound like a real person.`,
  });

  const openingMessage = openingResult.message || `Hey ${candidateName}, any chance you could cover a shift for ${requesterName}?`;

  const candidateChannel = await openDM(client, candidateId);
  await client.chat.postMessage({ channel: candidateChannel, text: openingMessage });

  await db.updateRequest(teamId, request.id, {
    status:                "pending",
    currentAskedUserId:    candidateId,
    currentAskedChannelId: candidateChannel,
    conversationHistory:   [{ role: "assistant", content: openingMessage }],
  });

  await send(client, requesterId, `I just reached out to *${candidateName}* — I'll keep you posted!`);
}

/**
 * Use Claude to extract shift details from free text.
 */
async function parseShiftFromText(text) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system: `Extract shift details from the message. Return ONLY a JSON object:
{
  "date": "string or null",
  "time": "string or null",
  "role": "string or null",
  "reason": "string or null"
}`,
    messages: [{ role: "user", content: text }],
  });
  try {
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return { date: null, time: null, role: null, reason: null };
  }
}

module.exports = { handleMessage };
