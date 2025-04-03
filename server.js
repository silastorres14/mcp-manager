const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// --- Determinação do Caminho Base e Paths Principais ---
const basePath = process.pkg ? path.dirname(process.execPath) : __dirname;
console.log(`[INFO] Base path (for external files like servers.json): ${basePath}`);
const serversFilePath = path.join(basePath, 'servers.json');
const commonClonePath = path.join(basePath, 'cloned_servers');
const publicPath = path.join(__dirname, 'public'); // Path para assets empacotados
console.log(`[INFO] Static assets path (frontend): ${publicPath}`);
// -------------------------------------------------

const app = express();
const port = 3000;

// --- Verificação da Pasta Pública (Debug) ---
try {
    if (!fs.existsSync(publicPath)) {
         console.error(`[ERROR] Directory 'public' NOT FOUND at snapshot path: ${publicPath}. Check 'pkg.assets' in package.json.`);
    } else {
        if (!fs.existsSync(path.join(publicPath, 'index.html'))) {
             console.error("[ERROR] index.html not found within the public directory inside the snapshot!");
        }
    }
} catch (err) { console.error(`[ERROR] Error checking public path existence: ${err}`); }
// --------------------------------------------------

// Middlewares
app.use(cors());
app.use(express.json({ limit: '1mb' })); // Limita tamanho do JSON payload
app.use(express.static(publicPath)); // Serve o frontend

// --- Gerenciamento de Servidores MCP ---
let configuredServers = [];
const runningServers = {}; // { id: { process, status, pid } }

// Função para carregar configurações (Melhorada)
function loadServersConfig() {
    try {
        if (fs.existsSync(serversFilePath)) {
            const data = fs.readFileSync(serversFilePath, 'utf-8');
            try {
                const parsedData = JSON.parse(data || '[]'); // Default to empty array if file is empty
                if (Array.isArray(parsedData)) {
                    configuredServers = parsedData;
                } else {
                    console.error(`[ERROR] ${serversFilePath} não contém um array JSON. Iniciando com array vazio.`);
                    configuredServers = [];
                    saveServersConfig(); // Sobrescreve arquivo inválido
                }
            } catch (parseErr) {
                 console.error(`[ERROR] Falha ao parsear JSON de ${serversFilePath}: ${parseErr.message}. Iniciando com array vazio.`);
                 configuredServers = [];
                 // Opcional: Fazer backup do arquivo inválido antes de sobrescrever
                 // fs.copyFileSync(serversFilePath, `${serversFilePath}.invalid-${Date.now()}`);
                 saveServersConfig(); // Sobrescreve arquivo inválido
            }
        } else {
            console.log(`[INFO] Config file ${serversFilePath} not found, creating empty default.`);
            configuredServers = [];
            saveServersConfig();
        }
         console.log(`[INFO] ${configuredServers.length} servidor(es) carregado(s) de ${serversFilePath}`);
    } catch (err) {
        console.error(`[ERROR] Erro fatal ao carregar ${serversFilePath}:`, err);
        configuredServers = []; // Garante que é um array vazio em caso de erro de leitura
    }
}

// Função para salvar configurações
function saveServersConfig() {
    try {
        fs.writeFileSync(serversFilePath, JSON.stringify(configuredServers, null, 2), 'utf-8');
        console.log(`[INFO] Configuração salva em ${serversFilePath}`);
    } catch (err) {
        console.error(`[ERROR] Erro ao salvar ${serversFilePath}:`, err);
        // TODO: Considerar notificar UI sobre falha ao salvar?
    }
}

// Função para transmitir dados via WebSocket
function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message, (err) => {
                if (err) {
                    console.error("[WebSocket Error] Failed to send message to a client:", err);
                }
            });
        }
    });
}

// --- API Endpoints (Já existentes, apenas garantindo robustez) ---

