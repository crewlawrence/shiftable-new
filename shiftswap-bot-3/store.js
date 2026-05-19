const { pool } = require("./turso");

async function saveInstallation(installation) {
  await pool.query(`
    INSERT INTO installations (team_id, team_name, bot_token, bot_user_id, installed_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (team_id) DO UPDATE SET
      team_name    = EXCLUDED.team_name,
      bot_token    = EXCLUDED.bot_token,
      bot_user_id  = EXCLUDED.bot_user_id,
      installed_at = EXCLUDED.installed_at
  `, [
    installation.teamId,
    installation.teamName,
    installation.botToken,
    installation.botUserId,
    installation.installedAt || new Date().toISOString(),
  ]);
  console.log(`✅ Installed for team: ${installation.teamName} (${installation.teamId})`);
}

async function getInstallation(teamId) {
  const res = await pool.query(
    "SELECT * FROM installations WHERE team_id = $1", [teamId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    teamId:      row.team_id,
    teamName:    row.team_name,
    botToken:    row.bot_token,
    botUserId:   row.bot_user_id,
    installedAt: row.installed_at,
  };
}

async function deleteInstallation(teamId) {
  await pool.query("DELETE FROM installations WHERE team_id = $1", [teamId]);
}

async function getAllTeamIds() {
  const res = await pool.query("SELECT team_id FROM installations");
  return res.rows.map((r) => r.team_id);
}

module.exports = { saveInstallation, getInstallation, deleteInstallation, getAllTeamIds };
