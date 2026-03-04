import express from 'express';
import screenshot from 'screenshot-desktop';
import robot from 'robotjs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { WebSocketServer } from 'ws';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

let ACCESS_TOKEN = null;

export const attachRemote = (app, wss, accessToken = null) => {
    ACCESS_TOKEN = accessToken;

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
        const { x, y, w, h, q, gs, fmt } = req.query;
        const quality = parseInt(q) || 8;
        const format = fmt || 'jpg'; // Default back to jpg
        const grayscale = gs === 'true';
        
        const hasCrop = x !== undefined && y !== undefined && w !== undefined && h !== undefined;
        
        const cropParams = hasCrop ? {
            left: Math.floor(parseFloat(x)),
            top: Math.floor(parseFloat(y)),
            width: Math.floor(parseFloat(w)),
            height: Math.floor(parseFloat(h))
        } : null;

        // If no crop, no quality change, default format, and no grayscale, we can use the cached promise
        if (capturePromise && !cropParams && quality === 8 && format === 'jpg' && !grayscale) {
            try {
                const img = await capturePromise;
                res.set('Content-Type', 'image/jpeg');
                return res.send(img);
            } catch(e) {}
        }

        const capture = async () => {
            try {
                let img = await Promise.race([
                    screenshot({ format: 'jpg' }), // Raw capture as JPG from OS
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

                if (grayscale) {
                    pipeline = pipeline.grayscale();
                }

                // Process output format
                if (format === 'webp') {
                    img = await pipeline.webp({ quality }).toBuffer();
                } else {
                    img = await pipeline.jpeg({ quality }).toBuffer();
                }
                
                return img;
            } catch (err) {
                console.error(`Capture/Crop error: ${err.message}`, cropParams);
                throw err;
            }
        };

        // Cache full-frame with default settings only
        if (!cropParams && quality === 8 && format === 'jpg' && !grayscale) {
            capturePromise = capture().finally(() => {
                setTimeout(() => { capturePromise = null; }, 50);
            });
        }

        try {
            const needsCustomCapture = cropParams || quality !== 8 || format !== 'jpg' || grayscale;
            const img = needsCustomCapture ? await capture() : await capturePromise;
            res.set('Content-Type', format === 'webp' ? 'image/webp' : 'image/jpeg');
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.send(img);
        } catch (err) {
            if (!res.headersSent) res.status(503).send('Capture Error');
        }
    });

    // Helper for WS / API shared capture
    async function getProcessedScreenshot(params) {
        const { x, y, w, h, q, gs, fmt } = params;
        const quality = parseInt(q) || 8;
        const format = fmt || 'jpg';
        const grayscale = gs === 'true';
        const hasCrop = x !== undefined && y !== undefined && w !== undefined && h !== undefined;

        let img = await Promise.race([
            screenshot({ format: 'jpg' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
        ]);

        let pipeline = sharp(img);
        if (hasCrop) {
            const metadata = await pipeline.metadata();
            const left = Math.max(0, Math.min(metadata.width - 1, Math.floor(parseFloat(x))));
            const top = Math.max(0, Math.min(metadata.height - 1, Math.floor(parseFloat(y))));
            const width = Math.max(1, Math.min(metadata.width - left, Math.floor(parseFloat(w))));
            const height = Math.max(1, Math.min(metadata.height - top, Math.floor(parseFloat(h))));
            pipeline = pipeline.extract({ left, top, width, height });
        }
        if (grayscale) pipeline = pipeline.grayscale();
        
        if (format === 'webp') return await pipeline.webp({ quality }).toBuffer();
        return await pipeline.jpeg({ quality }).toBuffer();
    }

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

    wss.on('connection', (ws) => {
        ws.on('message', async (data) => {
            try {
                // Ignore non-json or other messages
                let msg;
                try {
                    msg = JSON.parse(data);
                } catch(e) { return; }

                if (msg.type === 'request_frame') {
                    if (ACCESS_TOKEN && msg.token !== ACCESS_TOKEN) {
                        return ws.send(JSON.stringify({ error: '401' }));
                    }
                    const img = await getProcessedScreenshot(msg.params || {});
                    ws.send(img); // Binary send
                }
            } catch (e) {
                console.error('WS Capture Error:', e.message);
            }
        });
    });

    console.log(`📡 Remote Screen Interface Attached!`);
    if (ACCESS_TOKEN) console.log(`🔐 REMOTE VIEW PROTECTED with PIN: ${ACCESS_TOKEN}`);
    else console.log(`🔓 REMOTE VIEW UNPROTECTED (No PIN)`);
};
