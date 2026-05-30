const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-haiku-4-5-20251001";

const { WebClient } = require("@slack/web-api");

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
  console.log("Member cache refreshed: " + members.length + " members");
  return members.filter(m => m.id !== excludeId);
}

async function getUserName(client, userId) {
  try {
    const res = await client.users.info({ user: userId });
    return res.user.real_name || res.user.name;
  } catch (e) {
    return "a teammate";
  }
}

async function send(client, userId, text) {
  try {
    const res = await client.conversations.open({ users: userId });
    await client.chat.postMessage({ channel: res.channel.id, text });
    console.log("Sent to " + userId);
  } catch (err) {
    console.error("send failed for " + userId + ": " + err.message);
    try {
      await client.chat.postMessage({ channel: userId, text });
    } catch (err2) {
      console.error("Direct send also failed: " + err2.message);
    }
  }
}

async function sendToCandidate(client, candidateId, candidateName, text) {
  // If a user token is configured, use it — messages come from a real person
  // and can reach anyone in the workspace without restrictions
  if (process.env.SLACK_USER_TOKEN) {
    try {
      const userClient = new WebClient(process.env.SLACK_USER_TOKEN);
      const res = await userClient.conversations.open({ users: candidateId });
      await userClient.chat.postMessage({ channel: res.channel.id, text });
      console.log("Sent to " + candidateName + " via user token");
      return res.channel.id;
    } catch (err) {
      console.error("User token send failed: " + err.message + " — falling back to bot token");
    }
  }

  // Fallback: try bot DM
  try {
    const res = await client.conversations.open({ users: candidateId });
    await client.chat.postMessage({ channel: res.channel.id, text });
    console.log("DM sent to " + candidateName + " via bot token");
    return res.channel.id;
  } catch (err) {
    console.log("Bot DM failed for " + candidateName + ": " + err.message);
  }

  // Last resort: shared channel with mention
  try {
    const listRes = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    });
    for (const ch of listRes.channels || []) {
      try {
        const membersRes = await client.conversations.members({ channel: ch.id, limit: 200 });
        if ((membersRes.members || []).includes(candidateId)) {
          await client.chat.postMessage({
            channel: ch.id,
            text: "<@" + candidateId + "> " + text,
          });
          console.log("Sent to " + candidateName + " via #" + ch.name);
          return ch.id;
        }
      } catch (chErr) {
        // skip channel
      }
    }
  } catch (err) {
    console.error("Channel search failed: " + err.message);
  }

  console.error("Could not reach " + candidateName + " by any method");
  return null;
}

async function think(prompt) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = res.content[0].text.trim();
  console.log("Claude: " + raw.slice(0, 200));
  try {
    const clean = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    return { action: "reply", message: raw };
  }
}

