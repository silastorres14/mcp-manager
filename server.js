const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// --- Caminhos ---
const basePath = process.pkg ? path.dirname(process.execPath) : __dirname;
const serversFilePath = path.join(basePath, 'servers.json');
const commonClonePath = path.join(basePath, 'cloned_servers');
const publicPath = path.join(__dirname, 'public'); // Assets empacotados
console.log(`[INFO] Base path: ${basePath}`);
console.log(`[INFO] Static assets path: ${publicPath}`);
console.log(`[INFO] Config file path: ${serversFilePath}`);
console.log(`[INFO] Clones directory: ${commonClonePath}`);
// -----------------

const app = express();
const port = 3000;

// --- Verificação Debug da Pasta Pública ---
try {
    if (!fs.existsSync(publicPath) || !fs.existsSync(path.join(publicPath, 'index.html'))) {
        console.error(`[ERROR] Frontend files not found in ${publicPath}. Check pkg 'assets' config.`);
    }
} catch (err) { console.error(`[ERROR] Checking public path: ${err}`); }
// ------------------------------------------

// Middlewares
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicPath)); // Serve frontend

// --- Gerenciamento de Servidores MCP ---
let configuredServers = []; // Cache em memória da configuração
const runningServers = {}; // Estado dos processos em execução

// Carrega config do JSON (com validação)
function loadServersConfig() {
    try {
        if (fs.existsSync(serversFilePath)) {
            const data = fs.readFileSync(serversFilePath, 'utf-8');
            try {
                const parsedData = JSON.parse(data || '[]');
                if (Array.isArray(parsedData)) { configuredServers = parsedData; }
                else { console.error(`[ERROR] ${serversFilePath} inválido (não é array). Usando [].`); configuredServers = []; saveServersConfig(); }
            } catch (parseErr) { console.error(`[ERROR] Falha ao parsear JSON de ${serversFilePath}: ${parseErr.message}. Usando [].`); configuredServers = []; saveServersConfig(); }
        } else { console.log(`[INFO] ${serversFilePath} não encontrado, criando.`); configuredServers = []; saveServersConfig(); }
        console.log(`[INFO] ${configuredServers.length} servidor(es) carregado(s).`);
    } catch (err) { console.error(`[ERROR] Erro fatal ao carregar ${serversFilePath}:`, err); configuredServers = []; }
}

// Salva config no JSON
function saveServersConfig() {
    try {
        fs.writeFileSync(serversFilePath, JSON.stringify(configuredServers, null, 2), 'utf-8');
        console.log(`[INFO] Configuração salva (${configuredServers.length} servidores).`);
    } catch (err) { console.error(`[ERROR] Erro ao salvar ${serversFilePath}:`, err); }
}

// Envia msg via WebSocket
function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(message, (err) => { if (err) console.error("[WS Error] Send failed:", err); }); });
}

// Função Auxiliar para Notificar Mudança de Configuração
function notifyConfigUpdate() {
    broadcast({ type: 'config_update', servers: configuredServers.map(s => ({ ...s, status: runningServers[s.id]?.status || 'stopped' })) });
}

// --- API Endpoints ---

// GET /api/servers : Listar todos
app.get('/api/servers', (req, res) => {
    try {
        const serversWithStatus = configuredServers.map(server => ({...server, status: runningServers[server.id]?.status || 'stopped'}));
        res.json(serversWithStatus);
    } catch (error) { console.error("[API ERROR] GET /api/servers:", error); res.status(500).json({ message: "Erro interno." }); }
});