// GET /api/servers : Listar todos
app.get('/api/servers', (req, res) => {
    try {
        // Retorna o estado ATUAL em memória, que reflete o servers.json carregado/salvo
        const serversWithStatus = configuredServers.map(server => ({
            ...server,
            status: runningServers[server.id]?.status || 'stopped'
        }));
        res.json(serversWithStatus);
    } catch (error) {
        console.error("[API ERROR] GET /api/servers:", error);
        res.status(500).json({ message: "Erro interno ao buscar servidores." });
    }
});

// POST /api/servers : Adicionar novo
app.post('/api/servers', (req, res) => {
    try {
        if (!req.body || typeof req.body !== 'object' || !req.body.name || !req.body.command) {
             return res.status(400).json({ message: "Dados inválidos: Nome e Comando são obrigatórios." });
        }
        const newServer = {
             id: uuidv4(),
             name: req.body.name.trim(),
             description: (req.body.description || "").trim(),
             command: req.body.command.trim(),
             args: Array.isArray(req.body.args) ? req.body.args.map(arg => String(arg).trim()).filter(Boolean) : [],
             env: (typeof req.body.env === 'object' && req.body.env !== null && !Array.isArray(req.body.env)) ? req.body.env : {}
         };
        configuredServers.push(newServer);
        saveServersConfig(); // Salva no JSON
        const status = 'stopped'; // Novo servidor sempre começa parado
        res.status(201).json({...newServer, status}); // Retorna o novo servidor
        broadcast({ type: 'config_update', servers: configuredServers.map(s => ({...s, status: runningServers[s.id]?.status || 'stopped'})) }); // Notifica todos os clientes
    } catch (error) {
        console.error("[API ERROR] POST /api/servers:", error);
        res.status(500).json({ message: "Erro interno ao adicionar servidor." });
    }
});

// PUT /api/servers/:id : Atualizar existente
app.put('/api/servers/:id', (req, res) => {
     try {
        const serverId = req.params.id;
        const index = configuredServers.findIndex(s => s.id === serverId);

        if (index === -1) {
            return res.status(404).json({ message: 'Servidor não encontrado na configuração.' });
        }
        if (!req.body || typeof req.body !== 'object' || !req.body.name || !req.body.command) {
             return res.status(400).json({ message: "Dados inválidos: Nome e Comando são obrigatórios." });
        }
        const currentStatus = runningServers[serverId]?.status;
        if (currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping') {
            return res.status(400).json({ message: `Servidor está ${currentStatus}. Pare-o antes de editar.` });
        }

        const updatedServerData = {
            id: serverId,
            name: req.body.name.trim(),
            description: (req.body.description || "").trim(),
            command: req.body.command.trim(),
            args: Array.isArray(req.body.args) ? req.body.args.map(arg => String(arg).trim()).filter(Boolean) : [],
            env: (typeof req.body.env === 'object' && req.body.env !== null && !Array.isArray(req.body.env)) ? req.body.env : {}
        };

        configuredServers[index] = updatedServerData;
        saveServersConfig(); // Salva no JSON
        const status = runningServers[serverId]?.status || 'stopped';
        res.json({...updatedServerData, status});
        broadcast({ type: 'config_update', servers: configuredServers.map(s => ({...s, status: runningServers[s.id]?.status || 'stopped'})) }); // Notifica todos os clientes
     } catch (error) {
        console.error(`[API ERROR] PUT /api/servers/${req.params.id}:`, error);
        res.status(500).json({ message: "Erro interno ao atualizar servidor." });
     }
});

