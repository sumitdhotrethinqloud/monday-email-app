/**
 * MONDAY EMAIL → BOARD ITEM APP (BACKEND)
 * -------------------------------------
 * Features:
 * - Monday OAuth
 * - Auto board detection
 * - Auto column creation
 * - Email IMAP listener
 * - Create items in correct board
 */

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const Imap = require("imap-simple");
const { simpleParser } = require("mailparser");
const { htmlToText } = require("html-to-text");

const app = express();
app.use(express.json());

/* ======================================================
   IN-MEMORY STORE (Replace with DB later)
====================================================== */
const boardStore = {}; 
// structure:
// boardStore[boardId] = {
//   accessToken,
//   columns: { email, phone, service, note }
// }

/* ======================================================
   CONSTANTS
====================================================== */
//const ALLOWED_SENDER = "sumitdhotre@gmail.com";
 
const processedUids = new Set();


app.post("/config/sender", (req, res) => {
  const { boardId, allowedSenderEmail } = req.body;

  if (!boardStore[boardId]) {
    return res.status(404).json({ error: "Board not registered" });
  }

  boardStore[boardId].allowedSenderEmail =
    allowedSenderEmail.toLowerCase();

  res.json({
    message: "Allowed sender email saved",
    boardId,
    allowedSenderEmail
  });
});

/* ======================================================
   MONDAY OAUTH
====================================================== */

// Step 1: Redirect user to Monday OAuth
app.get("/oauth/start", (req, res) => {
  const url =
    "https://auth.monday.com/oauth2/authorize" +
    `?client_id=${process.env.MONDAY_CLIENT_ID}` +
    "&response_type=code" +
    `&redirect_uri=${process.env.OAUTH_REDIRECT_URL}`;

  res.redirect(url);
});

// Step 2: OAuth callback
app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;

    const tokenRes = await fetch(
      "https://auth.monday.com/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.MONDAY_CLIENT_ID,
          client_secret: process.env.MONDAY_CLIENT_SECRET,
          code,
          redirect_uri: process.env.OAUTH_REDIRECT_URL
        })
      }
    );

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
      
    // Get board context
    const context = await mondayQuery(accessToken, `
      query {
        context {
          boardId
        }
      }
    `);

    const boardId = context.data.context.boardId;

    // Ensure columns exist
    const columns = await ensureColumns(boardId, accessToken);

    // Save config
    boardStore[boardId] = {
      accessToken,
      columns
    };
    startEmailListener(boardId);
    res.send("✅ App installed successfully on board " + boardId);
  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth failed");
  }

});

/* ======================================================
   MONDAY HELPERS
====================================================== */

async function mondayQuery(token, query) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query })
  });
  return res.json();
}

async function ensureColumns(boardId, token) {
  const required = {
    email: { title: "Email Address", type: "email" },
    phone: { title: "Phone Number", type: "phone" },
    service: { title: "Service", type: "status" },
    note: { title: "Special Note", type: "long_text" }
  };

  const existing = await mondayQuery(token, `
    query {
      boards(ids: ${boardId}) {
        columns {
          id
          title
        }
      }
    }
  `);

  const boardColumns = existing.data.boards[0].columns;
  const map = {};

  for (const key in required) {
    const found = boardColumns.find(
      c => c.title === required[key].title
    );

    if (found) {
      map[key] = found.id;
    } else {
      const created = await mondayQuery(token, `
        mutation {
          create_column(
            board_id: ${boardId},
            title: "${required[key].title}",
            column_type: ${required[key].type}
          ) {
            id
          }
        }
      `);
      map[key] = created.data.create_column.id;
    }
  }
  return map;
}

/* ======================================================
   EMAIL HELPERS
====================================================== */

function extractValue(label, text) {
  const r = new RegExp(`${label}:\\s*(.+)`, "i");
  const m = text.match(r);
  return m ? m[1].trim() : null;
}

function extractPatientName(text) {
  return text
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)[0];
}

/* ======================================================
   EMAIL LISTENER
====================================================== */

async function startEmailListener(boardId) {
  const cfg = boardStore[boardId];
  if (!cfg) return;

  const connection = await Imap.connect({
    imap: {
      user: process.env.IMAP_USER,
      password: process.env.IMAP_PASSWORD,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    }
  });

  await connection.openBox("INBOX");
  console.log("📡 IMAP connected for board", boardId);

  setInterval(async () => {
    const results = await connection.search(
      ["UNSEEN"],
      { bodies: ["TEXT"], markSeen: false }
    );

    for (const res of results) {
      const uid = res.attributes.uid;
      if (processedUids.has(uid)) continue;
      processedUids.add(uid);

      const parsed = await simpleParser(res.parts[0].body);
      const from = parsed.from?.value?.[0]?.address;

     // if (from !== ALLOWED_SENDER) {
     //   await connection.addFlags(uid, ["\\Seen"]);
     //   continue;
     // }
     const allowedSender =
     boardStore[boardId].allowedSenderEmail;

      if (!allowedSender || from !== allowedSender) {
      console.log("⛔ Sender not allowed:", from);
      await connection.addFlags(uid, ["\\Seen"]);
      continue;
      }

      const text = parsed.text || htmlToText(parsed.html || "");

      const name = extractPatientName(text);
      if (!name) continue;

      const phone = extractValue("Phone Number", text);
      const email = extractValue("Email Address", text);
      const service = extractValue("Service", text);
      const note = extractValue("Special Note", text);

      await createItem(boardId, name, email, phone, service, note);
      await connection.addFlags(uid, ["\\Seen"]);
    }
  }, 15000);
}

/* ======================================================
   CREATE MONDAY ITEM
====================================================== */

async function createItem(boardId, name, email, phone, service, note) {
  const cfg = boardStore[boardId];

  const values = {};
  if (email) values[cfg.columns.email] = { email, text: email };
  if (phone) values[cfg.columns.phone] = { phone, countryShortName: "IN" };
  if (service) values[cfg.columns.service] = { label: service };
  if (note) values[cfg.columns.note] = note;

  const query = `
    mutation {
      create_item(
        board_id: ${boardId},
        item_name: "${name}",
        column_values: "${JSON.stringify(values).replace(/"/g, '\\"')}"
      ) {
        id
      }
    }
  `;

  const res = await mondayQuery(cfg.accessToken, query);
  console.log("📦 Item created:", res.data);
}

/* ======================================================
   START SERVER
====================================================== */

//app.listen(3000, () => {
//  console.log("🚀 Server running on port 3000");
//});

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Monday Email App</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 20px;
          }
          input, button {
            padding: 8px;
            margin: 5px 0;
            width: 300px;
          }
        </style>
      </head>
      <body>
        <h2>📧 Monday Email → Board App</h2>

        <p>This app listens to emails and creates board items.</p>

        <h3>Allowed Sender Email</h3>
        <input id="sender" placeholder="example@gmail.com" />
        <br/>
        <button onclick="save()">Save Sender</button>

        <p id="status"></p>

        <script>
          async function save() {
            const sender = document.getElementById("sender").value;

            const res = await fetch("/config/sender", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                boardId: new URLSearchParams(window.location.search).get("boardId"),
                allowedSenderEmail: sender
              })
            });

            const data = await res.json();
            document.getElementById("status").innerText =
              data.message || "Saved";
          }
        </script>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(" Server running on port", PORT);
});