// POST /api/servers : Adicionar novo (usado pelo form e pelo 'paste JSON')
app.post('/api/servers', (req, res) => {
    try {
        // Validação um pouco mais robusta
        const data = req.body;
        if (!data || typeof data !== 'object') return res.status(400).json({ message: "Corpo da requisição inválido." });
        if (!data.name || typeof data.name !== 'string' || !data.name.trim()) return res.status(400).json({ message: "Campo 'name' é obrigatório." });
        if (!data.command || typeof data.command !== 'string' || !data.command.trim()) return res.status(400).json({ message: "Campo 'command' é obrigatório." });

        const newServer = {
             id: uuidv4(),
             name: data.name.trim(),
             description: (data.description || "").toString().trim(),
             command: data.command.trim(),
             args: Array.isArray(data.args) ? data.args.map(arg => String(arg).trim()).filter(Boolean) : [],
             env: (typeof data.env === 'object' && data.env !== null && !Array.isArray(data.env)) ? data.env : {}
         };
        configuredServers.push(newServer);
        saveServersConfig();
        res.status(201).json({...newServer, status: 'stopped'});
        notifyConfigUpdate(); // Notifica clientes sobre a adição
    } catch (error) { console.error("[API ERROR] POST /api/servers:", error); res.status(500).json({ message: "Erro interno ao adicionar." }); }
});

