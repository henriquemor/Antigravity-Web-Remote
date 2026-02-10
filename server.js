#!/usr/bin/env node

import express from 'express';
import {
    WebSocketServer
} from 'ws';
import http from 'http';
import WebSocket from 'ws';
import {
    fileURLToPath
} from 'url';
import {
    dirname,
    join,
    basename,
    relative
} from 'path';
import {
    execSync
} from 'child_process';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper to find repository root (folder with .git)
function findRepoRoot(startPath) {
    try {
        let curr = startPath;
        // Search up to 5 levels up
        for (let i = 0; i < 5; i++) {
            if (fs.existsSync(join(curr, '.git'))) return curr;
            const parent = dirname(curr);
            if (parent === curr) break;
            curr = parent;
        }
    } catch (e) {}
    return startPath;
}

const REPO_ROOT = findRepoRoot(__dirname);

const PORTS = [9000];
const DISCOVERY_INTERVAL = 10000;
const POLL_INTERVAL = 3000;

// Application State
let cascades = new Map(); // Map<cascadeId, { id, cdp: { ws, contexts, rootContextId }, metadata, snapshot, snapshotHash, projectRoot }>
let wss = null;

// Determine a likely project root from a title and current REPO_ROOT
function guessProjectRoot(windowTitle) {
    if (!windowTitle) return REPO_ROOT;
    
    // Antigravity titles are often "Folder - Antigravity"
    const name = windowTitle.split(' - ')[0].trim();
    if (!name) return REPO_ROOT;

    const parentDir = dirname(REPO_ROOT);
    const guessedPath = join(parentDir, name);
    
    if (fs.existsSync(guessedPath) && fs.lstatSync(guessedPath).isDirectory()) {
        return guessedPath;
    }
    
    return REPO_ROOT;
}

// --- Helpers ---

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve([]);
                } // return empty on parse error
            });
        });
        req.on('error', () => resolve([])); // return empty on network error
        req.setTimeout(2000, () => {
            req.destroy();
            resolve([]);
        });
    });
}

// --- CDP Logic ---

async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({
            id,
            method,
            params
        }));
    });

    const contexts = [];
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) {}
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000)); // increased wait
    // Quiet context logging
    // if (contexts.length === 0) console.log("⚠️ No execution contexts found yet");
    // else console.log(`📡 Discovered ${contexts.length} contexts`);

    return {
        ws,
        call,
        contexts,
        rootContextId: null
    };
}

async function extractMetadata(cdp) {
    const SCRIPT = `(() => {
        // Try multiple ways to find the chat
        const cascade = document.getElementById('cascade') || 
                        document.getElementById('chat') ||
                        document.querySelector('[id*="cascade"]') || 
                        document.querySelector('[class*="chat-messages"]') ||
                        document.querySelector('.react-app-container');
        
        if (!cascade) return { found: false };
        
        let chatTitle = null;
        const possibleTitleSelectors = ['h1', 'h2', 'header', '[class*="title"]'];
        for (const sel of possibleTitleSelectors) {
            try {
                const el = document.querySelector(sel);
                if (el && el.textContent.length > 2 && el.textContent.length < 50) {
                    chatTitle = el.textContent.trim();
                    break;
                }
            } catch(e) {}
        }
        
        return {
            found: true,
            chatTitle: chatTitle || 'Agent',
            isActive: document.hasFocus()
        };
    })()`;

    // Search all contexts
    // if (cdp.contexts.length === 0) {
    //    console.log("  ⚠️ No contexts to search");
    // }

    for (const ctx of cdp.contexts) {
        try {
            // console.log(`  🔍 Checking context ${ctx.id} (${ctx.origin} / ${ctx.name || 'no name'})`);
            
            const result = await cdp.call("Runtime.evaluate", { 
                expression: SCRIPT, 
                returnByValue: true, 
                contextId: ctx.id 
            });
            
            if (result.result && result.result.value && result.result.value.found) {
                // console.log(`  ✅ Found chat in context ${ctx.id} (${ctx.origin})`);
                return { ...result.result.value, contextId: ctx.id };
            }
        } catch (e) {
            // console.log(`  ❌ Error in context ${ctx.id}: ${e.message}`);
        }
    }
    return null;
}

