const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-haiku-4-5-20251001";

// ─── Member cache ─────────────────────────────────────────────────────────────

const memberCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function getCachedMembers(client, teamId, excludeId) {
  const cached = memberCache.get(teamId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.members.filter(m => m.id !== excludeId);
  }
  const res = await client.users.list();
  const members = res.members
    .filter(u => !u.is_bot && !u.deleted && u.id !== "USLACKBOT")
    .map(u => ({ id: u.id, name: u.real_name || u.name }));
  memberCache.set(teamId, { members, fetchedAt: Date.now() });
  console.log(`🔄 Member cache refreshed: ${members.length} members`);
  return members.filter(m => m.id !== excludeId);
}

// ─── Slack helpers ────────────────────────────────────────────────────────────

async function getUserName(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    return res.user.real_name || res.user.name;
  } catch { return "a teammate"; }
}

async function openDM(client, userId) {
  const res = await client.conversations.open({ users: userId });
  return res.channel.id;
}

async function send(client, userId, text) {
  const ch = await openDM(client, userId);
  await client.chat.postMessage({ channel: ch, text });
}

// ─── Two-call AI pattern ──────────────────────────────────────────────────────
//
// Call 1: Claude talks to the user naturally (plain text reply)
// Call 2: Claude decides what action to take (forced JSON decision)
//
// Separating these means the action is always explicitly decided,
// never skipped because Claude forgot to append a tag.

async function getReply(systemPrompt, history) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: systemPrompt,
    messages: history,
  });
  return res.content[0].text.trim();
}