// PUT /api/servers/:id : Atualizar existente
app.put('/api/servers/:id', (req, res) => {
     try {
        const serverId = req.params.id;
        const index = configuredServers.findIndex(s => s.id === serverId);
        const data = req.body;

        if (index === -1) return res.status(404).json({ message: 'Servidor não encontrado.' });
        if (!data || typeof data !== 'object' || !data.name || !data.command) return res.status(400).json({ message: "Dados inválidos." });

        const currentStatus = runningServers[serverId]?.status;
        if (currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping') return res.status(400).json({ message: `Servidor está ${currentStatus}. Pare-o.` });

        configuredServers[index] = { // Atualiza o objeto no array
            id: serverId, // Mantém ID
            name: data.name.trim(),
            description: (data.description || "").toString().trim(),
            command: data.command.trim(),
            args: Array.isArray(data.args) ? data.args.map(arg => String(arg).trim()).filter(Boolean) : [],
            env: (typeof data.env === 'object' && data.env !== null && !Array.isArray(data.env)) ? data.env : {}
        };
        saveServersConfig();
        res.json({...configuredServers[index], status: 'stopped'}); // Retorna atualizado
        notifyConfigUpdate(); // Notifica clientes
     } catch (error) { console.error(`[API ERROR] PUT /api/servers/${req.params.id}:`, error); res.status(500).json({ message: "Erro interno ao atualizar." }); }
});

// DELETE /api/servers/:id : Remover
app.delete('/api/servers/:id', (req, res) => {
    try {
        const serverId = req.params.id;
        const serverIndex = configuredServers.findIndex(s => s.id === serverId);
        const currentStatus = runningServers[serverId]?.status;

        if (currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping') return res.status(400).json({ message: `Servidor está ${currentStatus}. Pare-o.` });

        let changed = false;
        if (serverIndex > -1) { configuredServers.splice(serverIndex, 1); saveServersConfig(); changed = true; }
        else { console.warn(`[WARN] Tentativa de deletar ${serverId} não encontrado na config.`); }
        if (runningServers[serverId]) { delete runningServers[serverId]; changed = true; }

        res.status(204).send();
        if (changed) notifyConfigUpdate(); // Notifica se algo mudou

    } catch (error) { console.error(`[API ERROR] DELETE /api/servers/${req.params.id}:`, error); res.status(500).json({ message: "Erro interno ao deletar." }); }
});

// POST /api/servers/:id/start : Ligar servidor (Lógica interna sem mudanças significativas)
app.post('/api/servers/:id/start', (req, res) => {
    const serverId = req.params.id;
    const serverConfig = configuredServers.find(s => s.id === serverId);
    if (!serverConfig) return res.status(404).json({ message: 'Config não encontrada.' });
    const currentStatus = runningServers[serverId]?.status;
    if (currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping') return res.status(400).json({ message: `Servidor já está ${currentStatus}.` });

    console.log(`[INFO] Iniciando: ${serverConfig.name} (${serverId})`);
    broadcast({ type: 'status', serverId, status: 'starting' });
    runningServers[serverId] = { process: null, status: 'starting', pid: null };

    try {
        const env = { ...process.env, ...(serverConfig.env || {}) };
        let cwd = basePath;
        try { // Determina CWD
            let potentialPath;
             if (serverConfig.command === 'node' && serverConfig.args?.[0]) potentialPath = path.resolve(basePath, serverConfig.args[0]);
             else if (serverConfig.command !== 'node') potentialPath = path.resolve(basePath, serverConfig.command);
             if (potentialPath && fs.existsSync(potentialPath)) cwd = path.dirname(potentialPath);
             else if (serverConfig.args?.[0]) { const firstArgDir = path.dirname(path.resolve(basePath, serverConfig.args[0])); if (fs.existsSync(firstArgDir)){ cwd = firstArgDir; } }
             console.log(`[DEBUG] CWD for ${serverId}: ${cwd}`);
        } catch(e) { console.warn(`[WARN] CWD determination error: ${e.message}`); cwd = basePath; }

        const child = spawn(serverConfig.command, serverConfig.args || [], { env, cwd, shell: process.platform === 'win32' });
        if (!child || !child.pid) throw new Error("Falha ao iniciar processo filho (sem PID).");

        runningServers[serverId] = { process: child, status: 'running', pid: child.pid };
        broadcast({ type: 'status', serverId, status: 'running', pid: child.pid });
        console.log(`[INFO] Iniciado ${serverId} (PID: ${child.pid})`);

        // Handlers...
        child.stdout.on('data', (data) => broadcast({ type: 'log', serverId, stream: 'stdout', message: data.toString() }) );
        child.stderr.on('data', (data) => { console.error(`[${serverId} STDERR] ${data.toString().trim()}`); broadcast({ type: 'log', serverId, stream: 'stderr', message: data.toString() }); });
        child.on('error', (err) => { console.error(`[${serverId} ERROR] Process error:`, err); if (runningServers[serverId]) { runningServers[serverId].status = 'error'; runningServers[serverId].process = null; } broadcast({ type: 'status', serverId, status: 'error', message: `Erro: ${err.message}` }); });
        child.on('close', (code, signal) => { const pid = child.pid || runningServers[serverId]?.pid || '?'; console.log(`[INFO] [${serverId} CLOSE] PID ${pid} (code: ${code}, signal: ${signal})`); if (runningServers[serverId]) { const finalStatus = (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') ? 'stopped' : 'error'; runningServers[serverId].status = finalStatus; runningServers[serverId].process = null; broadcast({ type: 'status', serverId, status: finalStatus, code, signal }); }});
        child.on('exit', (code, signal) => console.log(`[DEBUG] [${serverId} EXIT] PID ${child.pid || '?'} (code: ${code}, signal: ${signal})`));

        res.status(200).json({ message: 'Comando enviado.' });

    } catch (error) { console.error(`[ERROR] Start ${serverId}:`, error); runningServers[serverId] = { process: null, status: 'error', pid: null }; broadcast({ type: 'status', serverId, status: 'error', message: `Erro ao iniciar: ${error.message}` }); res.status(500).json({ message: `Erro: ${error.message}` }); }
});

// POST /api/servers/:id/stop : Parar servidor (Lógica interna sem mudanças significativas)
app.post('/api/servers/:id/stop', (req, res) => {
    const serverId = req.params.id;
    const serverInfo = runningServers[serverId];
    if (!serverInfo || !serverInfo.process) { if(serverInfo) serverInfo.status = 'stopped'; broadcast({ type: 'status', serverId, status: 'stopped' }); return res.status(400).json({ message: 'Servidor não está rodando.' }); }
    if (serverInfo.status !== 'running') return res.status(400).json({ message: `Servidor está ${serverInfo.status}.` });

    const pid = serverInfo.pid;
    console.log(`[INFO] Parando: ${serverId} (PID: ${pid})`);
    serverInfo.status = 'stopping';
    broadcast({ type: 'status', serverId, status: 'stopping' });

    try {
        const forceKillTimeout = setTimeout(() => { if (runningServers[serverId]?.process && runningServers[serverId]?.status === 'stopping') { console.warn(`[WARN] Timeout! Forçando SIGKILL PID ${pid}.`); try { runningServers[serverId].process.kill('SIGKILL'); } catch (killErr){} }}, 3000);
        serverInfo.process.once('close', () => clearTimeout(forceKillTimeout) );
        if (!serverInfo.process.kill('SIGTERM')) { console.warn(`[WARN] SIGTERM falhou para PID ${pid}.`); clearTimeout(forceKillTimeout); }
        res.status(200).json({ message: 'Comando enviado.' });
    } catch (error) { console.error(`[ERROR] Stop ${serverId} (PID: ${pid}):`, error); serverInfo.status = 'error'; serverInfo.process = null; broadcast({ type: 'status', serverId, status: 'error', message: `Erro ao parar: ${error.message}.` }); res.status(500).json({ message: `Erro: ${error.message}` }); }
});

// POST /api/git/clone : Clonar repositório e ADICIONAR placeholder
app.post('/api/git/clone', (req, res) => {
    const { repoUrl } = req.body;
    if (!repoUrl) return res.status(400).json({ message: 'URL obrigatória.' });
    if (!repoUrl.includes('://') && !repoUrl.includes('@')) return res.status(400).json({ message: 'URL inválida.' });

    try { // Garante pasta de clones
        if (!fs.existsSync(commonClonePath)) fs.mkdirSync(commonClonePath, { recursive: true });
    } catch (mkdirErr) { console.error(`[ERROR] Criar ${commonClonePath}:`, mkdirErr); return res.status(500).json({ message: `Falha: ${mkdirErr.message}` }); }

    let repoName = 'unknown-repo';
    try { // Extrai nome
        repoName = path.basename(repoUrl, '.git').split(/[:/]/).pop() || 'cloned-repo';
        repoName = repoName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
        if (!repoName) repoName = 'cloned-repo-' + uuidv4().substring(0, 8);
    } catch (e) { repoName = 'cloned-repo-' + uuidv4().substring(0, 8); }

    const finalRepoPath = path.join(commonClonePath, repoName);
    if (fs.existsSync(finalRepoPath)) return res.status(409).json({ message: `Diretório '${repoName}' já existe.` });

    const cloneCommand = `git clone --depth 1 --recurse-submodules "${repoUrl}" "${finalRepoPath}"`;
    console.log(`[INFO] Executando: ${cloneCommand}`);

    exec(cloneCommand, { timeout: 120000, cwd: basePath }, (error, stdout, stderr) => {
        if (error) {
            const errMsg = error.message || "Erro Git."; const stderrMsg = stderr || "-";
            console.error(`[ERROR] Clone ${repoUrl}:`, errMsg); console.error(`[ERROR] Stderr: ${stderrMsg}`);
            if (fs.existsSync(finalRepoPath)) fs.rm(finalRepoPath, { recursive: true, force: true }, (rmErr) => { if(rmErr) console.error(`[WARN] Limpeza ${finalRepoPath} falhou:`, rmErr);});
            return res.status(500).json({ message: `Falha: ${errMsg}`, stderr: stderrMsg });
        }

        console.log(`[INFO] Clonado com sucesso: ${finalRepoPath}`);

        // --- CRIA E ADICIONA PLACEHOLDER ---
        const placeholderServer = {
            id: uuidv4(),
            name: repoName, // Usa nome do repo como nome inicial
            description: `Auto-adicionado via clone de ${repoUrl}. Edite para configurar!`,
            command: "node", // Palpite comum
             // Tenta adivinhar um arquivo principal comum
            args: [ path.join(finalRepoPath, 'index.js') ], // Palpite comum (ajuste se necessário)
            env: {}
        };
         // Verifica se já existe um com mesmo nome (improvável, mas seguro)
         if (!configuredServers.some(s => s.name === placeholderServer.name)) {
             configuredServers.push(placeholderServer);
             saveServersConfig();
             console.log(`[INFO] Placeholder para '${repoName}' adicionado à configuração.`);
             notifyConfigUpdate(); // Notifica UI sobre a adição
             res.status(200).json({ message: `Repositório clonado e placeholder adicionado como '${repoName}'! Edite-o abaixo.`, path: finalRepoPath });
         } else {
              console.warn(`[WARN] Placeholder para '${repoName}' não adicionado, nome já existe.`);
              res.status(200).json({ message: `Repositório clonado, mas um servidor com nome '${repoName}' já existe. Adicione manualmente.`, path: finalRepoPath });
         }
        // ----------------------------------
    });
});


// --- Inicialização e Shutdown (sem mudanças significativas na lógica final) ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/" });
wss.on('connection', (ws, req) => { /* ... Lógica de conexão WS ... */
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[WebSocket] Cliente conectado. IP: ${clientIp}`);
    ws.on('close', (code, reason) => console.log(`[WebSocket] Cliente ${clientIp} desconectado. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}`));
    ws.on('error', (error) => console.error(`[WebSocket] Erro cliente ${clientIp}:`, error));
    ws.on('message', (message) => console.log(`[WebSocket] Msg ${clientIp}: ${message.toString().substring(0,100)}...`));
     try { const servers = configuredServers.map(s => ({...s, status: runningServers[s.id]?.status || 'stopped'})); ws.send(JSON.stringify({ type: 'initial_state', servers })); } catch (err) { console.error("[WS Error] Send initial state failed:", err); }
});
wss.on('error', (error) => console.error("[WebSocket Server Error]", error));

try { loadServersConfig(); server.listen(port, '0.0.0.0', () => { console.log(`\n MCP Manager backend em http://localhost:${port} \n`); }); }
catch (loadError) { console.error("[FATAL] Load config failed. Saindo.", loadError); process.exit(1); }

let isShuttingDown = false;
function shutdown(signal) { /* ... Lógica de shutdown gracioso ... */
    if (isShuttingDown) return; isShuttingDown = true; console.log(`\n[INFO] ${signal}. Desligando...`);
    const closeTimeoutMs = 5000; let shutdownTimer = null;
    const closeHttp = new Promise(r => { console.log("[HTTP/WS] Fechando..."); wss.clients.forEach(c => c.terminate()); server.close(e => { if(e) console.error("[HTTP Err]", e); else console.log("[HTTP] Fechado."); r(); }); setTimeout(() => { server.closeIdleConnections?.(); r(); }, closeTimeoutMs/2); });
    const stopChildren = new Promise(r => { const children = Object.values(runningServers).filter(i => i.process); if (children.length === 0) { console.log("[PROC] Nenhum filho ativo."); r(); return; } console.log(`[PROC] SIGTERM para ${children.length}...`); let closed = 0; const check = () => { if (closed >= children.length) { console.log("[PROC] Filhos terminaram."); r(); } }; children.forEach(i => { i.process.once('close', () => { closed++; check(); }); try { if (!i.process.kill('SIGTERM')) { closed++; check(); }} catch (e) { closed++; check();}}); setTimeout(() => { if (closed < children.length) { console.warn(`[PROC TIMEOUT] Forçando SIGKILL...`); children.forEach(i => { if (i.process && !i.process.killed) try { i.process.kill('SIGKILL'); } catch (e) {} }); } r(); }, closeTimeoutMs - 500); });
    Promise.all([closeHttp, stopChildren]).then(() => { clearTimeout(shutdownTimer); console.log("[SHUTDOWN] Completo."); process.exit(0); }).catch(e => { console.error("[SHUTDOWN ERROR]", e); process.exit(1); });
    shutdownTimer = setTimeout(() => { console.error("[SHUTDOWN TIMEOUT] Forçando saída."); process.exit(1); }, closeTimeoutMs + 1000);
}
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e, o) => { console.error('\n[FATAL] Uncaught Exception:', e, 'Origin:', o, '\n'); if (!isShuttingDown) { shutdown('uncaughtException'); setTimeout(() => process.exit(1), 2000); } else process.exit(1); });
process.on('unhandledRejection', (r, p) => console.error('\n[FATAL] Unhandled Rejection:', r, '\n'));
// Fim