async function handleMessage({ teamId, message, client }) {
  const userId = message.user;
  const text = message.text || "";
  console.log("MSG [" + teamId + "] " + userId + ": " + text.slice(0, 80));

  const [userName, activeRequest, candidateRequest, members] = await Promise.all([
    getUserName(client, userId),
    db.getActiveRequestForUser(teamId, userId),
    db.getRequestForCandidate(teamId, userId),
    getCachedMembers(client, teamId, userId),
  ]);

  // Candidate path
  if (candidateRequest) {
    const requesterName = await getUserName(client, candidateRequest.requesterId);
    const shift = candidateRequest.shiftDetails || {};
    const history = (candidateRequest.conversationHistory || [])
      .map(m => (m.role === "assistant" ? "You" : userName) + ": " + m.content)
      .join("\n");

    const result = await think(
      "You are sending Slack messages AS " + requesterName + " to " + userName + " about covering a shift.\n" +
      "Write in FIRST PERSON as " + requesterName + " — use 'I', 'my', 'me'. Never refer to " + requesterName + " in third person.\n" +
      "Shift: " + (shift.date || "unknown") + ", " + (shift.time || "unknown") + (shift.role ? ", " + shift.role : "") + ".\n\n" +
      "Previous messages:\n" + (history || "(none)") + "\n\n" +
      userName + " just said: \"" + text + "\"\n\n" +
      "Reply naturally in 1-3 sentences. Return ONLY valid JSON no markdown:\n" +
      "{\"action\":\"accepted\",\"message\":\"...\"} or {\"action\":\"declined\",\"message\":\"...\"} or {\"action\":\"undecided\",\"message\":\"...\"}\n\n" +
      "accepted = yes/sure/I can/yeah/no problem/I am free\n" +
      "declined = no/cant/busy/sorry/have plans/not available"
    );

    const updatedHistory = [
      ...(candidateRequest.conversationHistory || []),
      { role: "user", content: text },
      { role: "assistant", content: result.message || "" },
    ];

    await db.updateRequest(teamId, candidateRequest.id, { conversationHistory: updatedHistory });
    await send(client, userId, result.message || "Got it!");
    console.log("Candidate action: " + result.action);

    if (result.action === "accepted") {
      await db.updateRequest(teamId, candidateRequest.id, { status: "accepted", acceptedBy: userId });
      await send(client, candidateRequest.requesterId, "Great news — " + userName + " can cover your shift! You are all set!");
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

  // Requester path
  const memberNames = members.map(m => m.name).join(", ");
  const history = (activeRequest && activeRequest.conversationHistory || [])
    .map(m => (m.role === "assistant" ? "ShiftSwap" : userName) + ": " + m.content)
    .join("\n");

  const shiftOnFile = activeRequest
    ? "Shift saved: date=" + (activeRequest.shiftDetails && activeRequest.shiftDetails.date || "?") + " time=" + (activeRequest.shiftDetails && activeRequest.shiftDetails.time || "?")
    : "No shift saved yet.";

  const result = await think(
    "You are ShiftSwap, a friendly AI in Slack helping " + userName + " find shift coverage.\n" +
    "Workspace members: " + (memberNames || "none") + "\n" +
    shiftOnFile + "\n" +
    (activeRequest && activeRequest.status === "pending" ? "Outreach is in progress.\n" : "") + "\n" +
    "Conversation:\n" + (history || "(first message)") + "\n\n" +
    userName + " just said: \"" + text + "\"\n\n" +
    "Reply warmly in 1-3 sentences. Return ONLY valid JSON no markdown:\n" +
    "{\"action\":\"save_shift\",\"message\":\"...\",\"shift\":{\"date\":\"...\",\"time\":\"...\",\"role\":null,\"reason\":null},\"names\":[]}\n" +
    "OR {\"action\":\"start_outreach\",\"message\":\"...\",\"shift\":null,\"names\":[\"name1\"]}\n" +
    "OR {\"action\":\"reply\",\"message\":\"...\",\"shift\":null,\"names\":[]}\n\n" +
    "save_shift = message has a date AND time, no shift saved yet\n" +
    "start_outreach = shift already saved AND message has names to contact\n" +
    "reply = everything else\n" +
    "For names extract every person mentioned including usernames and first names."
  );

  console.log("Requester action: " + result.action + " names: " + JSON.stringify(result.names) + " shift: " + JSON.stringify(result.shift));

  const updatedHistory = [
    ...(activeRequest && activeRequest.conversationHistory || []),
    { role: "user", content: text },
    { role: "assistant", content: result.message || "" },
  ];

  await send(client, userId, result.message || "How can I help?");

  if (result.action === "save_shift") {
    if (activeRequest) {
      // Update the existing request with new shift details
      await db.updateRequest(teamId, activeRequest.id, {
        conversationHistory: updatedHistory,
      });
      // Update shift details directly via a separate call
      await db.updateShiftDetails(teamId, activeRequest.id, result.shift || {});
    } else {
      const req = await db.createRequest(teamId, userId, result.shift || {}, []);
      await db.updateRequest(teamId, req.id, { conversationHistory: updatedHistory });
    }
  } else if (result.action === "start_outreach" && activeRequest) {
    const nameList = result.names || [];
    const matched = nameList
      .map(function(name) {
        const lower = name.toLowerCase().trim();
        return members.find(function(m) {
          return m.name.toLowerCase() === lower ||
            m.name.toLowerCase().split(" ")[0] === lower ||
            m.name.toLowerCase().includes(lower) ||
            lower.includes(m.name.toLowerCase().split(" ")[0]);
        });
      })
      .filter(Boolean)
      .filter(function(m, i, arr) {
        return arr.findIndex(function(x) { return x.id === m.id; }) === i;
      });

    if (matched.length === 0) {
      await send(client, userId, "I could not match those names. Available members: " + memberNames + ". Try again?");
      return;
    }

    const updated = await db.updateRequest(teamId, activeRequest.id, {
      candidates: matched.map(function(m) { return m.id; }),
      currentIndex: 0,
      conversationHistory: updatedHistory,
    });
    // reachOutToNext sends its own "I just reached out to X" message — don't send separately
    await reachOutToNext(client, teamId, updated);
  } else if (activeRequest) {
    await db.updateRequest(teamId, activeRequest.id, { conversationHistory: updatedHistory });
  }
}

async function reachOutToNext(client, teamId, request) {
  const candidates = request.candidates;
  const currentIndex = request.currentIndex;
  const requesterId = request.requesterId;
  const shiftDetails = request.shiftDetails;

  if (currentIndex >= candidates.length) {
    await db.updateRequest(teamId, request.id, { status: "exhausted" });
    await send(client, requesterId, "I reached out to everyone on your list but no one was available. You may want to contact your manager.");
    return;
  }

  const candidateId = candidates[currentIndex];
  const requesterName = await getUserName(client, requesterId);
  const candidateName = await getUserName(client, candidateId);

  const result = await think(
    "Write a short casual Slack message FROM " + requesterName + " TO " + candidateName + " asking if they can cover a shift.\n" +
    "Write in FIRST PERSON as " + requesterName + " — use 'I', 'my', 'me'. Do NOT refer to " + requesterName + " in third person.\n" +
    "Shift details (use EXACTLY these, do not change or invent anything):\n" +
    "- Date: " + (shiftDetails && shiftDetails.date || "unknown") + "\n" +
    "- Time: " + (shiftDetails && shiftDetails.time || "unknown") + "\n" +
    (shiftDetails && shiftDetails.role ? "- Role: " + shiftDetails.role + "\n" : "") +
    (shiftDetails && shiftDetails.reason ? "- Reason: " + shiftDetails.reason + "\n" : "") +
    "\nIMPORTANT: Do NOT invent or assume any reason (sickness, plans, etc.) unless it is listed above.\n" +
    "Keep it simple and friendly. 1-2 sentences.\n\n" +
    "Return ONLY valid JSON no markdown fences:\n{\"action\":\"reply\",\"message\":\"your message here\"}"
  );

  const openingMessage = (result.message && result.message.trim())
    ? result.message.trim()
    : "Hey " + candidateName + ", any chance you can cover a shift for " + requesterName + "?";

  const deliveredChannel = await sendToCandidate(client, candidateId, candidateName, openingMessage);

  if (!deliveredChannel) {
    await send(client, requesterId, "I could not reach " + candidateName + " — please add ShiftSwap to a channel they are in. Skipping.");
    const updated = await db.updateRequest(teamId, request.id, {
      currentIndex: currentIndex + 1,
      currentAskedUserId: null,
      currentAskedChannelId: null,
      conversationHistory: [],
    });
    await reachOutToNext(client, teamId, updated);
    return;
  }

  await db.updateRequest(teamId, request.id, {
    status: "pending",
    currentAskedUserId: candidateId,
    currentAskedChannelId: deliveredChannel,
    conversationHistory: [{ role: "assistant", content: openingMessage }],
  });

  await send(client, requesterId, "I just reached out to *" + candidateName + "* — I will keep you posted!");
  console.log("Reached out to " + candidateName + " via " + deliveredChannel);
}

module.exports = { handleMessage };
