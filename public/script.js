document.addEventListener('DOMContentLoaded', () => {
    // Elementos da UI
    const serverList = document.getElementById('server-list');
    const logsOutput = document.getElementById('logs');
    const logContainer = document.getElementById('log-container');
    const logServerName = document.getElementById('log-server-name');
    const serverFormContainer = document.getElementById('server-form-container');
    const serverForm = document.getElementById('server-form');
    const formTitle = document.getElementById('form-title');
    const serverIdInput = document.getElementById('server-id'); // Input oculto para ID
    const addServerBtn = document.getElementById('add-server-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    const clearLogsBtn = document.getElementById('clear-logs-btn');
    // Elementos Git Clone
    const gitUrlInput = document.getElementById('git-url');
    const cloneBtn = document.getElementById('clone-btn');
    const cloneStatus = document.getElementById('clone-status');

    // Estado
    let currentServers = []; // Cache local, atualizado via WebSocket
    let selectedServerId = null;
    let webSocket = null;
    const apiBaseUrl = ''; // Backend na mesma origem

    // --- WebSocket Connection ---
    function connectWebSocket() {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}`;
        console.log(`Attempting WebSocket connection to: ${wsUrl}`);
        webSocket = new WebSocket(wsUrl);

        webSocket.onopen = () => { console.log('WebSocket connected'); setCloneStatus('Conectado ao backend.', 'success', 3000); };
        webSocket.onmessage = (event) => { try { handleWebSocketMessage(JSON.parse(event.data)); } catch (e) { console.error("Error processing WebSocket message:", event.data, e); }};
        webSocket.onerror = (error) => { console.error('WebSocket Error:', error); setCloneStatus('Erro no WebSocket. Backend está rodando?', 'error'); };
        webSocket.onclose = (event) => {
            console.log(`WebSocket disconnected. Code: ${event.code}. Reconnecting...`);
            setCloneStatus('WebSocket desconectado. Tentando reconectar...', 'info');
            setTimeout(connectWebSocket, 5000);
        };
    }

    function handleWebSocketMessage(data) {
        // console.log('WS Message:', data); // Debug
        switch (data.type) {
            case 'initial_state':
            case 'config_update': // Recebe a lista COMPLETA e atualizada do backend
                currentServers = data.servers || [];
                renderServerList(); // Redesenha a lista com os dados recebidos
                 // Se o servidor que estava selecionado (para logs/edição) foi removido, limpa a seleção
                 if (selectedServerId && !currentServers.some(s => s.id === selectedServerId)) {
                     selectServer(null);
                 } else if (selectedServerId && serverFormContainer.style.display !== 'none') {
                     // Se estava editando e houve update, recarrega dados no form (opcional)
                     const updatedServer = currentServers.find(s => s.id === selectedServerId);
                     if (updatedServer) showForm(updatedServer);
                 }
                break;
            case 'status':
                updateServerStatusUI(data.serverId, data.status); // Atualiza indicador e botões
                 // Atualiza o estado local (cache) para consistência imediata
                 const serverIdx = currentServers.findIndex(s => s.id === data.serverId);
                 if (serverIdx > -1) currentServers[serverIdx].status = data.status;
                 // Log de status
                 if (selectedServerId === data.serverId) {
                     const logMsg = `[STATUS] ${data.status}${data.message ? ': ' + data.message : ''}${data.code !== undefined ? ' (code: ' + data.code + ')' : ''}${data.pid ? ' [PID: ' + data.pid + ']' : ''}`;
                     appendLog(logMsg, 'status');
                 }
                break;
            case 'log':
                if (selectedServerId === data.serverId) { appendLog(data.message, data.stream); }
                break;
             default: console.warn("Mensagem WebSocket não reconhecida:", data);
        }
    }

    // --- API Interaction ---
    async function apiRequest(url, options = {}) {
        try {
            const response = await fetch(`${apiBaseUrl}${url}`, options);
            if (!response.ok) {
                 let errorMsg = `Erro ${response.status}`;
                 try { const errBody = await response.json(); errorMsg = errBody.message || errorMsg; }
                 catch(e) { /* Ignore se corpo não for JSON */ }
                 throw new Error(errorMsg);
            }
             return (response.status === 204) ? null : await response.json();
        } catch (error) { console.error(`API Request failed: ${options.method || 'GET'} ${url}`, error); throw error; }
    }

    async function fetchServers() { try { currentServers = await apiRequest('/api/servers'); renderServerList(); } catch (error) { serverList.innerHTML = '<li>Erro ao carregar servidores.</li>'; } }
    async function sendServerAction(id, action) { try { updateServerStatusUI(id, action === 'start' ? 'starting' : 'stopping'); await apiRequest(`/api/servers/${id}/${action}`, { method: 'POST' }); appendLog(`[CMD] Comando '${action}' enviado.`, 'status'); } catch (error) { appendLog(`[ERRO] Falha ao ${action} servidor: ${error.message}`, 'stderr'); fetchServers(); } }
    async function cloneGitRepo(repoUrl) { setCloneStatus('Clonando...', 'info'); cloneBtn.disabled = true; try { const result = await apiRequest('/api/git/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoUrl }) }); setCloneStatus(`${result.message} Clonado em: ${result.path}. Adicione-o à lista!`, 'success', 10000); gitUrlInput.value = ''; } catch (error) { setCloneStatus(`Erro ao clonar: ${error.message}`, 'error'); } finally { cloneBtn.disabled = false; } }

     // Salvar (Add ou Update)
     async function saveServer(serverData) {
         const isUpdating = !!serverData.id;
         const url = isUpdating ? `/api/servers/${serverData.id}` : '/api/servers';
         const method = isUpdating ? 'PUT' : 'POST';
         const actionText = isUpdating ? 'atualizar' : 'adicionar';

         try {
              await apiRequest(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(serverData) });
              console.log(`Servidor ${actionText}do com sucesso.`);
              setCloneStatus(`Servidor ${actionText}do com sucesso!`, 'success', 3000); // Usa a área de status do clone para feedback geral
              hideForm();
              // A UI será atualizada via WebSocket ('config_update')
         } catch (error) {
              alert(`Erro ao ${actionText} servidor: ${error.message}`); // Usa alert para erros de save
         }
     }

     // Deletar
     async function deleteServer(id, name) {
         if (!confirm(`Tem certeza que deseja remover o servidor "${name || id}" da configuração? A pasta clonada (se houver) NÃO será afetada.`)) return;

         try {
             await apiRequest(`/api/servers/${id}`, { method: 'DELETE' });
             console.log(`Servidor ${id} removido com sucesso.`);
             setCloneStatus(`Servidor "${name || id}" removido.`, 'success', 3000);
              if (selectedServerId === id) { selectServer(null); } // Desseleciona se era o ativo
              // A UI será atualizada via WebSocket ('config_update')
         } catch (error) {
             alert(`Erro ao remover servidor: ${error.message}`);
         }
     }

    // --- UI Rendering and Logic ---
    function renderServerList() {
        serverList.innerHTML = ''; // Limpa antes de redesenhar
        if (!currentServers || currentServers.length === 0) {
             serverList.innerHTML = '<li>Nenhum servidor configurado.</li>';
             return;
        }

        // Ordena alfabeticamente pelo nome para consistência
        const sortedServers = [...currentServers].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

        sortedServers.forEach(server => {
            const li = document.createElement('li');
            li.dataset.serverId = server.id;
            li.classList.toggle('selected', server.id === selectedServerId);
            const status = server.status || 'stopped';
            const isRunningOrTransient = status === 'running' || status === 'starting' || status === 'stopping';

            li.innerHTML = `
                <div class="server-info">
                     <div class="server-info-main">
                         <span class="status-indicator status-${status}"></span>
                         <span>${server.name || server.id}</span>
                     </div>
                     ${server.description ? `<span class="server-description">${server.description}</span>` : ''}
                </div>
                <div class="server-actions">
                    <button class="start-btn" title="Ligar Servidor" ${isRunningOrTransient ? 'disabled' : ''}>▶</button>
                    <button class="stop-btn" title="Desligar Servidor" ${status !== 'running' ? 'disabled' : ''}>■</button>
                    <button class="edit-btn" title="Editar Configuração" ${isRunningOrTransient ? 'disabled' : ''}>✎</button>
                    <button class="delete-btn" title="Remover da Lista" ${isRunningOrTransient ? 'disabled' : ''}>🗑</button>
                </div>
            `;

            // Event Listeners para os botões de ação
            li.querySelector('.start-btn').addEventListener('click', (e) => { e.stopPropagation(); sendServerAction(server.id, 'start'); });
            li.querySelector('.stop-btn').addEventListener('click', (e) => { e.stopPropagation(); sendServerAction(server.id, 'stop'); });
            li.querySelector('.edit-btn').addEventListener('click', (e) => { e.stopPropagation(); selectServer(null); showForm(server); }); // Desseleciona logs e mostra form
            li.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteServer(server.id, server.name); });
            li.addEventListener('click', () => selectServer(server.id)); // Seleciona para ver logs

            serverList.appendChild(li);
        });
    }

     function selectServer(id) {
         if (id === null) { // Desselecionar
             if (selectedServerId) {
                 const oldLi = serverList.querySelector(`li[data-server-id="${selectedServerId}"]`);
                 if (oldLi) oldLi.classList.remove('selected');
             }
             selectedServerId = null;
             hideLogs();
             // Não esconde o form aqui, deixa o showForm/hideForm controlar
             return;
         }

         if (selectedServerId === id) return; // Já selecionado

         // Desseleciona anterior
         if (selectedServerId) {
             const oldLi = serverList.querySelector(`li[data-server-id="${selectedServerId}"]`);
             if (oldLi) oldLi.classList.remove('selected');
         }

         // Seleciona novo
         selectedServerId = id;
         const newLi = serverList.querySelector(`li[data-server-id="${id}"]`);
         if (newLi) newLi.classList.add('selected');

         const server = currentServers.find(s => s.id === id);
         if (server) {
             showLogs(server.name || id);
             hideForm(); // Esconde o form se estava aberto
         } else {
             hideLogs(); // Servidor não encontrado (não deveria acontecer)
         }
     }

    // Atualiza apenas UI (indicador, botões)
    function updateServerStatusUI(id, status) {
        const li = serverList.querySelector(`li[data-server-id="${id}"]`);
        if (!li) return;
        const indicator = li.querySelector('.status-indicator');
        const startBtn = li.querySelector('.start-btn');
        const stopBtn = li.querySelector('.stop-btn');
        const editBtn = li.querySelector('.edit-btn');
        const deleteBtn = li.querySelector('.delete-btn');
        if (!indicator || !startBtn || !stopBtn || !editBtn || !deleteBtn) return; // Segurança

        indicator.className = `status-indicator status-${status}`;
        const isRunningOrTransient = status === 'running' || status === 'starting' || status === 'stopping';
        startBtn.disabled = isRunningOrTransient;
        stopBtn.disabled = status !== 'running'; // Só pode parar se estiver rodando
        editBtn.disabled = isRunningOrTransient;
        deleteBtn.disabled = isRunningOrTransient;
    }

    function appendLog(message, type = 'stdout') {
         if (!logContainer.style.display || logContainer.style.display === 'none') return;
        const logEntry = document.createElement('div');
        logEntry.classList.add(`log-${type}`);
        logEntry.textContent = message;
        logsOutput.appendChild(logEntry);
        const shouldScroll = logsOutput.scrollTop + logsOutput.clientHeight >= logsOutput.scrollHeight - 50;
        if (shouldScroll) logsOutput.scrollTop = logsOutput.scrollHeight;
    }

     function showLogs(serverName) { logServerName.textContent = serverName; logsOutput.innerHTML = ''; appendLog(`--- Logs para ${serverName} ---`, 'status'); logContainer.style.display = 'block'; }
     function hideLogs() { logContainer.style.display = 'none'; }

     // Mostra o formulário (para Adicionar ou Editar)
     function showForm(server = null) {
         const isEditing = !!server;
         formTitle.textContent = isEditing ? `Editar: ${server.name || server.id}` : 'Adicionar Novo Servidor';
         serverIdInput.value = isEditing ? server.id : ''; // Define ou limpa o ID oculto
         document.getElementById('server-name').value = isEditing ? (server.name || '') : '';
         document.getElementById('server-description').value = isEditing ? (server.description || '') : '';
         document.getElementById('server-command').value = isEditing ? (server.command || '') : '';
         // Converte array de args para string separada por vírgula para o input
         document.getElementById('server-args').value = isEditing ? (server.args || []).join(', ') : '';
         // Converte objeto env para string JSON formatada para o textarea
         document.getElementById('server-env').value = isEditing ? JSON.stringify(server.env || {}, null, 2) : '{}';

         selectServer(null); // Garante que nenhum servidor esteja selecionado na lista
         hideLogs(); // Esconde os logs
         serverFormContainer.style.display = 'block'; // Mostra o form
         document.getElementById('server-name').focus(); // Foca no primeiro campo
     }

     function hideForm() { serverFormContainer.style.display = 'none'; serverForm.reset(); serverIdInput.value = ''; }

     // Helper para status do clone (ou geral)
     let statusTimeout;
     function setCloneStatus(message, type = 'info', timeout = 0) {
         clearTimeout(statusTimeout);
         cloneStatus.textContent = message;
         cloneStatus.className = `status-message ${type}`;
         if (timeout > 0) { statusTimeout = setTimeout(() => { cloneStatus.textContent = ''; cloneStatus.className = 'status-message'; }, timeout); }
     }

    // --- Event Listeners ---
    addServerBtn.addEventListener('click', () => showForm()); // Mostra form vazio
    cancelEditBtn.addEventListener('click', () => hideForm());
    clearLogsBtn.addEventListener('click', () => { if (selectedServerId) { logsOutput.innerHTML = ''; appendLog(`--- Logs limpos para ${logServerName.textContent} ---`, 'status'); }});

    // Submit do formulário (Adicionar ou Editar)
    serverForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = serverIdInput.value || undefined; // Pega ID do campo oculto (se houver)
        const envValue = document.getElementById('server-env').value;
        let envJson = {};

        // Valida JSON das variáveis de ambiente
        try {
            if (envValue.trim()) {
                envJson = JSON.parse(envValue);
                if (typeof envJson !== 'object' || envJson === null || Array.isArray(envJson)) throw new Error("Deve ser um objeto JSON.");
            }
        } catch (err) { alert('Variáveis de Ambiente (JSON) inválido: ' + err.message); return; }

        // Processa args (string separada por vírgula para array)
        const argsArray = document.getElementById('server-args').value.split(',').map(arg => arg.trim()).filter(Boolean);

        const serverData = {
            id: id, // Será undefined se for novo, ou terá valor se for edição
            name: document.getElementById('server-name').value.trim(),
            description: document.getElementById('server-description').value.trim(),
            command: document.getElementById('server-command').value.trim(),
            args: argsArray,
            env: envJson
        };

        if (!serverData.name || !serverData.command) { alert("Nome e Comando são obrigatórios."); return; }

        saveServer(serverData); // Chama a função API para salvar (ela decide se é POST ou PUT)
    });

    // Listener para botão Clonar
    cloneBtn.addEventListener('click', () => {
        const repoUrl = gitUrlInput.value.trim();
        if (!repoUrl) { setCloneStatus('Por favor, preencha a URL do Git.', 'error', 5000); return; }
        if (!repoUrl.includes('://') && !repoUrl.endsWith('.git') && !repoUrl.includes('@')) {
             if (!confirm("A URL não parece ser HTTPS ou terminar com .git ou ser SSH. Continuar?")) return;
        }
        cloneGitRepo(repoUrl);
    });

    // --- Initial Load ---
    fetchServers();
    connectWebSocket();
}); // Fim do DOMContentLoaded