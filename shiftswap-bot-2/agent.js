const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-haiku-4-5-20251001";

// ─── Pure Slack helpers (no logic) ───────────────────────────────────────────

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
  return ch;
}

async function getWorkspaceMembers(client, excludeId) {
  const res = await client.users.list();
  return res.members
    .filter(u => !u.is_bot && !u.deleted && u.id !== "USLACKBOT" && u.id !== excludeId)
    .map(u => ({ id: u.id, name: u.real_name || u.name }));
}

// ─── The AI brain ─────────────────────────────────────────────────────────────
//
// Claude receives the ENTIRE conversation so far as real messages,
// plus a system prompt that describes what tools it has available.
// It responds in plain text — exactly what gets sent to the user.
// When it needs to trigger a side effect (save shift, start outreach,
// mark accepted/declined) it appends a single <action> XML tag at the end.
// The code below just strips the tag, sends the text, and performs the action.
// No routing. No branching. Claude drives everything.

async function runAgent(systemPrompt, conversationHistory) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: systemPrompt,
    messages: conversationHistory,
  });

  const raw = response.content[0].text.trim();

  // Extract optional action tag: <action>{"type":"...","data":{...}}</action>
  const actionMatch = raw.match(/<action>([\s\S]*?)<\/action>/);
  const text = raw.replace(/<action>[\s\S]*?<\/action>/, "").trim();

  let action = null;
  if (actionMatch) {
    try { action = JSON.parse(actionMatch[1].trim()); } catch { /* ignore */ }
  }

  return { text, action };
}

// ─── System prompts ───────────────────────────────────────────────────────────

function requesterSystemPrompt(userName, members, activeRequest) {
  const memberList = members.map(m => m.name).join(", ");
  return `You are ShiftSwap, a warm and casual AI assistant in Slack that helps ${userName} find someone to cover their shift. Talk like a real helpful colleague — never robotic, never formal.

Your job in this conversation:
1. If you don't know the shift details yet, ask naturally.
2. Once you understand the shift, ask who they want you to reach out to. Tell them to just type names separated by commas.
3. When they give names, confirm and start outreach.

Workspace members you can reach: ${memberList || "none found"}
${activeRequest ? `Current shift request: ${JSON.stringify(activeRequest.shiftDetails)}` : "No active shift request yet."}
${activeRequest?.status === "pending" ? `Currently reaching out to someone — reassure ${userName} you're on it.` : ""}
${activeRequest?.status === "exhausted" ? `Everyone was contacted and no one is available.` : ""}

When you have enough information to take an action, append ONE of these tags at the very end of your message (after your spoken reply):

To save shift details and ask for names:
<action>{"type":"save_shift","data":{"date":"...","time":"...","role":"...","reason":"..."}}</action>

To start reaching out (when they give names):
<action>{"type":"start_outreach","data":{"names":["Alex","Jordan"]}}</action>

Rules:
- Never show the action tags to the user — they go at the very end, after your message.
- Never mention you're an AI or a bot.
- Keep messages short: 1-3 sentences.
- Only emit an action when you're confident you have what you need.`;
}

function candidateSystemPrompt(candidateName, requesterName, shiftDetails, conversationHistory) {
  return `You are ShiftSwap, a friendly Slack bot having a conversation with ${candidateName} to find out if they can cover a shift for ${requesterName}.

Shift details:
- Date: ${shiftDetails?.date || "not specified"}
- Time: ${shiftDetails?.time || "not specified"}
${shiftDetails?.role ? `- Role: ${shiftDetails.role}` : ""}
${shiftDetails?.reason ? `- Reason: ${shiftDetails.reason}` : ""}

Previous conversation:
${conversationHistory.map(m => `${m.role === "assistant" ? "You" : candidateName}: ${m.content}`).join("\n")}

Talk like a real person — casual, warm, brief (1-3 sentences). Answer their questions. Gently encourage if hesitant, never pressure.

When the outcome is clear, append ONE tag at the very end of your message:

If they said yes (directly or indirectly — "sure", "I'm free", "no problem", "yeah"):
<action>{"type":"accepted"}</action>

If they said no (directly or indirectly — "can't", "busy", "plans", "sorry", "no"):
<action>{"type":"declined"}</action>

If still unclear, just reply naturally with no action tag.

Never show the tags to ${candidateName}.`;
}

// ─── Main handler — no if/else routing ───────────────────────────────────────

