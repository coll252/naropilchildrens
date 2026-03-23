const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Allow frontend (e.g., Live Server on port 5500) to communicate with backend
app.use(cors());
app.use(express.json());

// --- DATABASE CONNECTION POOL ---
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Auto-Initialize Default Admin and Patch Database Schema on Startup
async function initAdmin() {
    try {
        // Fix for "Data too long for column 'url'": 
        // Automatically upgrade the gallery url column to TEXT to support massive Google Images URLs
        try {
            await pool.query('ALTER TABLE gallery MODIFY COLUMN url TEXT');
        } catch (schemaErr) {
            // It's perfectly fine if this fails (e.g., if the table doesn't exist yet)
        }

        const defaultEmail = process.env.ADMIN_EMAIL || 'naropilchildrenfoundation@gmail.com';
        const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
        
        const [rows] = await pool.query('SELECT * FROM admins WHERE email = ?', [defaultEmail]);
        if (rows.length === 0) {
            const hash = await bcrypt.hash(defaultPassword, 10);
            await pool.query('INSERT INTO admins (email, password) VALUES (?, ?)', [defaultEmail, hash]);
            console.log(`Default admin created: ${defaultEmail} / ${defaultPassword}`);
        } else {
            // Update the password if the user changed it in the .env file
            const hash = await bcrypt.hash(defaultPassword, 10);
            await pool.query('UPDATE admins SET password = ? WHERE email = ?', [hash, defaultEmail]);
        }
    } catch (err) { 
        console.error('MySQL Connection Error (Check your .env DB credentials!):', err.message); 
    }
}
initAdmin();

// --- SECURITY MIDDLEWARE: PROTECT ADMIN ROUTES ---
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

// ==========================================
// 1. AUTHENTICATION ENDPOINT
// ==========================================
app.post('/api/auth/login', async (req, res) => {
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

// ==========================================
// 2. PUBLIC ENDPOINTS (Read Data & Submit Forms)
// ==========================================
app.get('/api/public/gallery', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM gallery ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/public/events', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM events ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/public/donations', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT name, amount, created_at FROM donations WHERE status = 'completed' ORDER BY created_at DESC LIMIT 10");
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/public/messages', async (req, res) => {
    const { name, email, subject, message } = req.body;
    try {
        await pool.query('INSERT INTO messages (name, email, subject, message) VALUES (?, ?, ?, ?)', [name, email, subject, message]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/public/volunteers', async (req, res) => {
    const { name, email, skills, message } = req.body;
    try {
        await pool.query('INSERT INTO volunteers (name, email, skills, message) VALUES (?, ?, ?, ?)', [name, email, skills, message]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/public/subscribers', async (req, res) => {
    try {
        await pool.query('INSERT INTO subscribers (email) VALUES (?)', [req.body.email]);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: 'Email already subscribed' }); }
});

// ==========================================
// 3. CO-OPERATIVE BANK (TUMA PAYMENTS) INTEGRATION
// ==========================================
async function getTumaToken() {
    const response = await axios.post('https://api.tuma.co.ke/auth/token', {
        email: process.env.TUMA_EMAIL,
        api_key: process.env.TUMA_API_KEY
    });
    if (response.data && response.data.success) {
        return response.data.data.token;
    }
    throw new Error("Failed to authenticate with Tuma API");
}

app.post('/api/tuma/donate', async (req, res) => {
    const { phone, amount, name } = req.body;
    // Format phone to strictly numbers (e.g. 254712345678)
    const formattedPhone = phone.replace(/\D/g, ''); 
    
    try {
        const token = await getTumaToken();

        const payload = {
            amount: parseFloat(amount),
            phone: formattedPhone,
            callback_url: process.env.TUMA_CALLBACK_URL,
            description: `Donation from ${name}`
        };

        const response = await axios.post('https://api.tuma.co.ke/payment/stk-push', payload, { 
            headers: { 
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.data.success) {
            // Save pending transaction tracking checkout ID
            const checkoutRequestId = response.data.data.checkout_request_id;
            await pool.query('INSERT INTO donations (name, phone, amount, checkout_request_id, status) VALUES (?, ?, ?, ?, ?)', 
                [name, formattedPhone, amount, checkoutRequestId, 'pending']);
            
            res.json({ success: true, message: 'Push sent successfully' });
        } else {
            throw new Error(response.data.message);
        }
    } catch (error) { 
        console.error("Tuma Payment error:", error?.response?.data || error.message);
        res.status(500).json({ error: 'Failed to initiate Co-op Bank payment. Check Tuma credentials.' }); 
    }
});

app.post('/api/tuma-callback', async (req, res) => {
    res.status(200).json({ success: true }); // Acknowledge webhook receipt to Tuma server
    
    const callbackData = req.body;
    if (!callbackData || !callbackData.checkout_request_id) return;

    const checkoutRequestId = callbackData.checkout_request_id;

    try {
        if (callbackData.result_code === 0 && callbackData.status === 'completed') {
            const receipt = callbackData.mpesa_receipt_number;
            await pool.query("UPDATE donations SET status = 'completed', receipt = ? WHERE checkout_request_id = ?", [receipt, checkoutRequestId]);
        } else {
            // result_code > 0 means the user canceled or entered wrong PIN
            await pool.query("UPDATE donations SET status = 'failed' WHERE checkout_request_id = ?", [checkoutRequestId]);
        }
    } catch (err) { console.error("Callback DB update error:", err.message); }
});

// ==========================================
// 4. SECURE ADMIN ENDPOINTS (Requires valid JWT token)
// ==========================================
app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
    try {
        const [donations] = await pool.query('SELECT * FROM donations ORDER BY created_at DESC');
        const [messages] = await pool.query('SELECT * FROM messages ORDER BY created_at DESC');
        const [volunteers] = await pool.query('SELECT * FROM volunteers ORDER BY created_at DESC');
        const [subscribers] = await pool.query('SELECT * FROM subscribers ORDER BY created_at DESC');
        res.json({ donations, messages, volunteers, subscribers });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/gallery', authenticateToken, async (req, res) => {
    try {
        await pool.query('INSERT INTO gallery (url, caption) VALUES (?, ?)', [req.body.url, req.body.caption]);
        res.json({ success: true });
    } catch (err) { 
        // Provide a clean error to the frontend if the URL is STILL too long for some reason
        if (err.message.includes('Data too long')) {
            return res.status(400).json({ error: 'Image URL is too long. Please copy a direct image link (e.g. from Unsplash) rather than a Google Search redirect link.' });
        }
        res.status(500).json({ error: err.message }); 
    }
});

app.delete('/api/admin/:table/:id', authenticateToken, async (req, res) => {
    const validTables = ['gallery', 'events', 'messages', 'volunteers', 'subscribers'];
    if (!validTables.includes(req.params.table)) return res.status(400).json({error: 'Invalid table'});
    try {
        await pool.query(`DELETE FROM ${req.params.table} WHERE id = ?`, [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/events', authenticateToken, async (req, res) => {
    try {
        await pool.query('INSERT INTO events (title, content) VALUES (?, ?)', [req.body.title, req.body.content]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/volunteers/:id/status', authenticateToken, async (req, res) => {
    try {
        await pool.query('UPDATE volunteers SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Node.js/MySQL Backend running securely on http://localhost:${PORT}`));