// DELETE /api/servers/:id : Remover
app.delete('/api/servers/:id', (req, res) => {
    try {
        const serverId = req.params.id;
        const serverIndex = configuredServers.findIndex(s => s.id === serverId);
        const currentStatus = runningServers[serverId]?.status;

        if (currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping') {
            return res.status(400).json({ message: `Servidor está ${currentStatus}. Pare-o antes de deletar.` });
        }

        let broadcastNeeded = false;

        if (serverIndex > -1) {
            configuredServers.splice(serverIndex, 1);
            saveServersConfig(); // Salva no JSON
            broadcastNeeded = true;
        } else {
            console.warn(`[WARN] Tentativa de deletar servidor ${serverId} não encontrado na configuração.`);
        }

        if (runningServers[serverId]) {
             delete runningServers[serverId]; // Remove da memória de execução
             broadcastNeeded = true;
        }

        res.status(204).send(); // No Content
        if (broadcastNeeded) {
            broadcast({ type: 'config_update', servers: configuredServers.map(s => ({...s, status: runningServers[s.id]?.status || 'stopped'})) }); // Notifica todos os clientes
        }
    } catch (error) {
        console.error(`[API ERROR] DELETE /api/servers/${req.params.id}:`, error);
        res.status(500).json({ message: "Erro interno ao deletar servidor." });
    }
});

