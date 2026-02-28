import express from 'express';
import screenshot from 'screenshot-desktop';
import robot from 'robotjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static('public'));

console.log('--- Iniciando Servidor de Controle Remoto (Resolução Total) ---');

// Endpoint para pegar informações da tela (Resolução Real)
app.get('/api/info', (req, res) => {
    try {
        const size = robot.getScreenSize();
        console.log(`Resolução do Host: ${size.width}x${size.height}`);
        res.json(size);
    } catch (err) {
        console.error('Erro ao obter tamanho da tela:', err);
        res.status(500).json({ error: err.message });
    }
});

// Cache para evitar capturas simultâneas
let isCapturing = false;

// Endpoint para a captura de tela (Retorna imagem JPEG original)
app.get('/api/screenshot', async (req, res) => {
    if (isCapturing) return; 
    
    isCapturing = true;
    try {
        const displays = await screenshot.listDisplays();
        const mainDisplay = displays[0] || { id: 0 };
        
        // Captura a tela original sem redimensionamento
        const img = await screenshot({ format: 'jpg', screen: mainDisplay.id });
        
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.send(img);
        
    } catch (err) {
        console.error('Erro na captura:', err);
        res.status(500).send('Erro: ' + err.message);
    } finally {
        isCapturing = false;
    }
});

// Endpoint para processar o clique
app.post('/api/click', (req, res) => {
    const { x, y } = req.body;
    try {
        const screenSize = robot.getScreenSize();
        
        // Garante que o clique está dentro dos limites da tela
        const targetX = Math.floor(Math.max(0, Math.min(screenSize.width - 1, x)));
        const targetY = Math.floor(Math.max(0, Math.min(screenSize.height - 1, y)));
        
        // Move o mouse suavemente ou instantaneamente
        robot.moveMouse(targetX, targetY);
        
        // Pequeno delay opcional para garantir que o SO processou o movimento
        setTimeout(() => {
            robot.mouseClick();
            console.log(`Clique executado em: ${targetX}, ${targetY}`);
        }, 10);
        
        res.json({ success: true, x: targetX, y: targetY });
    } catch (err) {
        console.error('Erro ao executar clique:', err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
🚀 Servidor Remoto rodando em: http://localhost:${PORT}/remote.html
Monitorando em intervalos de 500ms (conforme solicitado pelo front-end)
`);
});
