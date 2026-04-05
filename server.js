const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// --- CORS POLICY UPDATE ---
// Allow requests from all your official domains (and local testing)
const allowedOrigins = [
    'https://naropilchildrensfoundation.com',
    'https://www.naropilchildrensfoundation.com',
    'https://naropil-frontend.onrender.com',
    'http://localhost:3000' // Useful if you ever run the frontend locally
];

app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps, curl, or webhooks)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

// Parse JSON bodies globally
app.use(express.json());
app.use(express.static('public'));

// --- PAYSTACK WEBHOOK (Visa/Mastercard) ---
app.post('/api/paystack/webhook', async (req, res) => {
    try {
        // Validate event using Paystack's signature
        const secret = process.env.PAYSTACK_SECRET_KEY;
        const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
        
        if (hash === req.headers['x-paystack-signature']) {
            const event = req.body;
            
            // If payment was successful, update the database
            if (event.event === 'charge.success') {
                const reference = event.data.reference;
                await pool.query(
                    "UPDATE donations SET status = 'completed', receipt = ? WHERE checkout_request_id = ?", 
                    [event.data.receipt_number || reference, reference]
                );
                console.log(`✅ Visa Payment completed for reference: ${reference}`);
            }
        }
    } catch (err) {
        console.error("Webhook processing error:", err.message);
    }
    // Paystack requires a 200 response to acknowledge receipt
    res.status(200).send('Webhook received');
});

// --- DATABASE CONNECTION POOL ---
const dbConfig = process.env.DATABASE_URL ? {
    uri: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // CRITICAL FOR AIVEN
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
} : {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: { rejectUnauthorized: false }, // CRITICAL FOR AIVEN
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// --- AUTO-INITIALIZE DATABASE TABLES & SEED DATA ---
async function initializeDatabase() {
    try {
        console.log("🔄 Initializing database structures...");

        const tableQueries = [
            `CREATE TABLE IF NOT EXISTS admins (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS gallery (
                id INT AUTO_INCREMENT PRIMARY KEY,
                url TEXT NOT NULL,
                caption VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS events (
                id INT AUTO_INCREMENT PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS donations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                phone VARCHAR(50),
                amount DECIMAL(10,2) NOT NULL,
                checkout_request_id VARCHAR(255),
                receipt VARCHAR(255),
                status VARCHAR(50) DEFAULT 'pending',
                payment_method VARCHAR(50) DEFAULT 'mpesa',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                subject VARCHAR(255),
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS volunteers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                skills TEXT,
                message TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS subscribers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS stk_cancellations (
                phone VARCHAR(50) PRIMARY KEY,
                cancel_count INT DEFAULT 0,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )`
        ];

        for (const query of tableQueries) {
            await pool.query(query);
        }
        
        // Add payment_method column safely for older deployments
        try {
            await pool.query("ALTER TABLE donations ADD COLUMN payment_method VARCHAR(50) DEFAULT 'mpesa'");
        } catch (e) {
            // Fails silently if column already exists
        }

        console.log("✅ All Tables verified/created.");

        try { await pool.query('ALTER TABLE gallery MODIFY COLUMN url TEXT'); } catch (e) {}

        const defaultEmail = process.env.ADMIN_EMAIL || 'naropilchildrenfoundation@gmail.com';
        const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
        
        const [adminRows] = await pool.query('SELECT * FROM admins WHERE email = ?', [defaultEmail]);
        if (adminRows.length === 0) {
            const hash = await bcrypt.hash(defaultPassword, 10);
            await pool.query('INSERT INTO admins (email, password) VALUES (?, ?)', [defaultEmail, hash]);
            console.log(`👤 Default admin created: ${defaultEmail}`);
        } else {
            const hash = await bcrypt.hash(defaultPassword, 10);
            await pool.query('UPDATE admins SET password = ? WHERE email = ?', [hash, defaultEmail]);
            console.log(`👤 Default admin verified.`);
        }

        const [galleryRows] = await pool.query('SELECT * FROM gallery LIMIT 1');
        if (galleryRows.length === 0) {
            const sampleImages = [
                ['https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?q=80&w=2070&auto=format&fit=crop', 'Children at play'],
                ['https://images.unsplash.com/photo-1542810634-71277d95dcbb?q=80&w=2070&auto=format&fit=crop', 'Donation drive 2026']
            ];
            for (let img of sampleImages) { await pool.query('INSERT INTO gallery (url, caption) VALUES (?, ?)', [img[0], img[1]]); }
            console.log("🖼️ Sample Gallery data added.");
        }

        console.log("✅ Successfully connected to Aiven MySQL Database and System is Ready!");
    } catch (err) { 
        console.error('❌ MySQL Initialization Error:', err.message); 
    }
}
initializeDatabase();

// --- SECURITY MIDDLEWARE ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired session token.' });
        req.user = user;
        next();
    });
}

