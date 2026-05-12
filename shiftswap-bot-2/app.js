const { App, ExpressReceiver } = require("@slack/bolt");
const { WebClient } = require("@slack/web-api");
const { handleMessage } = require("./agent");
const { saveInstallation, getInstallation, deleteInstallation } = require("./store");
const { migrate } = require("./turso");

// ─── OAuth receiver ───────────────────────────────────────────────────────────

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId:      process.env.SLACK_CLIENT_ID,
  clientSecret:  process.env.SLACK_CLIENT_SECRET,
  stateSecret:   process.env.SLACK_STATE_SECRET,
  scopes: [
    "chat:write",
    "im:write",
    "im:read",
    "im:history",
    "users:read",
    "channels:read",
    "mpim:write",
  ],
  installerOptions: {
    redirectUriPath: "/slack/oauth_redirect",
    stateVerification: false,
    callbackOptions: {
      success: (installation, installOptions, req, res) => {
        res.send(`
          <html><body style="font-family:sans-serif;text-align:center;padding:60px">
            <h1>✅ ShiftSwap Bot installed!</h1>
            <p>Head back to Slack and DM <strong>ShiftSwap Bot</strong> to get started.</p>
          </body></html>
        `);
      },
      failure: (error, installOptions, req, res) => {
        console.error("OAuth failure:", error);
        res.status(500).send(`
          <html><body style="font-family:sans-serif;text-align:center;padding:60px">
            <h1>❌ Installation failed</h1><p>${error.message}</p>
          </body></html>
        `);
      },
    },
  },
  installationStore: {
    storeInstallation: async (installation) => {
      await saveInstallation({
        teamId:      installation.team.id,
        teamName:    installation.team.name,
        botToken:    installation.bot.token,
        botUserId:   installation.bot.userId,
        installedAt: new Date().toISOString(),
      });
    },
    fetchInstallation: async (installQuery) => {
      const record = await getInstallation(installQuery.teamId);
      if (!record) throw new Error(`No installation found for team ${installQuery.teamId}`);
      return {
        team: { id: record.teamId, name: record.teamName },
        bot:  { token: record.botToken, userId: record.botUserId },
      };
    },
    deleteInstallation: async (installQuery) => {
      await deleteInstallation(installQuery.teamId);
    },
  },
});

// ─── Bolt app ─────────────────────────────────────────────────────────────────

const app = new App({ receiver });

// ─── Install landing page ─────────────────────────────────────────────────────

receiver.router.get("/", (req, res) => {
  const installUrl = `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&scope=chat%3Awrite%2Cim%3Awrite%2Cim%3Aread%2Cim%3Ahistory%2Cusers%3Aread%2Cchannels%3Aread%2Cmpim%3Awrite&redirect_uri=${encodeURIComponent(process.env.APP_URL + "/slack/oauth_redirect")}`;
  res.send(`
    <html>
    <head>
      <title>ShiftSwap Bot</title>
      <style>
        body { font-family:-apple-system,sans-serif; display:flex; flex-direction:column;
               align-items:center; justify-content:center; min-height:100vh; margin:0; background:#f9f9f9; }
        .card { background:#fff; border-radius:12px; padding:48px; max-width:480px;
                text-align:center; box-shadow:0 4px 24px rgba(0,0,0,.08); }
        h1 { font-size:2rem; margin-bottom:.5rem; }
        p  { color:#555; line-height:1.6; margin-bottom:2rem; }
        a.btn { display:inline-block; background:#4A154B; color:#fff; padding:14px 28px;
                border-radius:8px; text-decoration:none; font-weight:600; font-size:1rem; }
        a.btn:hover { background:#611f69; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🔄 ShiftSwap Bot</h1>
        <p>Need someone to cover your shift? Just DM the bot, tell it your shift details, and it'll reach out to your teammates one by one until someone says yes.</p>
        <a class="btn" href="${installUrl}">
          <img src="https://platform.slack-edge.com/img/add_to_slack.png" height="20" style="vertical-align:middle;margin-right:8px"/>
          Add to Slack
        </a>
      </div>
    </body>
    </html>
  `);
});

// ─── Event handler ────────────────────────────────────────────────────────────

app.message(async ({ message, context }) => {
  if (message.channel_type !== "im") return;
  if (message.bot_id) return;
  if (!message.user) return;

  const teamId = context.teamId;
  const record = await getInstallation(teamId);
  if (!record) { console.error(`No installation for team ${teamId}`); return; }

  const client = new WebClient(record.botToken);
  await handleMessage({ teamId, message, client });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

(async () => {
  await migrate(); // Create tables in Turso if they don't exist
  await app.start(PORT);
  console.log(`⚡️ ShiftSwap Bot running on port ${PORT}`);
  console.log(`🔗 ${process.env.APP_URL || `http://localhost:${PORT}`}`);
})();