async function getAction(conversationSummary, possibleActions) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: `You are a decision engine. Based on the conversation summary, decide which action to take.
Return ONLY a valid JSON object — no markdown, no explanation:
{"action": "<one of the possible actions>", "data": <any relevant extracted data or null>}`,
    messages: [{
      role: "user",
      content: `Conversation summary:\n${conversationSummary}\n\nPossible actions:\n${possibleActions.map(a => `- ${a.name}: ${a.description}`).join("\n")}\n\nWhich action should be taken right now?`
    }],
  });
  try {
    return JSON.parse(res.content[0].text.trim());
  } catch {
    return { action: "none", data: null };
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleMessage({ teamId, message, client }) {
  const userId = message.user;
  const text   = message.text || "";
  console.log(`📨 [${teamId}] ${userId}: ${text.slice(0, 80)}`);

  const [userName, activeRequest, candidateRequest] = await Promise.all([
    getUserName(client, userId),
    db.getActiveRequestForUser(teamId, userId),
    db.getRequestForCandidate(teamId, userId),
  ]);

  // ── Candidate path ────────────────────────────────────────────────────────

  if (candidateRequest) {
    const requesterName = await getUserName(client, candidateRequest.requesterId);
    const history = candidateRequest.conversationHistory || [];

    // Call 1: natural reply
    const replyText = await getReply(
      `You are ShiftSwap, a friendly Slack bot talking to ${userName} about covering a shift for ${requesterName}.
Shift: ${candidateRequest.shiftDetails?.date || ""} ${candidateRequest.shiftDetails?.time || ""}${candidateRequest.shiftDetails?.role ? `, ${candidateRequest.shiftDetails.role}` : ""}.
Be warm, casual, 1-3 sentences. Never mention you're a bot.`,
      [...history, { role: "user", content: text }]
    );

    // Call 2: action decision
    const decision = await getAction(
      `${userName} is being asked to cover a shift for ${requesterName} on ${candidateRequest.shiftDetails?.date || "unknown date"} at ${candidateRequest.shiftDetails?.time || "unknown time"}.
They just said: "${text}"`,
      [
        { name: "accepted",  description: "They clearly agreed to cover the shift (said yes, sure, I can do it, I'm free, no problem, etc.)" },
        { name: "declined",  description: "They clearly said no or are unavailable (said no, can't, busy, have plans, sorry, etc.)" },
        { name: "undecided", description: "Their response is unclear, they asked a question, or they haven't given a clear yes or no yet" },
      ]
    );

    console.log(`🤖 Candidate action: ${decision.action}`);

    const updatedHistory = [...history, { role: "user", content: text }, { role: "assistant", content: replyText }];
    await db.updateRequest(teamId, candidateRequest.id, { conversationHistory: updatedHistory });
    await send(client, userId, replyText);

    if (decision.action === "accepted") {
      await db.updateRequest(teamId, candidateRequest.id, { status: "accepted", acceptedBy: userId });
      await send(client, candidateRequest.requesterId,
        `Great news — ${userName} agreed to cover your shift! You're all set 🎉`);

    } else if (decision.action === "declined") {
      const updated = await db.updateRequest(teamId, candidateRequest.id, {
        currentIndex:          candidateRequest.currentIndex + 1,
        currentAskedUserId:    null,
        currentAskedChannelId: null,
        conversationHistory:   [],
      });
      await reachOutToNext(client, teamId, updated);
    }
    return;
  }

  // ── Requester path ────────────────────────────────────────────────────────

  const members = await getCachedMembers(client, teamId, userId);
  const history = activeRequest?.conversationHistory || [];

  // Call 1: natural reply
  const replyText = await getReply(
    `You are ShiftSwap, a friendly AI in Slack that helps ${userName} find shift coverage.
Workspace members: ${members.map(m => m.name).join(", ") || "none found"}.
${activeRequest ? `Active shift: ${JSON.stringify(activeRequest.shiftDetails)}. Status: ${activeRequest.status}.` : "No active shift request yet."}
Be warm, casual, 1-3 sentences. Never mention you're a bot or an AI.
- If you don't know the shift details yet, ask for them.
- Once you have shift details, ask who to contact (tell them to type names separated by commas).
- If outreach is in progress, reassure them you're on it.`,
    [...history, { role: "user", content: text }]
  );

  // Call 2: action decision
  const fullConversation = [...history, { role: "user", content: text }]
    .map(m => `${m.role === "user" ? userName : "ShiftSwap"}: ${m.content}`)
    .join("\n");

  const decision = await getAction(
    `Conversation between ShiftSwap and ${userName}:\n${fullConversation}`,
    [
      { name: "save_shift",     description: `The conversation contains clear shift details (date AND time). Extract them. Return data as: {"date":"...","time":"...","role":"...or null","reason":"...or null"}` },
      { name: "start_outreach", description: `${userName} has provided a list of names to contact. Extract the names exactly as written. Return data as: {"names":["Name1","Name2"]}` },
      { name: "none",           description: "Not enough info yet, still gathering details, or outreach is already in progress" },
    ]
  );

  console.log(`🤖 Requester action: ${decision.action} | data: ${JSON.stringify(decision.data)}`);

  const updatedHistory = [...history, { role: "user", content: text }, { role: "assistant", content: replyText }];
  await send(client, userId, replyText);

  if (decision.action === "save_shift" && !activeRequest) {
    const req = await db.createRequest(teamId, userId, decision.data, []);
    await db.updateRequest(teamId, req.id, { conversationHistory: updatedHistory });

  } else if (decision.action === "start_outreach" && activeRequest) {
    const nameList = decision.data?.names || [];
    const matched = nameList
      .map(name => {
        const lower = name.toLowerCase().trim();
        return members.find(m =>
          m.name.toLowerCase() === lower ||
          m.name.toLowerCase().split(" ")[0] === lower
        );
      })
      .filter(Boolean)
      .filter((m, i, arr) => arr.findIndex(x => x.id === m.id) === i);

    if (matched.length === 0) {
      await send(client, userId, `I couldn't match those names to anyone in the workspace — could you try again?`);
      return;
    }

    const updated = await db.updateRequest(teamId, activeRequest.id, {
      candidates:          matched.map(m => m.id),
      currentIndex:        0,
      conversationHistory: updatedHistory,
    });
    await reachOutToNext(client, teamId, updated);

  } else if (activeRequest) {
    await db.updateRequest(teamId, activeRequest.id, { conversationHistory: updatedHistory });
  }
}

// ─── Outreach ─────────────────────────────────────────────────────────────────

async function reachOutToNext(client, teamId, request) {
  const { candidates, currentIndex, requesterId, shiftDetails } = request;

  if (currentIndex >= candidates.length) {
    await db.updateRequest(teamId, request.id, { status: "exhausted" });
    await send(client, requesterId,
      `I reached out to everyone on your list but no one was available for the ${shiftDetails?.date || ""} shift. You may want to contact your manager.`);
    return;
  }

  const candidateId = candidates[currentIndex];
  const [requesterName, candidateName] = await Promise.all([
    getUserName(client, requesterId),
    getUserName(client, candidateId),
  ]);

  const openingMessage = await getReply(
    `You are ShiftSwap. Write a single casual, warm message to ${candidateName} asking if they can cover a shift for ${requesterName}.
Shift: ${shiftDetails?.date || ""} ${shiftDetails?.time || ""}${shiftDetails?.role ? `, ${shiftDetails.role}` : ""}${shiftDetails?.reason ? `. Reason: ${shiftDetails.reason}` : ""}.
1-2 sentences. Sound like a real person texting a coworker.`,
    [{ role: "user", content: "Write the message." }]
  );

  const candidateChannel = await openDM(client, candidateId);
  await client.chat.postMessage({ channel: candidateChannel, text: openingMessage });

  await db.updateRequest(teamId, request.id, {
    status:                "pending",
    currentAskedUserId:    candidateId,
    currentAskedChannelId: candidateChannel,
    conversationHistory:   [{ role: "assistant", content: openingMessage }],
  });

  await send(client, requesterId, `I just reached out to *${candidateName}* — I'll keep you posted!`);
  console.log(`📤 Reached out to ${candidateName} (${candidateId})`);
}

module.exports = { handleMessage };
