import express from 'express';
import screenshot from 'screenshot-desktop';
import robot from 'robotjs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

let ACCESS_TOKEN = null;

const startServer = () => {
    app.use(express.json({ limit: '10mb' }));
    app.use(express.static('public'));

    // ... (rest of the auth logic remains the same)

    let typingQueue = [];
    let isTyping = false;

    async function processTypingQueue() {
        if (isTyping || typingQueue.length === 0) return;
        isTyping = true;
        try {
            while (typingQueue.length > 0) {
                const text = typingQueue.shift();
                console.log(`Typing chunk of ${text.length} chars...`);
                for (const char of text) {
                    robot.typeString(char);
                    // Minimal delay between characters
                    await new Promise(r => setTimeout(r, 1));
                }
            }
        } catch (e) {
            console.error('Typing error:', e);
        } finally {
            isTyping = false;
            if (typingQueue.length > 0) processTypingQueue();
        }
    }

    const auth = (req, res, next) => {
        if (!ACCESS_TOKEN) return next();
        const token = req.headers['x-auth-token'] || req.query.token;
        if (token === ACCESS_TOKEN) {
            next();
        } else {
            res.status(401).send('Unauthorized');
        }
    };

    app.get('/api/auth-config', (req, res) => {
        res.json({ required: !!ACCESS_TOKEN });
    });

    app.get('/api/info', auth, (req, res) => {
        try {
            const size = robot.getScreenSize();
            res.json(size);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/mouse', auth, (req, res) => {
        try {
            const pos = robot.getMousePos();
            res.json(pos);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    let capturePromise = null;
    app.get('/api/screenshot', auth, async (req, res) => {
        const { x, y, w, h, q } = req.query;
        const quality = parseInt(q) || 8;
        const hasCrop = x !== undefined && y !== undefined && w !== undefined && h !== undefined;
        
        const cropParams = hasCrop ? {
            left: Math.floor(parseFloat(x)),
            top: Math.floor(parseFloat(y)),
            width: Math.floor(parseFloat(w)),
            height: Math.floor(parseFloat(h))
        } : null;

        // If no crop and no quality change (or default), we can use the cached promise
        if (capturePromise && !cropParams && quality === 8) {
            try {
                const img = await capturePromise;
                res.set('Content-Type', 'image/jpeg');
                return res.send(img);
            } catch(e) {}
        }

        const capture = async () => {
            try {
                let img = await Promise.race([
                    screenshot({ format: 'jpg' }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
                ]);

                let pipeline = sharp(img);
                
                if (cropParams) {
                    const metadata = await pipeline.metadata();
                    const left = Math.max(0, Math.min(metadata.width - 1, cropParams.left));
                    const top = Math.max(0, Math.min(metadata.height - 1, cropParams.top));
                    const width = Math.max(1, Math.min(metadata.width - left, cropParams.width));
                    const height = Math.max(1, Math.min(metadata.height - top, cropParams.height));
                    pipeline = pipeline.extract({ left, top, width, height });
                }

                // Always apply quality via sharp if q is specified or if we cropped
                img = await pipeline.jpeg({ quality }).toBuffer();
                
                return img;
            } catch (err) {
                console.error(`Capture/Crop error: ${err.message}`, cropParams);
                throw err;
            }
        };

        // Cache full-frame with default quality only
        if (!cropParams && quality === 8) {
            capturePromise = capture().finally(() => {
                setTimeout(() => { capturePromise = null; }, 50);
            });
        }

        try {
            const img = (cropParams || quality !== 8) ? await capture() : await capturePromise;
            res.set('Content-Type', 'image/jpg');
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.send(img);
        } catch (err) {
            if (!res.headersSent) res.status(503).send('Capture Error');
        }
    });

    app.post('/api/click', auth, (req, res) => {
        const { x, y, button, action } = req.body;
        try {
            const screenSize = robot.getScreenSize();
            const targetX = Math.floor(Math.max(0, Math.min(screenSize.width - 1, x)));
            const targetY = Math.floor(Math.max(0, Math.min(screenSize.height - 1, y)));
            
            if (action === 'move') {
                robot.moveMouse(targetX, targetY);
            } else if (action === 'down') {
                robot.moveMouse(targetX, targetY);
                robot.mouseToggle('down', button || 'left');
            } else if (action === 'up') {
                robot.moveMouse(targetX, targetY);
                robot.mouseToggle('up', button || 'left');
            } else {
                robot.moveMouse(targetX, targetY);
                robot.mouseClick(button || 'left');
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/type', auth, async (req, res) => {
        const { text } = req.body;
        try {
            if (text) {
                console.log(`Queuing text: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''} (${text.length} chars)`);
                res.json({ success: true });
                typingQueue.push(text);
                processTypingQueue();
            } else {
                res.status(400).json({ error: 'Empty' });
            }
        } catch (err) {
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/mouse-delta', auth, (req, res) => {
        const { dx, dy } = req.body;
        try {
            const pos = robot.getMousePos();
            robot.moveMouse(pos.x + (dx || 0), pos.y + (dy || 0));
            res.json({ success: true, x: pos.x + dx, y: pos.y + dy });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/mouse-click', auth, (req, res) => {
        const { button, action } = req.body;
        try {
            if (action === 'down') {
                robot.mouseToggle('down', button || 'left');
            } else if (action === 'up') {
                robot.mouseToggle('up', button || 'left');
            } else {
                robot.mouseClick(button || 'left');
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/key', auth, (req, res) => {
        const { key, modifiers } = req.body;
        try {
            console.log(`Key tap: ${key}`);
            if (key) {
                robot.keyTap(key, modifiers || []);
                res.json({ success: true });
            } else {
                res.status(400).json({ error: 'Key required' });
            }
        } catch (err) {
            console.error('Key error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    const PORT = 3001;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Running at: http://localhost:${PORT}/remote.html`);
        if (ACCESS_TOKEN) console.log(`🔐 PROTECTED with PIN: ${ACCESS_TOKEN}`);
        else console.log(`🔓 UNPROTECTED (No PIN)`);
    });
};

const args = process.argv.slice(2);
if (args.includes('nopin')) {
    ACCESS_TOKEN = null;
    startServer();
} else if (args.includes('pin')) {
    const pinIndex = args.indexOf('pin');
    ACCESS_TOKEN = args[pinIndex + 1] || null;
    startServer();
} else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Set a PIN for access (leave blank for NO PIN): ', (answer) => {
        ACCESS_TOKEN = answer.trim() || null;
        rl.close();
        startServer();
    });
}
