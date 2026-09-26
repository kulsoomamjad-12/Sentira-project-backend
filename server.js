const dns = require('dns');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const { startSocialImportScheduler } = require('./jobs/socialImportScheduler');

// Vercel sets this env var on every deployment automatically — used
// throughout this file to skip the things that only make sense for a
// normal long-running process (`node server.js`), since a serverless
// function is stateless and short-lived per invocation.
const IS_SERVERLESS = !!process.env.VERCEL;

// Node picks up this machine's configured DNS server (127.0.0.1 here, from a
// VPN/proxy service) which doesn't answer the SRV lookups a mongodb+srv://
// connection string needs, causing mongoose.connect to fail outright. Force
// a public resolver so SRV/TXT records resolve. Only relevant to that one
// local machine's network setup — skip it on a real host.
if (!IS_SERVERLESS) {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
}

const app = express();

app.use(cors());
app.use(express.json());

// --- Real-time layer (Socket.IO) ---
// Needs a persistent connection a serverless function can't hold open
// (each invocation is stateless and ends after the response), so it's only
// created for a normal long-running process. Under Vercel, req.io below
// falls back to a no-op stub so every place that calls
// req.io.to(...).emit(...) (new feedback, ticket updates) keeps working
// without crashing — it just doesn't push anything live. In practice this
// means the notification bell / instant feedback alerts don't update live
// when deployed on Vercel; everything else (saving data, AI analysis)
// still works.
let io = null;
let server = app;

if (!IS_SERVERLESS) {
  server = http.createServer(app);
  io = new Server(server, {
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    console.log('⚡ Client connected to Live WebSocket:', socket.id);

    // Scope this socket to its company's room (keyed by the Company's real
    // ID, not its display name) so real-time alerts (critical feedback,
    // ticket events) never leak across companies. Also join a per-user room
    // so a ticket update's own author can be excluded from the broadcast —
    // you don't need a notification telling you what you just did.
    socket.on('join-company', (companyId, userId) => {
      if (companyId) socket.join(companyId);
      if (userId) socket.join(`user:${userId}`);
    });

    socket.on('disconnect', () => console.log('Client disconnected'));
  });
}

// Chainable no-op covering every socket.io call pattern this app actually
// uses: req.io.to(x).emit(...) AND req.io.to(x).except(y).emit(...) (ticket
// create/update exclude the acting user's own room). Both must return
// something with the same shape, since .except() itself needs to be
// chainable back to .emit().
const noopIoChain = { emit: () => {}, except: () => noopIoChain };
const noopIo = { to: () => noopIoChain };

// Pass io (or the no-op stand-in) to routes
app.use((req, res, next) => {
  req.io = io || noopIo;
  next();
});

// --- Database connection ---
// Cached on `global` so a warm serverless invocation (Vercel keeps recently
// used function instances alive briefly) reuses the existing connection
// instead of reconnecting on every single request.
function connectDB() {
  if (!global._mongooseConnection) {
    global._mongooseConnection = mongoose.connect(process.env.MONGO_URI).then(() => {
      console.log('MongoDB Connected Successfully!');
    });
  }
  return global._mongooseConnection;
}

if (IS_SERVERLESS) {
  // Connect lazily per request instead of once at module load — a
  // serverless module can be re-evaluated on cold starts, and this way a
  // failed connection returns a normal JSON 500 instead of taking down
  // every route (there's no long-running process here to process.exit()).
  app.use((req, res, next) => {
    connectDB()
      .then(() => next())
      .catch((error) => {
        console.error('Database connection error:', error.message);
        res.status(500).json({ message: 'Database connection error', error: error.message });
      });
  });
}

// A friendly response at the bare root URL — this is an API-only backend
// with no page of its own, so without this, visiting the deployed URL
// directly (or a host's uptime check hitting "/") shows Express's default
// "Cannot GET /", which looks like a broken deploy even when everything is
// actually running fine.
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Sentiment Analyzer API is running' });
});

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/feedback', require('./routes/feedbackRoutes'));
app.use('/api/forms', require('./routes/formRoutes'));
app.use('/api/tickets', require('./routes/ticketRoutes'));
app.use('/api/social-import', require('./routes/socialImportRoutes'));

// --- Start a normal long-running server (local dev, Render, Railway, etc.) ---
// Skipped entirely under Vercel: there's no persistent process to listen on
// a port, and the platform calls the exported `app` directly per request.
const PORT = process.env.PORT || 5000;

if (!IS_SERVERLESS) {
  connectDB()
    .then(() => {
      server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
      startSocialImportScheduler(io);
    })
    .catch((err) => {
      console.error('Database connection error:', err);
      process.exit(1);
    });
}

// Vercel's Node runtime (@vercel/node, see vercel.json) imports this file
// and calls the exported Express app directly as the request handler.
module.exports = app;