// POST /api/servers/:id/start : Ligar servidor
app.post('/api/servers/:id/start', (req, res) => {
    const serverId = req.params.id;
    const serverConfig = configuredServers.find(s => s.id === serverId);

    if (!serverConfig) return res.status(404).json({ message: 'Configuração do servidor não encontrada.' });

    const currentStatus = runningServers[serverId]?.status;
    if (currentStatus === 'running' || currentStatus === 'starting' || currentStatus === 'stopping') {
        return res.status(400).json({ message: `Servidor já está ${currentStatus}.` });
    }

    console.log(`[INFO] Iniciando servidor: ${serverConfig.name} (${serverId})`);
    broadcast({ type: 'status', serverId, status: 'starting' });
    runningServers[serverId] = { process: null, status: 'starting', pid: null };

    try {
        const env = { ...process.env, ...(serverConfig.env || {}) };
        let cwd = basePath;

        try {
            let potentialPath;
             if (serverConfig.command === 'node' && serverConfig.args && serverConfig.args.length > 0) {
                 potentialPath = path.resolve(basePath, serverConfig.args[0]);
             } else if (serverConfig.command !== 'node') {
                  potentialPath = path.resolve(basePath, serverConfig.command);
             }

             if (potentialPath && fs.existsSync(potentialPath)) {
                  const stats = fs.lstatSync(potentialPath);
                  cwd = stats.isDirectory() ? potentialPath : path.dirname(potentialPath);
             } else if (serverConfig.args && serverConfig.args.length > 0) {
                  const firstArgDir = path.dirname(path.resolve(basePath, serverConfig.args[0]));
                  if (fs.existsSync(firstArgDir)){ cwd = firstArgDir; }
             }
             console.log(`[DEBUG] Determined CWD for ${serverId}: ${cwd}`);
        } catch(e) {
            console.warn(`[WARN] Erro ao determinar CWD específico para ${serverId}, usando basePath: ${e.message}`);
            cwd = basePath;
        }

        const child = spawn(serverConfig.command, serverConfig.args || [], { env, cwd, shell: process.platform === 'win32' });

        if (!child || !child.pid) {
             throw new Error("Falha ao iniciar o processo filho (PID não encontrado). Verifique o comando e permissões.");
        }

        runningServers[serverId] = { process: child, status: 'running', pid: child.pid };
        broadcast({ type: 'status', serverId, status: 'running', pid: child.pid });
        console.log(`[INFO] Servidor ${serverId} iniciado com PID: ${child.pid}`);

        // --- Handlers ---
        child.stdout.on('data', (data) => broadcast({ type: 'log', serverId, stream: 'stdout', message: data.toString() }) );
        child.stderr.on('data', (data) => {
            const message = data.toString();
            console.error(`[${serverId} STDERR] ${message.trim()}`);
            broadcast({ type: 'log', serverId, stream: 'stderr', message });
        });
        child.on('error', (err) => {
            console.error(`[${serverId} ERROR] Falha no processo filho:`, err);
            if (runningServers[serverId]) { runningServers[serverId].status = 'error'; runningServers[serverId].process = null; }
            broadcast({ type: 'status', serverId, status: 'error', message: `Erro no processo: ${err.message}` });
        });
        child.on('close', (code, signal) => {
            const pid = child.pid || runningServers[serverId]?.pid || 'UNKNOWN';
            console.log(`[INFO] [${serverId} CLOSE] Processo PID ${pid} encerrado (code: ${code}, signal: ${signal})`);
             if (runningServers[serverId]) {
                 const finalStatus = (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') ? 'stopped' : 'error';
                 runningServers[serverId].status = finalStatus;
                 runningServers[serverId].process = null;
                 broadcast({ type: 'status', serverId, status: finalStatus, code, signal });
             }
        });
        child.on('exit', (code, signal) => {
             const pid = child.pid || runningServers[serverId]?.pid || 'UNKNOWN';
             console.log(`[DEBUG] [${serverId} EXIT] Processo PID ${pid} saiu (code: ${code}, signal: ${signal})`);
         });
        // ---------------

        res.status(200).json({ message: 'Comando de início enviado.' });

    } catch (error) {
        console.error(`[ERROR] Erro geral ao tentar iniciar ${serverId}:`, error);
        runningServers[serverId] = { process: null, status: 'error', pid: null };
        broadcast({ type: 'status', serverId, status: 'error', message: `Erro interno ao iniciar: ${error.message}` });
        res.status(500).json({ message: `Erro ao iniciar servidor: ${error.message}` });
    }
});

// POST /api/servers/:id/stop : Parar servidor
app.post('/api/servers/:id/stop', (req, res) => {
    const serverId = req.params.id;
    const serverInfo = runningServers[serverId];

    if (!serverInfo || !serverInfo.process) {
        if(serverInfo) serverInfo.status = 'stopped';
        broadcast({ type: 'status', serverId, status: 'stopped' });
        return res.status(400).json({ message: 'Servidor não está rodando ou já foi parado.' });
    }
     if (serverInfo.status !== 'running') {
         return res.status(400).json({ message: `Servidor está ${serverInfo.status}, não pode parar.` });
     }

    const pid = serverInfo.pid;
    console.log(`[INFO] Parando servidor: ${serverId} (PID: ${pid})`);
    serverInfo.status = 'stopping';
    broadcast({ type: 'status', serverId, status: 'stopping' });

    try {
        const forceKillTimeout = setTimeout(() => {
            if (runningServers[serverId]?.process && runningServers[serverId]?.status === 'stopping') {
                 console.warn(`[WARN] Processo ${serverId} (PID: ${pid}) não terminou após SIGTERM. Forçando SIGKILL.`);
                 try { runningServers[serverId].process.kill('SIGKILL'); } catch (killErr){ console.error(`Erro ao forçar kill PID ${pid}:`, killErr);}
            }
        }, 3000);

        serverInfo.process.once('close', () => clearTimeout(forceKillTimeout) );

        console.log(`[DEBUG] Enviando SIGTERM para ${serverId} (PID: ${pid})...`);
        if (!serverInfo.process.kill('SIGTERM')) {
             console.warn(`[WARN] SIGTERM falhou imediatamente para PID ${pid}. Processo pode já ter morrido.`);
             clearTimeout(forceKillTimeout);
        }

        res.status(200).json({ message: 'Comando de parada enviado.' });

    } catch (error) {
        console.error(`[ERROR] Erro ao tentar parar ${serverId} (PID: ${pid}):`, error);
        serverInfo.status = 'error';
        serverInfo.process = null;
        broadcast({ type: 'status', serverId, status: 'error', message: `Erro ao parar: ${error.message}.` });
        res.status(500).json({ message: `Erro ao parar servidor: ${error.message}` });
    }
});

// POST /api/git/clone : Clonar repositório
app.post('/api/git/clone', (req, res) => {
    const { repoUrl } = req.body;

    if (!repoUrl) return res.status(400).json({ message: 'URL do Repositório é obrigatória.' });
    if (!repoUrl.includes('://') && !repoUrl.includes('@')) {
        return res.status(400).json({ message: 'URL do Repositório parece inválida (ex: https://... ou git@...).' });
    }

    try {
        if (!fs.existsSync(commonClonePath)) {
            fs.mkdirSync(commonClonePath, { recursive: true });
            console.log(`[INFO] Diretório de clones criado: ${commonClonePath}`);
        }
    } catch (mkdirErr) {
        console.error(`[ERROR] Erro ao criar diretório de clones ${commonClonePath}:`, mkdirErr);
        return res.status(500).json({ message: `Falha ao criar diretório de clones: ${mkdirErr.message}` });
    }

    let repoName = 'unknown-repo';
    try {
        repoName = path.basename(repoUrl, '.git');
        repoName = repoName.split(/[:/]/).pop() || repoName;
        repoName = repoName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
        if (!repoName) throw new Error("Nome vazio após parse");
    } catch (e) {
        console.warn("[WARN] Não foi possível extrair nome do repo da URL, usando fallback:", e);
        repoName = 'cloned-repo-' + uuidv4().substring(0, 8);
    }

    const finalRepoPath = path.join(commonClonePath, repoName);

    if (fs.existsSync(finalRepoPath)) {
        console.warn(`[WARN] Diretório de destino já existe: ${finalRepoPath}`);
        return res.status(409).json({ message: `O diretório '${repoName}' já existe em ${commonClonePath}. Remova-o manualmente se desejar clonar novamente.` });
    }

    const cloneCommand = `git clone --depth 1 --recurse-submodules "${repoUrl}" "${finalRepoPath}"`;
    console.log(`[INFO] Executando: ${cloneCommand}`);

    exec(cloneCommand, { timeout: 120000, cwd: basePath }, (error, stdout, stderr) => {
        if (error) {
            const errMsg = error.message || "Erro desconhecido no Git.";
            const stderrMsg = stderr || "Sem saída de erro padrão.";
            console.error(`[ERROR] Erro ao clonar ${repoUrl}:`, errMsg);
            console.error(`[ERROR] Stderr: ${stderrMsg}`);
            if (fs.existsSync(finalRepoPath)) {
                fs.rm(finalRepoPath, { recursive: true, force: true }, (rmErr) => {
                     if(rmErr) console.error(`[WARN] Erro ao limpar ${finalRepoPath} após falha no clone:`, rmErr);
                });
           }
            return res.status(500).json({ message: `Falha ao clonar: ${errMsg}`, stderr: stderrMsg });
        }

        console.log(`[INFO] Stdout (clone): ${stdout.trim()}`);
        console.log(`[INFO] Repositório clonado com sucesso em: ${finalRepoPath}`);
        res.status(200).json({
            message: `Repositório clonado com sucesso como '${repoName}'!`,
            path: finalRepoPath // Envia o caminho absoluto final
        });
    });
});


// --- Inicialização do Servidor HTTP e WebSocket ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/" });

wss.on('connection', (ws, req) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[WebSocket] Cliente conectado. IP: ${clientIp}`);
    ws.on('close', (code, reason) => console.log(`[WebSocket] Cliente ${clientIp} desconectado. Code: ${code}, Reason: ${reason ? reason.toString().substring(0,100) : 'N/A'}`));
    ws.on('error', (error) => console.error(`[WebSocket] Erro na conexão do cliente ${clientIp}:`, error));
    ws.on('message', (message) => console.log(`[WebSocket] Mensagem recebida de ${clientIp}: ${message.toString().substring(0,100)}...`)); // Apenas loga por enquanto

     try { // Envia estado inicial
        const serversWithStatus = configuredServers.map(server => ({...server, status: runningServers[server.id]?.status || 'stopped'}));
        ws.send(JSON.stringify({ type: 'initial_state', servers: serversWithStatus }));
     } catch (err) { console.error("[WebSocket Error] Failed to send initial state:", err); }
});
wss.on('error', (error) => console.error("[WebSocket Server Error]", error));

// Carrega config e inicia o servidor
try {
    loadServersConfig();
    server.listen(port, '0.0.0.0', () => {
        console.log(`\n=================================================`);
        console.log(` MCP Manager backend rodando em http://localhost:${port}`);
        console.log(`             (Acessível também pela rede local)`);
        console.log(` Frontend servido de: ${publicPath}`);
        console.log(` Configuração lida de: ${serversFilePath}`);
        console.log(` Clones Git em: ${commonClonePath}`);
        console.log(`=================================================\n`);
    });
} catch (loadError) {
     console.error("[FATAL] Não foi possível carregar a configuração inicial. Saindo.", loadError);
     process.exit(1);
}

