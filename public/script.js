document.addEventListener('DOMContentLoaded', () => {
    // --- Elementos da UI ---
    const serverList = document.getElementById('server-list');
    const logsOutput = document.getElementById('logs');
    const logContainer = document.getElementById('log-container');
    const logServerName = document.getElementById('log-server-name');
    const serverFormContainer = document.getElementById('server-form-container');
    const serverForm = document.getElementById('server-form');
    const formTitle = document.getElementById('form-title');
    const serverIdInput = document.getElementById('server-id');
    const addServerBtn = document.getElementById('add-server-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    const clearLogsBtn = document.getElementById('clear-logs-btn');
    // Git Clone
    const gitUrlInput = document.getElementById('git-url');
    const cloneBtn = document.getElementById('clone-btn');
    const cloneStatus = document.getElementById('clone-status');
    // Add JSON
    const jsonConfigTextarea = document.getElementById('server-json-config');
    const addFromJsonBtn = document.getElementById('add-from-json-btn');
    const addJsonStatus = document.getElementById('add-json-status');

    // --- Estado ---
    let currentServers = [];
    let selectedServerId = null;
    let webSocket = null;
    let statusTimeout; // Para mensagens de status temporárias
    const apiBaseUrl = '';

    // --- WebSocket ---
    function connectWebSocket() {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}`;
        console.log(`Connecting WebSocket: ${wsUrl}`);
        webSocket = new WebSocket(wsUrl);
        webSocket.onopen = () => { console.log('WS connected'); setStatusMessage(cloneStatus, 'Backend conectado.', 'success', 3000); };
        webSocket.onmessage = (event) => { try { handleWebSocketMessage(JSON.parse(event.data)); } catch (e) { console.error("WS msg parse error:", e); }};
        webSocket.onerror = (error) => { console.error('WS Error:', error); setStatusMessage(cloneStatus, 'Erro WS. Backend rodando?', 'error'); };
        webSocket.onclose = (e) => { console.log(`WS disconnected (Code: ${e.code}). Reconnecting...`); setStatusMessage(cloneStatus, 'WS desconectado. Reconectando...', 'info'); setTimeout(connectWebSocket, 5000); };
    }

    function handleWebSocketMessage(data) {
        switch (data.type) {
            case 'initial_state':
            case 'config_update':
                currentServers = data.servers || [];
                renderServerList();
                 // Desseleciona se o servidor selecionado sumiu
                 if (selectedServerId && !currentServers.some(s => s.id === selectedServerId)) {
                     selectServer(null);
                 } else if (selectedServerId && serverFormContainer.style.display !== 'none') {
                     // Atualiza form se estava editando e config mudou externamente
                     const updated = currentServers.find(s => s.id === selectedServerId);
                     if (updated) showForm(updated); else hideForm(); // Fecha se sumiu
                 }
                break;
            case 'status':
                updateServerStatusUI(data.serverId, data.status);
                 const serverIdx = currentServers.findIndex(s => s.id === data.serverId);
                 if (serverIdx > -1) currentServers[serverIdx].status = data.status; // Atualiza cache local
                 if (selectedServerId === data.serverId) { appendLog(`[STATUS] ${data.status}${data.pid ? ' (PID:'+data.pid+')' : ''}${data.code !== undefined ? ' Code:'+data.code : ''}${data.message ? ' Msg:'+data.message : ''}`, 'status'); }
                break;
            case 'log':
                if (selectedServerId === data.serverId) { appendLog(data.message, data.stream); }
                break;
             default: console.warn("WS msg type?", data);
        }
    }

    // --- API ---
    async function apiRequest(url, options = {}) {
        try {
            const response = await fetch(`${apiBaseUrl}${url}`, options);
            if (!response.ok) { let msg = `Erro ${response.status}`; try { const err = await response.json(); msg = err.message || msg; } catch(e){} throw new Error(msg); }
             return (response.status === 204) ? null : await response.json();
        } catch (error) { console.error(`API Req failed: ${options.method || 'GET'} ${url}`, error); throw error; }
    }
    async function fetchServers() { try { currentServers = await apiRequest('/api/servers'); renderServerList(); } catch (error) { serverList.innerHTML = '<li>Erro ao carregar.</li>'; } }
    async function sendServerAction(id, action) { try { updateServerStatusUI(id, action === 'start' ? 'starting' : 'stopping'); await apiRequest(`/api/servers/${id}/${action}`, { method: 'POST' }); appendLog(`[CMD] ${action} enviado.`, 'status'); } catch (error) { appendLog(`[ERRO] ${action}: ${error.message}`, 'stderr'); fetchServers(); } }
    async function cloneGitRepo(repoUrl) { setStatusMessage(cloneStatus, 'Clonando...', 'info'); cloneBtn.disabled = true; try { const result = await apiRequest('/api/git/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoUrl }) }); setStatusMessage(cloneStatus, `${result.message} Path: ${result.path}. Edite o placeholder abaixo!`, 'success', 15000); gitUrlInput.value = ''; } catch (error) { setStatusMessage(cloneStatus, `Erro clone: ${error.message}`, 'error'); } finally { cloneBtn.disabled = false; } }
    async function saveServer(serverData) { const isUpdate = !!serverData.id; try { await apiRequest(isUpdate ? `/api/servers/${serverData.id}` : '/api/servers', { method: isUpdate ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(serverData) }); setStatusMessage(cloneStatus, `Servidor ${isUpdate ? 'atualizado' : 'adicionado'}!`, 'success', 3000); hideForm(); /* Atualização via WS */ } catch (error) { alert(`Erro ao salvar: ${error.message}`); } }
    async function deleteServer(id, name) { if (!confirm(`Remover "${name || id}"? Pasta NÃO será deletada.`)) return; try { await apiRequest(`/api/servers/${id}`, { method: 'DELETE' }); setStatusMessage(cloneStatus, `Servidor "${name || id}" removido.`, 'success', 3000); if (selectedServerId === id) selectServer(null); /* Atualização via WS */ } catch (error) { alert(`Erro ao remover: ${error.message}`); } }

     // --- Lógica para Adicionar via JSON ---
     async function addServerFromJson(jsonString) {
         setStatusMessage(addJsonStatus, 'Processando JSON...', 'info');
         addFromJsonBtn.disabled = true;
         try {
             const parsedConfig = JSON.parse(jsonString);

             // Validação básica do objeto parseado
             if (typeof parsedConfig !== 'object' || parsedConfig === null || Array.isArray(parsedConfig)) {
                 throw new Error("O JSON fornecido não é um objeto válido.");
             }
             if (!parsedConfig.name || !parsedConfig.command) {
                 throw new Error("JSON deve conter pelo menos 'name' e 'command'.");
             }

             // Remove ID se existir para garantir que backend gere um novo
             delete parsedConfig.id;

             // Chama a API de adicionar servidor
             await apiRequest('/api/servers', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(parsedConfig) // Envia o objeto parseado
             });

             setStatusMessage(addJsonStatus, `Servidor "${parsedConfig.name}" adicionado via JSON!`, 'success', 5000);
             jsonConfigTextarea.value = ''; // Limpa textarea

         } catch (error) {
             console.error("Erro ao adicionar via JSON:", error);
             setStatusMessage(addJsonStatus, `Erro: ${error.message}`, 'error');
         } finally {
             addFromJsonBtn.disabled = false;
         }
     }

    // --- UI Rendering ---
    function renderServerList() {
        serverList.innerHTML = '';
        if (!currentServers || currentServers.length === 0) { serverList.innerHTML = '<li>Nenhum servidor configurado.</li>'; return; }
        const sorted = [...currentServers].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        sorted.forEach(server => {
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
                    <button class="start-btn" title="Ligar" ${isRunningOrTransient ? 'disabled' : ''}>▶</button>
                    <button class="stop-btn" title="Desligar" ${status !== 'running' ? 'disabled' : ''}>■</button>
                    <button class="edit-btn" title="Editar" ${isRunningOrTransient ? 'disabled' : ''}>✎</button>
                    <button class="delete-btn" title="Remover" ${isRunningOrTransient ? 'disabled' : ''}>🗑</button>
                </div>`;
            // Listeners
            li.querySelector('.start-btn').onclick = (e) => { e.stopPropagation(); sendServerAction(server.id, 'start'); };
            li.querySelector('.stop-btn').onclick = (e) => { e.stopPropagation(); sendServerAction(server.id, 'stop'); };
            li.querySelector('.edit-btn').onclick = (e) => { e.stopPropagation(); selectServer(null); showForm(server); };
            li.querySelector('.delete-btn').onclick = (e) => { e.stopPropagation(); deleteServer(server.id, server.name); };
            li.onclick = () => selectServer(server.id);
            serverList.appendChild(li);
        });
    }

     function selectServer(id) {
         if (selectedServerId === id && id !== null) return; // Não faz nada se clicar no já selecionado
         // Desseleciona antigo
         if (selectedServerId) { const oldLi = serverList.querySelector(`li[data-server-id="${selectedServerId}"]`); if (oldLi) oldLi.classList.remove('selected'); }
         selectedServerId = id;
         if (id !== null) { // Seleciona novo
             const newLi = serverList.querySelector(`li[data-server-id="${id}"]`); if (newLi) newLi.classList.add('selected');
             const server = currentServers.find(s => s.id === id);
             if (server) { showLogs(server.name || id); hideForm(); } else { hideLogs(); }
         } else { // Desseleciona tudo
             hideLogs(); hideForm();
         }
     }

    function updateServerStatusUI(id, status) { /* ... (mesma lógica de antes para atualizar botões/indicador) ... */
        const li = serverList.querySelector(`li[data-server-id="${id}"]`); if (!li) return;
        const indicator = li.querySelector('.status-indicator'); if (indicator) indicator.className = `status-indicator status-${status}`;
        const isRunningOrTransient = status === 'running' || status === 'starting' || status === 'stopping';
        const isRunning = status === 'running';
        li.querySelector('.start-btn').disabled = isRunningOrTransient;
        li.querySelector('.stop-btn').disabled = !isRunning; // Só habilita stop se running
        li.querySelector('.edit-btn').disabled = isRunningOrTransient;
        li.querySelector('.delete-btn').disabled = isRunningOrTransient;
    }

    function appendLog(message, type = 'stdout') { /* ... (mesma lógica de antes) ... */
        if (!logContainer.style.display || logContainer.style.display === 'none') return;
        const entry = document.createElement('div'); entry.className = `log-${type}`; entry.textContent = message;
        logsOutput.appendChild(entry);
        if (logsOutput.scrollTop + logsOutput.clientHeight >= logsOutput.scrollHeight - 50) logsOutput.scrollTop = logsOutput.scrollHeight;
    }
    function showLogs(name) { logServerName.textContent = name; logsOutput.innerHTML = ''; appendLog(`--- Logs: ${name} ---`, 'status'); logContainer.style.display = 'block'; }
    function hideLogs() { logContainer.style.display = 'none'; }

    // Mostra/Esconde Formulário
     function showForm(server = null) {
         const isEditing = !!server;
         formTitle.textContent = isEditing ? `Editar: ${server.name || server.id}` : 'Adicionar Servidor Manualmente';
         serverIdInput.value = isEditing ? server.id : '';
         // Preenche o formulário (importante para edição funcionar)
         document.getElementById('server-name').value = isEditing ? (server.name || '') : '';
         document.getElementById('server-description').value = isEditing ? (server.description || '') : '';
         document.getElementById('server-command').value = isEditing ? (server.command || '') : '';
         document.getElementById('server-args').value = isEditing ? (server.args || []).join(', ') : '';
         document.getElementById('server-env').value = isEditing ? JSON.stringify(server.env || {}, null, 2) : '{}';

         selectServer(null); hideLogs(); serverFormContainer.style.display = 'block';
         document.getElementById('server-name').focus();
     }
     function hideForm() { serverFormContainer.style.display = 'none'; serverForm.reset(); serverIdInput.value = ''; }

     // Helper de Status Message
     function setStatusMessage(element, message, type = 'info', timeout = 0) {
         clearTimeout(statusTimeout); element.textContent = message; element.className = `status-message ${type}`;
         if (timeout > 0) statusTimeout = setTimeout(() => { element.textContent = ''; element.className = 'status-message'; }, timeout);
     }

    // --- Event Listeners ---
    addServerBtn.addEventListener('click', () => showForm()); // Mostra form vazio
    cancelEditBtn.addEventListener('click', () => hideForm());
    clearLogsBtn.addEventListener('click', () => { if (selectedServerId) { logsOutput.innerHTML = ''; appendLog(`--- Logs limpos: ${logServerName.textContent} ---`, 'status'); }});

    // Submit do Formulário (Adicionar Manual ou Editar)
    serverForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = serverIdInput.value || undefined;
        const envValue = document.getElementById('server-env').value; let envJson = {};
        try { if (envValue.trim()) { envJson = JSON.parse(envValue); if (typeof envJson !== 'object' || envJson === null || Array.isArray(envJson)) throw new Error("Deve ser objeto."); }}
        catch (err) { alert('JSON Env inválido: ' + err.message); return; }
        const argsArray = document.getElementById('server-args').value.split(',').map(a => a.trim()).filter(Boolean);
        const data = { id, name: document.getElementById('server-name').value.trim(), description: document.getElementById('server-description').value.trim(), command: document.getElementById('server-command').value.trim(), args: argsArray, env: envJson };
        if (!data.name || !data.command) { alert("Nome e Comando são obrigatórios."); return; }
        saveServer(data);
    });

    // Botão Clonar Git
    cloneBtn.addEventListener('click', () => { /* ... (lógica de clonar existente) ... */
        const repoUrl = gitUrlInput.value.trim(); if (!repoUrl) { setStatusMessage(cloneStatus, 'URL Git obrigatória.', 'error', 5000); return; }
        if (!repoUrl.includes('://') && !repoUrl.endsWith('.git') && !repoUrl.includes('@')) { if (!confirm("URL suspeita. Continuar?")) return; }
        cloneGitRepo(repoUrl);
    });

    // Botão Adicionar por JSON
    addFromJsonBtn.addEventListener('click', () => {
        const jsonString = jsonConfigTextarea.value.trim();
        if (!jsonString) { setStatusMessage(addJsonStatus, 'Cole a configuração JSON na área acima.', 'error', 5000); return; }
        addServerFromJson(jsonString);
    });

    // --- Initial Load ---
    fetchServers();
    connectWebSocket();
}); // Fim