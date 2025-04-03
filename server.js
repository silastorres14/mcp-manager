const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = 3000; // Porta para o backend web
const serversFilePath = path.join(__dirname, 'servers.json');

// Middlewares
app.use(cors()); // Permite requisições de outras origens (ex: frontend)
app.use(express.json()); // Para parsear corpos de requisição JSON
app.use(express.static(path.join(__dirname, 'public'))); // Serve arquivos estáticos (HTML, CSS, JS)

// --- Gerenciamento de Servidores MCP ---
let configuredServers = [];
const runningServers = {}; // Guarda { id: { process: childProcess, status: 'running' | 'stopped' | 'error' } }

// Função para carregar configurações
function loadServersConfig() {
    try {
        if (fs.existsSync(serversFilePath)) {
            const data = fs.readFileSync(serversFilePath, 'utf-8');
            configuredServers = JSON.parse(data);
        } else {
            configuredServers = [];
            saveServersConfig(); // Cria o arquivo se não existir
        }
    } catch (err) {
        console.error("Erro ao carregar servers.json:", err);
        configuredServers = [];
    }
}

// Função para salvar configurações
function saveServersConfig() {
    try {
        fs.writeFileSync(serversFilePath, JSON.stringify(configuredServers, null, 2), 'utf-8');
    } catch (err) {
        console.error("Erro ao salvar servers.json:", err);
    }
}

// Função para transmitir dados via WebSocket para todos os clientes conectados
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// --- API Endpoints ---

// Listar todos os servidores configurados com status atual
app.get('/api/servers', (req, res) => {
    const serversWithStatus = configuredServers.map(server => ({
        ...server,
        status: runningServers[server.id]?.status || 'stopped'
    }));
    res.json(serversWithStatus);
});

// Adicionar um novo servidor
app.post('/api/servers', (req, res) => {
    const newServer = { ...req.body, id: uuidv4() };
    configuredServers.push(newServer);
    saveServersConfig();
    res.status(201).json(newServer);
    broadcast({ type: 'config_update', servers: configuredServers.map(s => ({...s, status: runningServers[s.id]?.status || 'stopped'})) });
});

// Atualizar um servidor (simplificado - substitui tudo exceto ID)
app.put('/api/servers/:id', (req, res) => {
    const serverId = req.params.id;
    const index = configuredServers.findIndex(s => s.id === serverId);
    if (index === -1) {
        return res.status(404).json({ message: 'Servidor não encontrado' });
    }
    if (runningServers[serverId]?.status === 'running') {
        return res.status(400).json({ message: 'Pare o servidor antes de editar.' });
    }
    configuredServers[index] = { ...req.body, id: serverId }; // Mantém o ID original
    saveServersConfig();
    res.json(configuredServers[index]);
    broadcast({ type: 'config_update', servers: configuredServers.map(s => ({...s, status: runningServers[s.id]?.status || 'stopped'})) });
});


// Remover um servidor
app.delete('/api/servers/:id', (req, res) => {
    const serverId = req.params.id;
    if (runningServers[serverId]?.status === 'running') {
        return res.status(400).json({ message: 'Pare o servidor antes de deletar.' });
    }
    configuredServers = configuredServers.filter(s => s.id !== serverId);
    delete runningServers[serverId]; // Limpa estado se houver
    saveServersConfig();
    res.status(204).send();
    broadcast({ type: 'config_update', servers: configuredServers.map(s => ({...s, status: runningServers[s.id]?.status || 'stopped'})) });
});

// Iniciar um servidor
app.post('/api/servers/:id/start', (req, res) => {
    const serverId = req.params.id;
    const serverConfig = configuredServers.find(s => s.id === serverId);

    if (!serverConfig) {
        return res.status(404).json({ message: 'Configuração do servidor não encontrada.' });
    }
    if (runningServers[serverId]?.status === 'running') {
        return res.status(400).json({ message: 'Servidor já está rodando.' });
    }

    console.log(`Iniciando servidor: ${serverConfig.name} (${serverId})`);
    broadcast({ type: 'status', serverId, status: 'starting' });

    try {
        // Garante que 'env' seja um objeto
        const env = { ...process.env, ...(serverConfig.env || {}) };

        const child = spawn(serverConfig.command, serverConfig.args || [], {
            env: env,
            shell: process.platform === 'win32' // Usar shell no windows pode ajudar com paths e comandos
        });

        runningServers[serverId] = { process: child, status: 'running' };
        broadcast({ type: 'status', serverId, status: 'running', pid: child.pid });
        console.log(`Servidor ${serverId} iniciado com PID: ${child.pid}`);

        child.stdout.on('data', (data) => {
            const message = data.toString();
            console.log(`[${serverId} - STDOUT] ${message}`);
            broadcast({ type: 'log', serverId, stream: 'stdout', message });
        });

        child.stderr.on('data', (data) => {
            const message = data.toString();
            console.error(`[${serverId} - STDERR] ${message}`);
            broadcast({ type: 'log', serverId, stream: 'stderr', message });
        });

        child.on('error', (err) => {
            console.error(`[${serverId} - ERROR] Erro ao iniciar o processo:`, err);
            runningServers[serverId] = { process: null, status: 'error' };
            broadcast({ type: 'status', serverId, status: 'error', message: err.message });
            delete runningServers[serverId]; // Limpa após erro
        });

        child.on('close', (code) => {
            console.log(`[${serverId} - CLOSE] Processo encerrado com código ${code}`);
             const finalStatus = code === 0 ? 'stopped' : 'error';
             if(runningServers[serverId]) { // Checa se ainda existe (pode ter sido parado manualmente)
                 runningServers[serverId].status = finalStatus;
             }
            broadcast({ type: 'status', serverId, status: finalStatus, code });
            // Não remove de runningServers aqui, status 'stopped' ou 'error' é útil
        });

         child.on('exit', (code) => {
             console.log(`[${serverId} - EXIT] Processo saiu com código ${code}`);
             // O evento 'close' é geralmente mais confiável para saber quando os streams fecharam
             // Atualiza status final, caso 'close' não tenha pego
             const finalStatus = code === 0 ? 'stopped' : 'error';
              if(runningServers[serverId] && runningServers[serverId].status === 'running') {
                 runningServers[serverId].status = finalStatus;
                  broadcast({ type: 'status', serverId, status: finalStatus, code });
              }
               delete runningServers[serverId]; // Limpa o processo da memória ativa
         });


        res.status(200).json({ message: 'Comando de início enviado.' });

    } catch (error) {
        console.error(`Erro ao tentar iniciar ${serverId}:`, error);
        broadcast({ type: 'status', serverId, status: 'error', message: error.message });
        res.status(500).json({ message: `Erro ao iniciar servidor: ${error.message}` });
    }
});