async function handleMessage({ teamId, message, client }) {
  const userId = message.user;
  const text   = message.text || "";

  console.log(`📨 [${teamId}] ${userId}: ${text.slice(0, 80)}`);

  // Load all context from DB
  const [userName, activeRequest, candidateRequest] = await Promise.all([
    getUserName(client, userId),
    db.getActiveRequestForUser(teamId, userId),
    db.getRequestForCandidate(teamId, userId),
  ]);

  // ── Path A: This person is a candidate mid-conversation ──────────────────

  if (candidateRequest) {
    const history = [
      ...(candidateRequest.conversationHistory || []),
      { role: "user", content: text },
    ];

    const requesterName = await getUserName(client, candidateRequest.requesterId);
    const sysPrompt     = candidateSystemPrompt(userName, requesterName, candidateRequest.shiftDetails, candidateRequest.conversationHistory || []);
    const { text: reply, action } = await runAgent(sysPrompt, [{ role: "user", content: text }]);

    console.log(`🤖 Candidate reply | action: ${action?.type || "none"}`);

    // Save updated history
    await db.updateRequest(teamId, candidateRequest.id, {
      conversationHistory: [...history, { role: "assistant", content: reply }],
    });

    await send(client, userId, reply);

    if (action?.type === "accepted") {
      await db.updateRequest(teamId, candidateRequest.id, { status: "accepted", acceptedBy: userId });
      await send(client, candidateRequest.requesterId,
        `Great news! ${userName} can cover your shift. You're all set! 🎉`);

    } else if (action?.type === "declined") {
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

  // ── Path B: This person is the requester ─────────────────────────────────

  // Build the full conversation history for this requester session
  const history = [
    ...(activeRequest?.conversationHistory || []),
    { role: "user", content: text },
  ];

  const members   = await getWorkspaceMembers(client, userId);
  const sysPrompt = requesterSystemPrompt(userName, members, activeRequest);
  const { text: reply, action } = await runAgent(sysPrompt, history);

  console.log(`🤖 Requester reply | action: ${action?.type || "none"}`);

  await send(client, userId, reply);

  // Save updated history into the active request (or a temp store)
  const updatedHistory = [...history, { role: "assistant", content: reply }];

  if (action?.type === "save_shift") {
    // Claude parsed the shift — create the DB record
    const req = await db.createRequest(teamId, userId, action.data, []);
    await db.updateRequest(teamId, req.id, { conversationHistory: updatedHistory });

  } else if (action?.type === "start_outreach") {
    if (!activeRequest) {
      await send(client, userId, `Let me get your shift details first — what date and time is the shift?`);
      return;
    }

    // Match the names Claude extracted to real workspace members
    const nameList = action.data?.names || [];
    const matched  = nameList
      .map(name => {
        const lower = name.toLowerCase();
        return members.find(m =>
          m.name.toLowerCase() === lower ||
          m.name.toLowerCase().split(" ")[0] === lower
        );
      })
      .filter(Boolean)
      .filter((m, i, arr) => arr.findIndex(x => x.id === m.id) === i); // dedupe

    if (matched.length === 0) {
      await send(client, userId, `I couldn't find those names in the workspace — could you try again?`);
      return;
    }

    const updated = await db.updateRequest(teamId, activeRequest.id, {
      candidates:          matched.map(m => m.id),
      currentIndex:        0,
      conversationHistory: updatedHistory,
    });

    await reachOutToNext(client, teamId, updated);

  } else if (activeRequest) {
    // No action — just save the updated conversation history
    await db.updateRequest(teamId, activeRequest.id, { conversationHistory: updatedHistory });
  }
}

// ─── Proactive outreach — Claude writes the opening message ──────────────────

async function reachOutToNext(client, teamId, request) {
  const { candidates, currentIndex, requesterId, shiftDetails } = request;

  if (currentIndex >= candidates.length) {
    await db.updateRequest(teamId, request.id, { status: "exhausted" });
    await send(client, requesterId,
      `I reached out to everyone on your list but no one was available for the ${shiftDetails?.date || ""} shift. You may want to contact your manager.`);
    return;
  }

  const candidateId   = candidates[currentIndex];
  const [requesterName, candidateName] = await Promise.all([
    getUserName(client, requesterId),
    getUserName(client, candidateId),
  ]);

  // Claude writes the opening message entirely on its own
  const openingSysPrompt = `You are ShiftSwap, a friendly Slack assistant. Write a single casual, warm opening message to ${candidateName} asking if they can cover a shift for ${requesterName}.
Shift: ${shiftDetails?.date || ""} ${shiftDetails?.time || ""}${shiftDetails?.role ? `, ${shiftDetails.role}` : ""}${shiftDetails?.reason ? `. Reason: ${shiftDetails.reason}` : ""}.
Keep it to 1-2 sentences. Sound like a real person. Return ONLY the message, no tags.`;

  const { text: openingMessage } = await runAgent(openingSysPrompt, [
    { role: "user", content: "Write the opening message now." }
  ]);

  const candidateChannel = await openDM(client, candidateId);
  await client.chat.postMessage({ channel: candidateChannel, text: openingMessage });

  await db.updateRequest(teamId, request.id, {
    status:                "pending",
    currentAskedUserId:    candidateId,
    currentAskedChannelId: candidateChannel,
    conversationHistory:   [{ role: "assistant", content: openingMessage }],
  });

  await send(client, requesterId, `I just reached out to *${candidateName}* — I'll let you know what they say!`);
  console.log(`📤 Reached out to ${candidateName} (${candidateId})`);
}

module.exports = { handleMessage };
