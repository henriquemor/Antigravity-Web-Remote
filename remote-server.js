import express from 'express';
import screenshot from 'screenshot-desktop';
import robot from 'robotjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static('public'));

console.log('--- Remote Control Server Active ---');

// Endpoint to get screen information
app.get('/api/info', (req, res) => {
    try {
        const size = robot.getScreenSize();
        res.json(size);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cache for screen capture to avoid overlap
let capturePromise = null;

// Screenshot endpoint
app.get('/api/screenshot', async (req, res) => {
    if (capturePromise) {
        try {
            const img = await capturePromise;
            res.set('Content-Type', 'image/jpeg');
            return res.send(img);
        } catch(e) { /* fallback to try a new one */ }
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

// Click processing endpoint
app.post('/api/click', (req, res) => {
    const { x, y, button } = req.body;
    try {
        const screenSize = robot.getScreenSize();
        const targetX = Math.floor(Math.max(0, Math.min(screenSize.width - 1, x)));
        const targetY = Math.floor(Math.max(0, Math.min(screenSize.height - 1, y)));
        
        robot.moveMouse(targetX, targetY);
        robot.mouseClick(button || 'left');
        
        console.log(`${button || 'left'} click at: ${targetX}, ${targetY}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Text typing endpoint
app.post('/api/type', async (req, res) => {
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
});