// Parar um servidor
app.post('/api/servers/:id/stop', (req, res) => {
    const serverId = req.params.id;
    const serverInfo = runningServers[serverId];

    if (!serverInfo || serverInfo.status !== 'running') {
        // Se não está rodando mas existe (ex: status 'error'), limpa
        if(serverInfo) delete runningServers[serverId];
        broadcast({ type: 'status', serverId, status: 'stopped' }); // Garante que UI mostre 'stopped'
        return res.status(400).json({ message: 'Servidor não está rodando ou já foi parado.' });
    }

    console.log(`Parando servidor: ${serverId} (PID: ${serverInfo.process.pid})`);
    broadcast({ type: 'status', serverId, status: 'stopping' });

    try {
        // Tenta terminar graciosamente primeiro
        const killed = serverInfo.process.kill('SIGTERM'); // Ou 'SIGINT'

        if (!killed) {
             console.warn(`Falha ao enviar SIGTERM para ${serverId}. Tentando SIGKILL.`);
             serverInfo.process.kill('SIGKILL'); // Força parada
        }

        // O status final será atualizado pelos listeners 'close'/'exit'
        // Mas podemos remover da lista ativa aqui para evitar comandos duplicados
        delete runningServers[serverId];

        res.status(200).json({ message: 'Comando de parada enviado.' });

    } catch (error) {
        console.error(`Erro ao tentar parar ${serverId}:`, error);
        // Se o processo já morreu, pode dar erro. Considera como parado.
        delete runningServers[serverId];
        broadcast({ type: 'status', serverId, status: 'error', message: `Erro ao parar: ${error.message}. Considerado parado.` });
        res.status(500).json({ message: `Erro ao parar servidor: ${error.message}` });
    }
});


// --- Inicialização ---
const server = http.createServer(app); // Cria servidor HTTP usando o app Express
const wss = new WebSocket.Server({ server }); // Anexa WebSocket ao servidor HTTP

wss.on('connection', (ws) => {
    console.log('Cliente WebSocket conectado');
    ws.on('message', (message) => {
        // Poderia implementar comunicação bidirecional se necessário
        console.log('Mensagem recebida:', message);
    });
    ws.on('close', () => {
        console.log('Cliente WebSocket desconectado');
    });
    // Envia o status atual ao conectar novo cliente (opcional)
     const serversWithStatus = configuredServers.map(server => ({
        ...server,
        status: runningServers[server.id]?.status || 'stopped'
    }));
     ws.send(JSON.stringify({ type: 'initial_state', servers: serversWithStatus }));
});

server.listen(port, () => {
    loadServersConfig();
    console.log(`MCP Manager backend rodando em http://localhost:${port}`);
    console.log(`Acesse o frontend em http://localhost:${port}`);
});

// --- Graceful Shutdown ---
function shutdown() {
    console.log("Desligando MCP Manager...");
    Object.keys(runningServers).forEach(serverId => {
        const serverInfo = runningServers[serverId];
        if (serverInfo.process) {
            console.log(`Parando ${serverId} (PID: ${serverInfo.process.pid}) graciosamente...`);
            serverInfo.process.kill('SIGTERM'); // Tenta terminar
        }
    });
    server.close(() => {
        console.log("Servidor HTTP fechado.");
        process.exit(0);
    });

    // Força saída após um timeout se o graceful shutdown falhar
    setTimeout(() => {
        console.error("Desligamento forçado após timeout.");
        process.exit(1);
    }, 5000); // 5 segundos de timeout
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown); // Captura Ctrl+C