// --- ROUTER SETUP ---
const apiRouter = express.Router();

// 1. AUTHENTICATION ENDPOINT
apiRouter.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await pool.query('SELECT * FROM admins WHERE email = ?', [email]);
        if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
        
        const validPassword = await bcrypt.compare(password, users[0].password);
        if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });
        
        const token = jwt.sign({ id: users[0].id, email: users[0].email }, process.env.JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, email: users[0].email });
    } catch (err) { res.status(500).json({ error: 'Database error during login.' }); }
});

// 2. PUBLIC ENDPOINTS
apiRouter.get('/public/gallery', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM gallery ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.get('/public/events', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM events ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.get('/public/donations', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT name, amount, created_at, payment_method FROM donations WHERE status = 'completed' ORDER BY created_at DESC LIMIT 10");
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.post('/public/messages', async (req, res) => {
    const { name, email, subject, message } = req.body;
    try {
        await pool.query('INSERT INTO messages (name, email, subject, message) VALUES (?, ?, ?, ?)', [name, email, subject, message]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.post('/public/volunteers', async (req, res) => {
    const { name, email, skills, message } = req.body;
    try {
        await pool.query('INSERT INTO volunteers (name, email, skills, message) VALUES (?, ?, ?, ?)', [name, email, skills, message]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.post('/public/subscribers', async (req, res) => {
    try {
        await pool.query('INSERT INTO subscribers (email) VALUES (?)', [req.body.email]);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: 'Email already subscribed' }); }
});

// 3. CO-OPERATIVE BANK (M-PESA TUMA PAYMENTS)
async function getTumaToken() {
    const response = await axios.post('https://api.tuma.co.ke/auth/token', {
        email: process.env.TUMA_EMAIL,
        api_key: process.env.TUMA_API_KEY
    });
    if (response.data && response.data.success) return response.data.data.token;
    throw new Error("Failed to authenticate with Tuma API");
}

apiRouter.post('/tuma/donate', async (req, res) => {
    const { phone, amount, name } = req.body;
    const formattedPhone = phone.replace(/\D/g, ''); 
    
    try {
        // ENFORCEMENT: Check STK Push Cancellation Policy
        const [blocks] = await pool.query('SELECT cancel_count FROM stk_cancellations WHERE phone = ?', [formattedPhone]);
        if (blocks.length > 0 && blocks[0].cancel_count >= 3) {
            return res.status(403).json({ error: 'M-Pesa payments temporarily blocked due to multiple consecutive cancellations. Please use a Card or try again later.' });
        }

        const token = await getTumaToken();
        const payload = {
            amount: parseFloat(amount),
            phone: formattedPhone,
            callback_url: process.env.TUMA_CALLBACK_URL,
            description: `Donation from ${name}`
        };

        const response = await axios.post('https://api.tuma.co.ke/payment/stk-push', payload, { 
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        
        if (response.data.success) {
            const checkoutRequestId = response.data.data.checkout_request_id;
            await pool.query('INSERT INTO donations (name, phone, amount, checkout_request_id, status, payment_method) VALUES (?, ?, ?, ?, ?, ?)', 
                [name, formattedPhone, amount, checkoutRequestId, 'pending', 'mpesa']);
            res.json({ success: true, message: 'Push sent successfully' });
        } else {
            throw new Error(response.data.message);
        }
    } catch (error) { 
        console.error("Tuma Payment error:", error?.response?.data || error.message);
        const errorMessage = error?.response?.data?.message || error.message || 'Failed to initiate Co-op Bank payment.';
        res.status(500).json({ error: errorMessage }); 
    }
});

apiRouter.post('/tuma-callback', async (req, res) => {
    res.status(200).json({ success: true }); 
    const callbackData = req.body;
    if (!callbackData || !callbackData.checkout_request_id) return;

    try {
        // Find phone number associated with this checkout
        const [donationRows] = await pool.query('SELECT phone FROM donations WHERE checkout_request_id = ?', [callbackData.checkout_request_id]);
        const phone = donationRows.length > 0 ? donationRows[0].phone : null;

        if (callbackData.result_code === 0 && callbackData.status === 'completed') {
            await pool.query("UPDATE donations SET status = 'completed', receipt = ? WHERE checkout_request_id = ?", 
                [callbackData.mpesa_receipt_number, callbackData.checkout_request_id]);
            
            // Reset consecutive cancellations on successful payment
            if (phone) await pool.query('DELETE FROM stk_cancellations WHERE phone = ?', [phone]);
        } else {
            await pool.query("UPDATE donations SET status = 'failed' WHERE checkout_request_id = ?", [callbackData.checkout_request_id]);
            
            // POLICY IMPLEMENTATION: Track 1032 Cancellations
            if (callbackData.result_code == 1032 && phone) {
                await pool.query('INSERT INTO stk_cancellations (phone, cancel_count) VALUES (?, 1) ON DUPLICATE KEY UPDATE cancel_count = cancel_count + 1', [phone]);
            }
        }
    } catch (err) { console.error("Callback DB update error:", err.message); }
});

// 4. VISA / MASTERCARD (PAYSTACK CHECKOUT)
apiRouter.post('/paystack/donate', async (req, res) => {
    const { amount, name, email } = req.body;
    
    try {
        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: email,
            amount: Math.round(parseFloat(amount) * 100), // convert KES to cents
            currency: 'KES',
            callback_url: `${req.headers.origin}?payment=success`,
            metadata: { donor_name: name }
        }, {
            headers: { 
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const reference = response.data.data.reference;
        const authUrl = response.data.data.authorization_url;

        // Log the pending transaction in the database
        await pool.query('INSERT INTO donations (name, phone, amount, checkout_request_id, status, payment_method) VALUES (?, ?, ?, ?, ?, ?)', 
                [name, email, amount, reference, 'pending', 'visa']);

        res.json({ url: authUrl });
    } catch (error) {
        console.error("Paystack Error:", error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to initialize Visa payment gateway.' });
    }
});

// 5. SECURE ADMIN ENDPOINTS
apiRouter.get('/admin/dashboard', authenticateToken, async (req, res) => {
    try {
        const [donations] = await pool.query('SELECT * FROM donations ORDER BY created_at DESC');
        const [messages] = await pool.query('SELECT * FROM messages ORDER BY created_at DESC');
        const [volunteers] = await pool.query('SELECT * FROM volunteers ORDER BY created_at DESC');
        const [subscribers] = await pool.query('SELECT * FROM subscribers ORDER BY created_at DESC');
        res.json({ donations, messages, volunteers, subscribers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.post('/admin/gallery', authenticateToken, async (req, res) => {
    try {
        await pool.query('INSERT INTO gallery (url, caption) VALUES (?, ?)', [req.body.url, req.body.caption]);
        res.json({ success: true });
    } catch (err) { 
        if (err.message.includes('Data too long')) return res.status(400).json({ error: 'Image URL is too long.' });
        res.status(500).json({ error: err.message }); 
    }
});

apiRouter.delete('/admin/:table/:id', authenticateToken, async (req, res) => {
    const validTables = ['gallery', 'events', 'messages', 'volunteers', 'subscribers'];
    if (!validTables.includes(req.params.table)) return res.status(400).json({error: 'Invalid table'});
    try {
        await pool.query(`DELETE FROM ${req.params.table} WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.post('/admin/events', authenticateToken, async (req, res) => {
    try {
        await pool.query('INSERT INTO events (title, content) VALUES (?, ?)', [req.body.title, req.body.content]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

apiRouter.put('/admin/volunteers/:id/status', authenticateToken, async (req, res) => {
    try {
        await pool.query('UPDATE volunteers SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.use('/api', apiRouter);
app.use('/', apiRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Node.js/MySQL Backend running securely on port ${PORT}`));