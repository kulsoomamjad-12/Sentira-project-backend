require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const users = await mongoose.connection.db.collection('users').find({ role: 'manager' }).toArray();
  console.log(`Found ${users.length} user(s) with role 'manager':`);
  users.forEach((u) => console.log(`  - ${u.email} (company: ${u.company})`));
  process.exit(0);
}).catch((err) => {
  console.log('FAILED:', err.message);
  process.exit(1);
});
