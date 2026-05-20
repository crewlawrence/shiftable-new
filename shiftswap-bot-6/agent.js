const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-haiku-4-5-20251001";

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
  console.log("🔄 Member cache refreshed: " + members.length + " members");
  return members.filter(m => m.id !== excludeId);
}

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

async function think(prompt) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = res.content[0].text.trim();
  console.log("🤖 Claude raw: " + raw.slice(0, 300));
  try {
    const clean = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error("❌ JSON parse failed:", e.message);
    return { action: "reply", message: raw };
  }
}

async function handleMessage({ teamId, message, client }) {
  const userId = message.user;
  const text   = message.text || "";
  console.log("📨 [" + teamId + "] " + userId + ": " + text.slice(0, 80));

  const [userName, activeRequest, candidateRequest, members] = await Promise.all([
    getUserName(client, userId),
    db.getActiveRequestForUser(teamId, userId),
    db.getRequestForCandidate(teamId, userId),
    getCachedMembers(client, teamId, userId),
  ]);

  if (candidateRequest) {
    const requesterName = await getUserName(client, candidateRequest.requesterId);
    const shift = candidateRequest.shiftDetails || {};
    const history = (candidateRequest.conversationHistory || [])
      .map(m => (m.role === "assistant" ? "You" : userName) + ": " + m.content)
      .join("\n");

    const result = await think(
      "You are ShiftSwap, a friendly Slack bot. You are talking to " + userName + " to see if they can cover a shift for " + requesterName + ".\n" +
      "Shift: " + (shift.date || "unknown date") + ", " + (shift.time || "unknown time") + (shift.role ? ", " + shift.role : "") + ".\n\n" +
      "Previous messages:\n" + (history || "(none yet)") + "\n\n" +
      userName + " just said: \"" + text + "\"\n\n" +
      "Respond naturally and warmly. Decide if they accepted or declined.\n\n" +
      "Return ONLY valid JSON, no markdown fences, no extra text:\n" +
      "{\"action\": \"accepted\" or \"declined\" or \"undecided\", \"message\": \"your reply\"}\n\n" +
      "accepted = yes/sure/I can/yeah/no problem/I'm free\n" +
      "declined = no/can't/busy/sorry/have plans/not available"
    );

    const updatedHistory = [
      ...(candidateRequest.conversationHistory || []),
      { role: "user", content: text },
      { role: "assistant", content: result.message || "" },
    ];

    await db.updateRequest(teamId, candidateRequest.id, { conversationHistory: updatedHistory });
    await send(client, userId, result.message || "Got it!");
    console.log("🤖 Candidate action: " + result.action);

    if (result.action === "accepted") {
      await db.updateRequest(teamId, candidateRequest.id, { status: "accepted", acceptedBy: userId });
      await send(client, candidateRequest.requesterId, "Great news — " + userName + " can cover your shift! You're all set 🎉");
    } else if (result.action === "declined") {
      const updated = await db.updateRequest(teamId, candidateRequest.id, {
        currentIndex: candidateRequest.currentIndex + 1,
        currentAskedUserId: null,
        currentAskedChannelId: null,
        conversationHistory: [],
      });
      await reachOutToNext(client, teamId, updated);
    }
    return;
  }

  const memberNames = members.map(m => m.name).join(", ");
  const history = (activeRequest?.conversationHistory || [])
    .map(m => (m.role === "assistant" ? "ShiftSwap" : userName) + ": " + m.content)
    .join("\n");

  const shiftOnFile = activeRequest
    ? "Shift saved: date=" + (activeRequest.shiftDetails?.date || "?") + " time=" + (activeRequest.shiftDetails?.time || "?")
    : "No shift saved yet.";

  const result = await think(
    "You are ShiftSwap, a friendly AI in Slack helping " + userName + " find shift coverage.\n" +
    "Workspace members: " + (memberNames || "none") + "\n" +
    shiftOnFile + "\n" +
    (activeRequest?.status === "pending" ? "Outreach is currently in progress.\n" : "") + "\n" +
    "Conversation so far:\n" + (history || "(first message)") + "\n\n" +
    userName + " just said: \"" + text + "\"\n\n" +
    "Reply warmly (1-3 sentences). Decide what action to take.\n\n" +
    "Return ONLY valid JSON, no markdown fences, no extra text:\n" +
    "{\"action\": \"save_shift\" or \"start_outreach\" or \"reply\", \"message\": \"your reply\", \"shift\": {\"date\": \"...\", \"time\": \"...\", \"role\": null, \"reason\": null}, \"names\": [\"name1\", \"name2\"]}\n\n" +
    "save_shift = message contains a specific date AND time (no shift saved yet)\n" +
    "start_outreach = shift IS already saved AND message contains names of people to contact\n" +
    "reply = everything else\n\n" +
    "For names: extract every person mentioned. Be generous — include first names, usernames, handles."
  );

  console.log("🤖 Requester action: " + result.action + " | names: " + JSON.stringify(result.names) + " | shift: " + JSON.stringify(result.shift));

  const updatedHistory = [
    ...(activeRequest?.conversationHistory || []),
    { role: "user", content: text },
    { role: "assistant", content: result.message || "" },
  ];

  await send(client, userId, result.message || "How can I help?");

  if (result.action === "save_shift" && !activeRequest) {
    const req = await db.createRequest(teamId, userId, result.shift || {}, []);
    await db.updateRequest(teamId, req.id, { conversationHistory: updatedHistory });

  } else if (result.action === "start_outreach" && activeRequest) {
    const nameList = result.names || [];
    console.log("🔍 Matching: " + JSON.stringify(nameList) + " against: " + JSON.stringify(members.map(m => m.name)));

    const matched = nameList
      .map(name => {
        const lower = name.toLowerCase().trim();
        return members.find(m =>
          m.name.toLowerCase() === lower ||
          m.name.toLowerCase().split(" ")[0] === lower ||
          m.name.toLowerCase().includes(lower) ||
          lower.includes(m.name.toLowerCase().split(" ")[0])
        );
      })
      .filter(Boolean)
      .filter((m, i, arr) => arr.findIndex(x => x.id === m.id) === i);

    console.log("✅ Matched: " + JSON.stringify(matched));

    if (matched.length === 0) {
      await send(client, userId, "I couldn't match those names to anyone in the workspace. Available members: " + memberNames + ". Could you try again?");
      return;
    }

    const updated = await db.updateRequest(teamId, activeRequest.id, {
      candidates: matched.map(m => m.id),
      currentIndex: 0,
      conversationHistory: updatedHistory,
    });
    await reachOutToNext(client, teamId, updated);

  } else if (activeRequest) {
    await db.updateRequest(teamId, activeRequest.id, { conversationHistory: updatedHistory });
  }
}