// --- Graceful Shutdown ---
let isShuttingDown = false;
function shutdown(signal) {
    if (isShuttingDown) { console.log("[INFO] Desligamento já em progresso..."); return; }
    isShuttingDown = true;
    console.log(`\n[INFO] Recebido ${signal}. Desligando MCP Manager graciosamente...`);
    const closeTimeoutMs = 5000;
    let shutdownTimer = null;

    const closeHttpServer = new Promise((resolve) => {
        console.log("[HTTP/WS] Fechando servidor e conexões WebSocket...");
        wss.clients.forEach(client => client.terminate());
        server.close((err) => {
             if (err) console.error("[HTTP Error] Erro ao fechar servidor:", err); else console.log("[HTTP] Servidor fechado.");
             resolve();
        });
         setTimeout(() => { server.closeIdleConnections?.(); resolve(); }, closeTimeoutMs / 2);
    });

    const stopChildProcesses = new Promise((resolve) => {
        const runningChildren = Object.values(runningServers).filter(info => info.process && info.pid);
        if (runningChildren.length === 0) { console.log("[PROCESS] Nenhum processo filho ativo para parar."); resolve(); return; }
        console.log(`[PROCESS] Enviando SIGTERM para ${runningChildren.length} processo(s)...`);
        let processesClosedCount = 0;
        const checkAllClosed = () => { if (processesClosedCount >= runningChildren.length) { console.log("[PROCESS] Todos os filhos terminaram."); resolve(); } };
        runningChildren.forEach(info => {
            info.process.once('close', () => { processesClosedCount++; checkAllClosed(); });
            try { if (!info.process.kill('SIGTERM')) { processesClosedCount++; checkAllClosed(); }}
            catch (e) { console.error(`Erro SIGTERM PID ${info.pid}: ${e.message}`); processesClosedCount++; checkAllClosed();}
        });
         setTimeout(() => { // Timeout para SIGKILL
              if (processesClosedCount < runningChildren.length) {
                  console.warn(`[PROCESS TIMEOUT] Forçando SIGKILL nos restantes...`);
                  runningChildren.forEach(info => { if (info.process && !info.process.killed) try { info.process.kill('SIGKILL'); } catch (e) {} });
              } resolve(); }, closeTimeoutMs - 500);
    });

    console.log("[SHUTDOWN] Aguardando finalização...");
    Promise.all([closeHttpServer, stopChildProcesses])
      .then(() => { clearTimeout(shutdownTimer); console.log("[SHUTDOWN] Desligamento completo. Saindo."); process.exit(0); })
      .catch(err => { console.error("[SHUTDOWN ERROR]", err); process.exit(1); });
    shutdownTimer = setTimeout(() => { console.error("[SHUTDOWN TIMEOUT] Forçando saída."); process.exit(1); }, closeTimeoutMs + 1000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error, origin) => {
     console.error('\n[FATAL] Exceção não capturada:', error, 'Origem:', origin, '\n');
     if (!isShuttingDown) { shutdown('uncaughtException'); setTimeout(() => process.exit(1), 2000); }
     else { process.exit(1); }
});
process.on('unhandledRejection', (reason, promise) => {
     console.error('\n[FATAL] Rejeição de Promise não tratada:', reason, '\n');
     // process.exit(1); // Descomente para sair em caso de unhandled rejection
});

// Fim do arquivo server.js