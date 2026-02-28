import express from 'express';
import screenshot from 'screenshot-desktop';
import robot from 'robotjs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

let ACCESS_TOKEN = null;

const startServer = () => {
    app.use(express.json());
    app.use(express.static('public'));

    // Middleware to check authentication
    const auth = (req, res, next) => {
        if (!ACCESS_TOKEN) return next();
        const token = req.headers['x-auth-token'] || req.query.token;
        if (token === ACCESS_TOKEN) {
            next();
        } else {
            res.status(401).send('Unauthorized');
        }
    };

    // Public endpoint to check if password is required
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

    let capturePromise = null;
    app.get('/api/screenshot', auth, async (req, res) => {
        if (capturePromise) {
            try {
                const img = await capturePromise;
                res.set('Content-Type', 'image/jpeg');
                return res.send(img);
            } catch(e) {}
        }

        capturePromise = (async () => {
            try {
                const img = await Promise.race([
                    screenshot({ format: 'jpg' }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1000))
                ]);
                return img;
            } finally {
                setTimeout(() => { capturePromise = null; }, 50);
            }
        })();

        try {
            const img = await capturePromise;
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.send(img);
        } catch (err) {
            console.error('Capture error:', err.message);
            res.status(503).send('Capture Error');
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
                // Default click
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
                console.log(`Typing: ${text}`);
                res.json({ success: true });
                for (const char of text) {
                    robot.typeString(char);
                    await new Promise(r => setTimeout(r, 20));
                }
            } else {
                res.status(400).json({ error: 'Empty' });
            }
        } catch (err) {
            if (!res.headersSent) res.status(500).json({ error: err.message });
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
