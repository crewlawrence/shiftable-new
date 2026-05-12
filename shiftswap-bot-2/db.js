const { pool } = require("./turso");

function rowToRequest(row) {
  if (!row) return null;
  return {
    id:                    row.id,
    teamId:                row.team_id,
    requesterId:           row.requester_id,
    shiftDetails:          JSON.parse(row.shift_details),
    candidates:            JSON.parse(row.candidates),
    currentIndex:          Number(row.current_index),
    status:                row.status,
    acceptedBy:            row.accepted_by,
    currentAskedUserId:    row.current_asked_user_id,
    currentAskedChannelId: row.current_asked_channel_id,
    conversationHistory:   JSON.parse(row.conversation_history),
    createdAt:             row.created_at,
  };
}

async function createRequest(teamId, requesterId, shiftDetails, candidates) {
  const id = `${requesterId}-${Date.now()}`;
  await pool.query(`
    INSERT INTO requests
      (id, team_id, requester_id, shift_details, candidates, current_index,
       status, accepted_by, current_asked_user_id, current_asked_channel_id,
       conversation_history, created_at)
    VALUES ($1,$2,$3,$4,$5,0,'awaiting_names',NULL,NULL,NULL,'[]',$6)
  `, [
    id, teamId, requesterId,
    JSON.stringify(shiftDetails),
    JSON.stringify(candidates),
    new Date().toISOString(),
  ]);
  return getRequest(teamId, id);
}

async function getRequest(teamId, requestId) {
  const res = await pool.query(
    "SELECT * FROM requests WHERE team_id = $1 AND id = $2",
    [teamId, requestId]
  );
  return rowToRequest(res.rows[0]);
}

async function getActiveRequestForUser(teamId, requesterId) {
  const res = await pool.query(`
    SELECT * FROM requests
    WHERE team_id = $1 AND requester_id = $2
      AND status IN ('awaiting_names', 'pending')
    ORDER BY created_at DESC LIMIT 1
  `, [teamId, requesterId]);
  return rowToRequest(res.rows[0]);
}

async function getRequestForCandidate(teamId, candidateId) {
  const res = await pool.query(`
    SELECT * FROM requests
    WHERE team_id = $1 AND current_asked_user_id = $2 AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `, [teamId, candidateId]);
  return rowToRequest(res.rows[0]);
}

async function updateRequest(teamId, requestId, updates) {
  const colMap = {
    candidates:             "candidates",
    currentIndex:           "current_index",
    status:                 "status",
    acceptedBy:             "accepted_by",
    currentAskedUserId:     "current_asked_user_id",
    currentAskedChannelId:  "current_asked_channel_id",
    conversationHistory:    "conversation_history",
  };
  const jsonFields = new Set(["candidates", "conversationHistory"]);

  const setClauses = [];
  const values = [];
  let i = 1;

  for (const [key, col] of Object.entries(colMap)) {
    if (!(key in updates)) continue;
    setClauses.push(`${col} = $${i++}`);
    values.push(jsonFields.has(key) ? JSON.stringify(updates[key]) : updates[key]);
  }

  if (setClauses.length === 0) return getRequest(teamId, requestId);

  values.push(teamId, requestId);
  await pool.query(
    `UPDATE requests SET ${setClauses.join(", ")} WHERE team_id = $${i++} AND id = $${i++}`,
    values
  );
  return getRequest(teamId, requestId);
}

module.exports = {
  createRequest,
  getRequest,
  getActiveRequestForUser,
  getRequestForCandidate,
  updateRequest,
};
