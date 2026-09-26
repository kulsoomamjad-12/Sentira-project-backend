const dns = require('dns');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const { startSocialImportScheduler } = require('./jobs/socialImportScheduler');

// Node picks up this machine's configured DNS server (127.0.0.1 here, from a
// VPN/proxy service) which doesn't answer the SRV lookups the mongodb+srv://
// connection string needs, causing mongoose.connect to fail outright. Force
// a public resolver so the SRV/TXT records for the Atlas cluster resolve.
dns.setServers(['8.8.8.8', '1.1.1.1']);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());

// Pass io instance to routes
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/feedback', require('./routes/feedbackRoutes'));
app.use('/api/forms', require('./routes/formRoutes'));
app.use('/api/tickets', require('./routes/ticketRoutes'));
app.use('/api/social-import', require('./routes/socialImportRoutes'));

// Socket Connection
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

// Database Connection & Server Start
const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB Connected Successfully!');
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
    startSocialImportScheduler(io);
  })
  .catch(err => {
    console.error('Database connection error:', err);
    process.exit(1);
  });