async function captureCSS(cdp) {
    const SCRIPT = `(() => {
        // Gather CSS and namespace it basic way to prevent leaks
        let css = '';
        for (const sheet of document.styleSheets) {
            try { 
                for (const rule of sheet.cssRules) {
                    let text = rule.cssText;
                    // Naive scoping: replace body/html with #cascade locator
                    // This prevents the monitored app's global backgrounds from overriding our monitor's body
                    text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1#cascade');
                    text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1#cascade');
                    css += text + '\\n'; 
                }
            } catch (e) { }
        }
        return { css };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        return result.result?.value?.css || '';
    } catch (e) {
        return '';
    }
}

async function captureHTML(cdp) {
    const SCRIPT = `(() => {
        const cascade = document.getElementById('cascade') || 
                        document.getElementById('chat') ||
                        document.querySelector('[id*="cascade"]') || 
                        document.querySelector('[class*="chat-messages"]') ||
                        document.querySelector('.react-app-container');
                        
        if (!cascade) return { error: 'cascade not found' };
        
        // Build a path for each button (without modifying original DOM)
        function getPath(el, root) {
            const path = [];
            while (el && el !== root) {
                const parent = el.parentElement;
                if (!parent) break;
                const idx = Array.from(parent.children).indexOf(el);
                path.unshift(idx);
                el = parent;
            }
            return path;
        }
        
        // Capture standard buttons AND clickable divs (Headless UI options often use divs with cursor-pointer)
        const buttons = cascade.querySelectorAll('button, div[role="button"], div[role="option"], div.cursor-pointer');
        const buttonMap = {};
        
        const clone = cascade.cloneNode(true);
        // We must select from clone using same logic, but be careful of index alignment.
        // querySelectorAll returns a static NodeList in order of document.
        const cloneButtons = clone.querySelectorAll('button, div[role="button"], div[role="option"], div.cursor-pointer');
        
        // Tag interactive elements in CLONE only
        buttons.forEach((btn, i) => {
            const id = 'btn-' + i;
            const path = getPath(btn, cascade);
            // Store path and text for verification
            let text = btn.textContent.trim().slice(0, 50);
            if (!text && btn.getAttribute('aria-label')) text = btn.getAttribute('aria-label');

            buttonMap[id] = { 
                path: path, 
                text: text
            };
            if (cloneButtons[i]) {
                cloneButtons[i].setAttribute('data-relay-id', id);
                // Visual indicator for clickable divs
                if (cloneButtons[i].tagName === 'DIV') {
                    cloneButtons[i].style.cursor = 'pointer';
                    // Optional: highlight slightly to show it's interactive
                    // cloneButtons[i].style.outline = '1px dashed rgba(255,255,255,0.1)';
                }
            }
        });

        // Specific cleanup for VS Code / Antigravity UI artifacts
        const junkSelectors = [
            '.monaco-scrollable-element > .scrollbar',
            '.monaco-list-spacer',
            '.monaco-placeholder',
            '.rounded-lg' // Remove Tailwind placeholder/spacer artifacts
        ];
        
        junkSelectors.forEach(sel => {
            clone.querySelectorAll(sel).forEach(el => {
                // If it's a known junk class and has no content, remove it
                if (!el.innerText.trim()) {
                    el.remove();
                }
            });
        });

        // Neutralize ALL virtualization spacers and fixed-height containers
        clone.querySelectorAll('*').forEach(el => {
            const style = el.getAttribute('style') || '';
            
            // 1. Force heights to auto for containers
            if (style.includes('height:')) {
                el.style.height = 'auto';
                el.style.minHeight = '0px';
                el.style.maxHeight = 'none';
            }
            
            // 2. Remove all positioning offsets, transforms, and clips
            // We force position relative to keep elements in flow
            if (style.includes('top:') || style.includes('transform:') || style.includes('position:') || style.includes('translate')) {
                el.style.top = '0px';
                el.style.bottom = 'auto';
                el.style.transform = 'none';
                el.style.position = 'relative';
                el.style.display = 'block'; // Ensure they don't hide
            }

            // 3. Prevent clipping/scrolling inside the chat part
            if (style.includes('overflow:')) {
                el.style.overflow = 'visible';
            }

            // 4. Aggressively remove known empty artifacts (Tailwind/Monaco)
            if (el.tagName === 'DIV' && !el.innerText.trim()) {
                const className = el.className || '';
                if (className.includes('bg-') || className.includes('rounded') || className.includes('spacer')) {
                    el.remove();
                }
            }
        });

        // Specific monaco list cleanup
        clone.querySelectorAll('.monaco-list-rows, .rows-container, .monaco-scrollable-element').forEach(el => {
            el.style.height = 'auto';
            el.style.overflow = 'visible';
            el.style.position = 'static';
            el.style.padding = '0';
            el.style.margin = '0';
        });

        // Remove the input area and its container components
        const inputComp = clone.querySelector('[contenteditable="true"]') || 
                         clone.querySelector('textarea') ||
                         clone.querySelector('[class*="input"]') ||
                         clone.querySelector('[class*="composer"]');
        
        if (inputComp) {
            // Find the furthest parent that is still part of the "input/footer" area but NOT the root
            let footer = inputComp;
            while (footer.parentElement && footer.parentElement !== clone) {
                const p = footer.parentElement;
                if (p.classList.contains('chat-input') || p.id?.includes('input') || p.className?.includes('footer')) {
                    footer = p;
                } else {
                    break;
                }
            }
            if (footer !== clone) footer.remove();
            else inputComp.remove();
        }

        // Final generic cleanup: remove anything that looks like a footer or extra header
        clone.querySelectorAll('[class*="footer"], [class*="header"]').forEach(el => {
            // Be careful not to remove the whole chat
            if (el !== clone && !el.contains(clone) && el.innerText.trim().length < 50) {
                 // el.remove(); // Removed for safety, moved to CSS
            }
        });

        const bodyStyles = window.getComputedStyle(document.body);
        const containerStyles = window.getComputedStyle(cascade);
        
        let bodyBg = bodyStyles.backgroundColor;
        if (bodyBg === 'rgba(0, 0, 0, 0)' || bodyBg === 'transparent') {
            bodyBg = containerStyles.backgroundColor;
        }

        return {
            html: clone.outerHTML,
            buttonMap: buttonMap,
            bodyBg: bodyBg,
            bodyColor: bodyStyles.color
        };
    })()`;

    const contextId = cdp.rootContextId;
    if (!contextId) return null;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: contextId
        });
        if (result.result?.value && !result.result.value.error) {
            return result.result.value;
        }
    } catch (e) {}
    return null;
}

// --- Main App Logic ---

async function discover() {
    // 1. Find all targets
    const allTargets = [];
    await Promise.all(PORTS.map(async (port) => {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        // Be more aggressive: include anything with workbench or jetski
        const filtered = list.filter(t => 
            t.url?.toLowerCase().includes('workbench') || 
            t.url?.toLowerCase().includes('jetski') ||
            t.title?.toLowerCase().includes('antigravity')
        );
        filtered.forEach(t => allTargets.push({
            ...t,
            port
        }));
    }));
    
    // console.log(`🔍 Found targets: ${allTargets.length}`);
    // allTargets.forEach(t => console.log(`  - [${t.port}] ${t.title} (URL: ${t.url?.split('/').pop()})`));

    const newCascades = new Map();

    // 2. Connect/Refresh
    for (const target of allTargets) {
        const id = hashString(target.webSocketDebuggerUrl);

        // Reuse existing
        if (cascades.has(id)) {
            const existing = cascades.get(id);
            if (existing.cdp.ws.readyState === WebSocket.OPEN) {
                // Refresh metadata
                const meta = await extractMetadata(existing.cdp);
                if (meta) {
                    existing.metadata = {
                        ...existing.metadata,
                        ...meta
                    };
                    if (meta.contextId) existing.cdp.rootContextId = meta.contextId; // Update optimization
                    newCascades.set(id, existing);
                    continue;
                }
            }
        }

        // New connection
        try {
            // console.log(`🔌 Connecting to ${target.title}`);
            const cdp = await connectCDP(target.webSocketDebuggerUrl);
            const meta = await extractMetadata(cdp);

            if (meta) {
                if (meta.contextId) cdp.rootContextId = meta.contextId;
                const cascade = {
                    id,
                    cdp,
                    projectRoot: guessProjectRoot(target.title),
                    metadata: {
                        windowTitle: target.title,
                        chatTitle: meta.chatTitle,
                        isActive: meta.isActive
                    },
                    snapshot: null,
                    css: await captureCSS(cdp), //only on init bc its huge
                    snapshotHash: null
                };
                newCascades.set(id, cascade);
                // console.log(`✨ Added cascade: ${meta.chatTitle}`);
            } else {
                cdp.ws.close();
            }
        } catch (e) {
            // console.error(`Failed to connect to ${target.title}: ${e.message}`);
        }
    }

    // 3. Cleanup old
    for (const [id, c] of cascades.entries()) {
        if (!newCascades.has(id)) {
            console.log(`👋 Removing cascade: ${c.metadata.chatTitle}`);
            try {
                c.cdp.ws.close();
            } catch (e) {}
        }
    }

    const changed = cascades.size !== newCascades.size; // Simple check, could be more granular
    cascades = newCascades;

    if (changed) broadcastCascadeList();
}

async function updateSnapshots() {
    // Parallel updates
    await Promise.all(Array.from(cascades.values()).map(async (c) => {
        try {
            const snap = await captureHTML(c.cdp); // Only capture HTML
            if (snap) {
                const hash = hashString(snap.html);
                if (hash !== c.snapshotHash) {
                    c.snapshot = snap;
                    c.snapshotHash = hash;
                    broadcast({
                        type: 'snapshot_update',
                        cascadeId: c.id
                    });
                    // console.log(`📸 Updated ${c.metadata.chatTitle}`);
                }
            }
        } catch (e) {}
    }));
}

function broadcast(msg) {
    if (!wss) return;
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg));
    });
}

function broadcastCascadeList() {
    const list = Array.from(cascades.values()).map(c => ({
        id: c.id,
        title: c.metadata.chatTitle,
        window: c.metadata.windowTitle,
        active: c.metadata.isActive
    }));
    broadcast({
        type: 'cascade_list',
        cascades: list
    });
}

// --- Server Setup ---

async function main() {
    const app = express();
    const server = http.createServer(app);
    wss = new WebSocketServer({
        server
    });

    app.use(express.json());
    app.use(express.static(join(__dirname, 'public')));

    // API Routes
    app.get('/cascades', (req, res) => {
        res.json(Array.from(cascades.values()).map(c => ({
            id: c.id,
            title: c.metadata.chatTitle,
            active: c.metadata.isActive
        })));
    });

    app.get('/snapshot/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c || !c.snapshot) return res.status(404).json({
            error: 'Not found'
        });
        res.json(c.snapshot);
    });

    app.get('/styles/:id', (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({
            error: 'Not found'
        });
        res.json({
            css: c.css || ''
        });
    });

    // Alias for simple single-view clients (returns first active or first available)
    app.get('/snapshot', (req, res) => {
        const active = Array.from(cascades.values()).find(c => c.metadata.isActive) || cascades.values().next().value;
        if (!active || !active.snapshot) return res.status(503).json({
            error: 'No snapshot'
        });
        res.json(active.snapshot);
    });

    app.post('/send/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({
            error: 'Cascade not found'
        });

        // Re-using the injection logic logic would be long, 
        // but let's assume valid injection for brevity in this single-file request:
        // We'll trust the previous logic worked, just pointing it to c.cdp

        // ... (Injection logic here would be same as before, simplified for brevity of this file edit)
        // For now, let's just log it to prove flow works
        console.log(`Message to ${c.metadata.chatTitle}: ${req.body.message}`);
        // TODO: Port the full injection script back in if needed, 
        // but user asked for "update" which implies features, I'll assume I should include it.
        // See helper below.

        const result = await injectMessage(c.cdp, req.body.message);
        if (result.ok) res.json({
            success: true
        });
        else res.status(500).json(result);
    });

    // Git integration
    app.get('/git/status', (req, res) => {
        const cascade = cascades.get(req.query.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.query.path || cascade?.projectRoot || REPO_ROOT;
        try {
            const status = execSync('git status --short', {
                cwd: projectPath
            }).toString();
            res.json({
                status: status || 'No changes'
            });
        } catch (e) {
            res.status(500).json({
                error: 'Git status failed: ' + e.message
            });
        }
    });

    app.get('/git/diff', (req, res) => {
        const cascade = cascades.get(req.query.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.query.path || cascade?.projectRoot || REPO_ROOT;
        const file = req.query.file;
        try {
            let diff = '';
            if (file) {
                // Try normal diff
                diff = execSync(`git diff "${file}"`, { cwd: projectPath }).toString();
                
                // If unset, try staged diff
                if (!diff) {
                    try {
                         const staged = execSync(`git diff --staged "${file}"`, { cwd: projectPath }).toString();
                         if (staged) diff = staged;
                    } catch (e) {}
                }

                // If empty, check if it's an untracked file
                if (!diff) {
                    try {
                        const status = execSync(`git status --short "${file}"`, { cwd: projectPath }).toString();
                        if (status.startsWith('??')) {
                            const fullPath = join(projectPath, file);
                            const content = fs.readFileSync(fullPath, 'utf8');
                            diff = `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${content.split('\n').length} @@\n` + 
                                   content.split('\n').map(l => '+' + l).join('\n');
                        }
                    } catch (e2) {}
                }
            } else {
                diff = execSync('git diff', { cwd: projectPath }).toString();
                
                // For "All Changes", also include staged diff
                try {
                     const stagedAll = execSync('git diff --staged', { cwd: projectPath }).toString();
                     if (stagedAll) diff += '\n' + stagedAll;
                } catch(e) {}
                
                // Add untracked files too
                try {
                    const status = execSync('git status --short', { cwd: projectPath }).toString();
                    const untrackedFiles = status.split('\n')
                        .filter(l => l.startsWith('??'))
                        .map(l => l.substring(3).trim());
                    
                    for (const uFile of untrackedFiles) {
                        try {
                            const fullPath = join(projectPath, uFile);
                            const content = fs.readFileSync(fullPath, 'utf8');
                            const uDiff = `diff --git a/${uFile} b/${uFile}\n` +
                                         `new file mode 100644\n` +
                                         `--- /dev/null\n+++ b/${uFile}\n` +
                                         `@@ -0,0 +1,${content.split('\n').length} @@\n` + 
                                         content.split('\n').map(l => '+' + l).join('\n');
                            diff += '\n' + uDiff;
                        } catch (e3) {}
                    }
                } catch (e2) {}
            }
            res.json({
                diff: diff || 'No diff available'
            });
        } catch (e) {
            res.status(500).json({
                error: 'Git diff failed: ' + e.message
            });
        }
    });

    app.post('/git/stage', (req, res) => {
        const cascade = cascades.get(req.body.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.body.path || cascade?.projectRoot || REPO_ROOT;
        const file = req.body.file;
        try {
            execSync(`git add "${file}"`, {
                cwd: projectPath
            });
            res.json({
                ok: true
            });
        } catch (e) {
            res.status(500).json({
                error: e.message
            });
        }
    });

    app.post('/git/unstage', (req, res) => {
        const cascade = cascades.get(req.body.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.body.path || cascade?.projectRoot || REPO_ROOT;
        const file = req.body.file;
        try {
            execSync(`git restore --staged "${file}"`, {
                cwd: projectPath
            });
            res.json({
                ok: true
            });
        } catch (e) {
            res.status(500).json({
                error: e.message
            });
        }
    });

    app.post('/git/commit', (req, res) => {
        const cascade = cascades.get(req.body.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.body.path || cascade?.projectRoot || REPO_ROOT;
        const message = req.body.message;
        try {
            execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
                cwd: projectPath
            });
            res.json({
                ok: true
            });
        } catch (e) {
            res.status(500).json({
                error: e.message
            });
        }
    });

    app.get('/git/read', (req, res) => {
        const cascade = cascades.get(req.query.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.query.path || cascade?.projectRoot || REPO_ROOT;
        const file = req.query.file;
        try {
            const fullPath = join(projectPath, file);
            const content = fs.readFileSync(fullPath, 'utf8');
            res.json({
                content
            });
        } catch (e) {
            res.status(500).json({
                error: e.message
            });
        }
    });

    app.post('/git/save', (req, res) => {
        const cascade = cascades.get(req.body.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.body.path || cascade?.projectRoot || REPO_ROOT;
        const file = req.body.file;
        const content = req.body.content;
        try {
            const fullPath = join(projectPath, file);
            fs.writeFileSync(fullPath, content, 'utf8');
            res.json({
                ok: true
            });
        } catch (e) {
            res.status(500).json({
                error: e.message
            });
        }
    });

    // Explorer - file tree
    app.get('/explorer/tree', (req, res) => {
        const cascade = cascades.get(req.query.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.query.path || cascade?.projectRoot || REPO_ROOT;

        // Hard-coded exclusions + read .gitignore
        const defaultExcludes = ['node_modules', '.git', '.DS_Store', 'Thumbs.db', '.env', '.env.local'];
        let gitignorePatterns = [];
        try {
            const gi = fs.readFileSync(join(projectPath, '.gitignore'), 'utf8');
            gitignorePatterns = gi.split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('#'));
        } catch (e) { /* no .gitignore */ }

        const excludes = [...new Set([...defaultExcludes, ...gitignorePatterns])];

        function shouldExclude(relPath, isDir) {
            for (let pattern of excludes) {
                if (!pattern || pattern.startsWith('#')) continue;

                // Handle directory-only patterns (ending in /)
                const mustBeDir = pattern.endsWith('/');
                let p = mustBeDir ? pattern.slice(0, -1) : pattern;

                if (mustBeDir && !isDir) continue;

                // If pattern contains a slash (other than at the end), it's relative to the root
                if (p.includes('/')) {
                    // Strip leading slash if present for comparison
                    if (p.startsWith('/')) p = p.slice(1);
                    if (relPath === p || relPath.startsWith(p + '/')) return true;
                } else {
                    // No slash: matches any file/folder by name
                    const name = relPath.split('/').pop();
                    if (p.includes('*')) {
                        const regex = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
                        if (regex.test(name)) return true;
                    } else if (name === p) {
                        return true;
                    }
                }
            }
            return false;
        }

        function walk(dir) {
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
            catch (e) { return []; }

            const result = [];
            for (const entry of entries) {
                const fullPath = join(dir, entry.name);
                const relPath = relative(projectPath, fullPath).replace(/\\/g, '/');
                const isDir = entry.isDirectory();

                if (shouldExclude(relPath, isDir)) continue;

                if (isDir) {
                    result.push({
                        name: entry.name,
                        type: 'dir',
                        path: relPath,
                        children: walk(fullPath)
                    });
                } else {
                    result.push({
                        name: entry.name,
                        type: 'file',
                        path: relPath
                    });
                }
            }

            // Sort: dirs first, then alphabetical
            result.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            return result;
        }

        try {
            const tree = walk(projectPath);
            res.json({ 
                tree,
                projectRoot: projectPath
            });
        } catch (e) {
            res.status(500).json({ error: 'Failed to read directory: ' + e.message });
        }
    });

    // Git History & Graph
    app.get('/git/log', (req, res) => {
        const cascade = cascades.get(req.query.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.query.path || cascade?.projectRoot || REPO_ROOT;
        try {
            // Get commits: hash|author|date|message|refs
            const logOut = execSync('git log --pretty=format:"%h|%an|%ad|%s|%D" --date=short -n 50', { cwd: projectPath }).toString();
            const commits = logOut.split('\n').filter(l => l.trim()).map(line => {
                const [hash, author, date, message, refs] = line.split('|');
                return { hash, author, date, message, refs: refs || '' };
            });
            res.json({ commits });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/git/commit-files', (req, res) => {
        const cascade = cascades.get(req.query.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.query.path || cascade?.projectRoot || REPO_ROOT;
        const hash = req.query.hash;
        try {
            // Get files changed in this commit
            const filesOut = execSync(`git show --name-status --pretty="" ${hash}`, { cwd: projectPath }).toString();
            const files = filesOut.split('\n').filter(l => l.trim()).map(line => {
                const parts = line.split(/\s+/);
                return { status: parts[0], file: parts.slice(1).join(' ') };
            });
            res.json({ files });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/git/branches', (req, res) => {
        const cascade = cascades.get(req.query.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.query.path || cascade?.projectRoot || REPO_ROOT;
        try {
            const branchOut = execSync('git branch -a', { cwd: projectPath }).toString();
            const branches = branchOut.split('\n').filter(l => l.trim()).map(l => {
                const active = l.startsWith('*');
                const name = l.replace('*', '').trim();
                return { name, active };
            });
            res.json({ branches });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/git/push', (req, res) => {
        const cascade = cascades.get(req.body.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.body.path || cascade?.projectRoot || REPO_ROOT;
        try {
            execSync('git push', { cwd: projectPath });
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/git/sync', (req, res) => {
        const cascade = cascades.get(req.body.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.body.path || cascade?.projectRoot || REPO_ROOT;
        try {
            execSync('git pull --rebase', { cwd: projectPath });
            execSync('git push', { cwd: projectPath });
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/git/diff-commit', (req, res) => {
        const cascade = cascades.get(req.query.cascadeId) || Array.from(cascades.values())[0];
        const projectPath = req.query.path || cascade?.projectRoot || REPO_ROOT;
        const hash = req.query.hash;
        const file = req.query.file;
        try {
            const diff = execSync(`git show ${hash} -- "${file}"`, { cwd: projectPath }).toString();
            res.json({ diff });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });


    app.post('/click/:id', async (req, res) => {
        const c = cascades.get(req.params.id);
        if (!c) return res.status(404).json({
            error: 'Cascade not found'
        });

        const {
            relayId
        } = req.body;
        const buttonInfo = c.snapshot?.buttonMap?.[relayId];

        if (!buttonInfo) {
            console.log(`Click in ${c.metadata.chatTitle}: relayId=${relayId} - not found in buttonMap`);
            return res.status(404).json({
                error: 'Button not found in snapshot',
                relayId
            });
        }

        console.log(`Click in ${c.metadata.chatTitle}: relayId=${relayId}, text="${buttonInfo.text}"`);

        const result = await injectClick(c.cdp, buttonInfo.path, buttonInfo.text);
        if (result.ok) {
            res.json({ success: true });
            // Force re-capture after a short delay so new UI elements (selects, buttons) are captured
            setTimeout(async () => {
                try {
                    const snap = await captureHTML(c.cdp);
                    if (snap) {
                        c.snapshot = snap;
                        c.snapshotHash = hashString(snap.html);
                        broadcast({ type: 'snapshot_update', cascadeId: c.id });
                    }
                } catch(e) {}
            }, 500);
        }
        else res.status(500).json(result);
    });

    wss.on('connection', (ws) => {
        broadcastCascadeList(); // Send list on connect
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });

    // Start Loops
    discover();
    setInterval(discover, DISCOVERY_INTERVAL);
    setInterval(updateSnapshots, POLL_INTERVAL);
}

// Injection Helper (Moved down to keep main clear)
async function injectMessage(cdp, text) {
    const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    const SCRIPT = `(async () => {
        // Try contenteditable first, then textarea
        const editor = document.querySelector('[contenteditable="true"]') || 
                       document.querySelector('textarea') ||
                       document.querySelector('.ProseMirror'); // VSCode/Monaco/ProseMirror fallback
        
        if (!editor) return { ok: false, reason: "no editor found" };
        
        editor.focus();
        
        if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
            const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set || 
                                             Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (nativeTextAreaValueSetter) {
                nativeTextAreaValueSetter.call(editor, "${escapedText}");
                editor.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                editor.value = "${escapedText}";
                editor.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } else {
            // For contenteditable/ProseMirror
            document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, "${escapedText}");
            // Fallback if execCommand fails
            if (editor.textContent === '') {
                 editor.innerText = "${escapedText}";
                 editor.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        
        await new Promise(r => setTimeout(r, 200));
        
        // Try multiple button selectors
        const btn = document.querySelector('button[class*="arrow"]') || 
                   document.querySelector('button[aria-label*="Send"]') ||
                   document.querySelector('button[type="submit"]') ||
                   document.querySelector('.send-button') ||
                   Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('send') || b.innerText.toLowerCase().includes('enviar'));

        if (btn && !btn.disabled) {
            btn.click();
        } else {
             // Fallback to Enter key with all possible properties
             const opts = { bubbles:true, cancelable: true, key:"Enter", code: "Enter", keyCode: 13, which: 13 };
             editor.dispatchEvent(new KeyboardEvent("keydown", opts));
             editor.dispatchEvent(new KeyboardEvent("keypress", opts));
             editor.dispatchEvent(new KeyboardEvent("keyup", opts));
        }
        return { ok: true };
    })()`;

    try {
        const res = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: cdp.rootContextId
        });
        return res.result?.value || {
            ok: false
        };
    } catch (e) {
        return {
            ok: false,
            reason: e.message
        };
    }
}


// Click relay helper - uses DOM path for precise identification + text verification
async function injectClick(cdp, path, expectedText) {
    const pathJson = JSON.stringify(path);
    const escapedExpectedText = (expectedText || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const SCRIPT = `(() => {
        const path = ${pathJson};
        const expectedText = '${escapedExpectedText}';
        
        let el = document.getElementById('cascade') || 
                 document.getElementById('chat') ||
                 document.querySelector('[id*="cascade"]') || 
                 document.querySelector('[class*="chat-messages"]') ||
                 document.querySelector('.react-app-container');

        if (!el) return { ok: false, reason: 'cascade not found' };
        
        // Navigate the path
        for (const idx of path) {
            if (!el.children || !el.children[idx]) {
                return { ok: false, reason: 'path invalid', path: path, failedAt: idx };
            }
            el = el.children[idx];
        }
        
        if (el.tagName !== 'BUTTON' && el.tagName !== 'DIV' && el.tagName !== 'A' && el.tagName !== 'SPAN') {
            return { ok: false, reason: 'element is not interactive', tag: el.tagName };
        }
        
        // Verify text content matches (first 50 chars)
        // Check textContent and aria-label
        let actualText = el.textContent.trim().slice(0, 50);
        if (!actualText && el.getAttribute('aria-label')) actualText = el.getAttribute('aria-label');
        
        if (actualText !== expectedText) {
             // For some precise UI elements, text might differ slightly due to hidden children.
             // Let's be lenient if expectedText is empty or very short, or if it's a structural div.
             if (expectedText && expectedText.length > 3 && !actualText.includes(expectedText.substring(0, 10))) {
                 return { 
                    ok: false, 
                    reason: 'text mismatch - DOM may have changed', 
                    expected: expectedText, 
                    actual: actualText 
                };
             }
        }
        
        el.click();
        return { ok: true, clicked: el.tagName, text: actualText };
    })()`;

    try {
        const res = await cdp.call("Runtime.evaluate", {
            expression: SCRIPT,
            returnByValue: true,
            contextId: cdp.rootContextId
        });
        return res.result?.value || {
            ok: false
        };
    } catch (e) {
        return {
            ok: false,
            reason: e.message
        };
    }
}

main();