async function reachOutToNext(client, teamId, request) {
  const { candidates, currentIndex, requesterId, shiftDetails } = request;

  if (currentIndex >= candidates.length) {
    await db.updateRequest(teamId, request.id, { status: "exhausted" });
    await send(client, requesterId, "I reached out to everyone on your list but no one was available. You may want to contact your manager.");
    return;
  }

  const candidateId = candidates[currentIndex];
  const [requesterName, candidateName] = await Promise.all([
    getUserName(client, requesterId),
    getUserName(client, candidateId),
  ]);

  const result = await think(
    "Write a short casual warm Slack message to " + candidateName + " asking if they can cover a shift for " + requesterName + ".\n" +
    "Shift: " + (shiftDetails?.date || "") + " " + (shiftDetails?.time || "") + (shiftDetails?.role ? ", " + shiftDetails.role : "") + ".\n" +
    "1-2 sentences. Sound like a real person.\n\n" +
    "You MUST return valid JSON. Do not use markdown fences. Return exactly:\n{\"action\": \"reply\", \"message\": \"your message here\"}"
  );

  const openingMessage = (typeof result.message === "string" && result.message.trim())
    ? result.message.trim()
    : "Hey " + candidateName + ", any chance you can cover a shift for " + requesterName + "?";
  const candidateChannel = await openDM(client, candidateId);
  await client.chat.postMessage({ channel: candidateChannel, text: openingMessage });

  await db.updateRequest(teamId, request.id, {
    status: "pending",
    currentAskedUserId: candidateId,
    currentAskedChannelId: candidateChannel,
    conversationHistory: [{ role: "assistant", content: openingMessage }],
  });

  await send(client, requesterId, "I just reached out to *" + candidateName + "* — I'll keep you posted!");
  console.log("📤 Reached out to " + candidateName + " (" + candidateId + ")");
}

module.exports = { handleMessage };
