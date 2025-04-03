document.addEventListener('DOMContentLoaded', () => {
    const serverList = document.getElementById('server-list');
    const logsOutput = document.getElementById('logs');
    const logContainer = document.getElementById('log-container');
    const logServerName = document.getElementById('log-server-name');
    const serverFormContainer = document.getElementById('server-form-container');
    const serverForm = document.getElementById('server-form');
    const formTitle = document.getElementById('form-title');
    const addServerBtn = document.getElementById('add-server-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-btn');
    const clearLogsBtn = document.getElementById('clear-logs-btn');

    let currentServers = [];
    let selectedServerId = null;
    let webSocket = null;

    // --- WebSocket Connection ---
    function connectWebSocket() {
        // Assume backend runs on same host, different port (or same if proxied)
        const wsUrl = `ws://${window.location.hostname}:3000`; // Adjust if needed
        webSocket = new WebSocket(wsUrl);

        webSocket.onopen = () => {
            console.log('WebSocket connected');
        };

        webSocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // console.log('WS Message:', data); // Debugging

                switch (data.type) {
                    case 'initial_state':
                    case 'config_update':
                        currentServers = data.servers || [];
                        renderServerList();
                        break;
                    case 'status':
                        updateServerStatus(data.serverId, data.status, data.message, data.pid, data.code);
                        // Log status changes
                         if (selectedServerId === data.serverId) {
                             appendLog(`[STATUS] ${data.status}${data.message ? ': ' + data.message : ''}${data.code !== undefined ? ' (code: ' + data.code + ')' : ''}${data.pid ? ' [PID: ' + data.pid + ']' : ''}`, 'status');
                         }
                        break;
                    case 'log':
                        if (selectedServerId === data.serverId) {
                            appendLog(data.message, data.stream); // stream is 'stdout' or 'stderr'
                        }
                        break;
                }
            } catch (e) {
                console.error("Error processing WebSocket message:", e);
            }
        };

        webSocket.onerror = (error) => {
            console.error('WebSocket Error:', error);
             appendLog(`[WebSocket Error] Verifique se o backend está rodando em ${wsUrl}.`, 'stderr');
        };

        webSocket.onclose = () => {
            console.log('WebSocket disconnected. Attempting to reconnect...');
             appendLog('[WebSocket Disconnected] Tentando reconectar...', 'status');
            // Simple reconnect logic
            setTimeout(connectWebSocket, 5000);
        };
    }

    // --- API Interaction ---
    async function fetchServers() {
        try {
            const response = await fetch('/api/servers');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            currentServers = await response.json();
            renderServerList();
        } catch (error) {
            console.error("Failed to fetch servers:", error);
            serverList.innerHTML = '<li>Erro ao carregar servidores. Verifique o backend.</li>';
        }
    }

    async function sendServerAction(id, action) { // action = 'start' or 'stop'
        try {
             appendLog(`[ACTION] Enviando comando '${action}' para ${id}...`, 'status');
            const response = await fetch(`/api/servers/${id}/${action}`, { method: 'POST' });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.message || `HTTP error! status: ${response.status}`);
            }
            console.log(`Server ${id} ${action} command sent.`);
             appendLog(`[ACTION] Comando '${action}' enviado com sucesso. Aguardando status...`, 'status');
            // Status update will come via WebSocket
        } catch (error) {
            console.error(`Failed to ${action} server ${id}:`, error);
             appendLog(`[ERROR] Falha ao ${action} servidor ${id}: ${error.message}`, 'stderr');
            // Fetch servers again to get potentially updated state if WS fails
            fetchServers();
        }
    }

     async function saveServer(serverData) {
        const isUpdating = !!serverData.id;
        const url = isUpdating ? `/api/servers/${serverData.id}` : '/api/servers';
        const method = isUpdating ? 'PUT' : 'POST';

        try {
            const response = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(serverData)
            });
            const result = await response.json();
             if (!response.ok) {
                 throw new Error(result.message || `HTTP error! status: ${response.status}`);
             }
            console.log(`Server ${isUpdating ? 'updated' : 'added'}:`, result);
            hideForm();
            // Server list update will come via WebSocket ('config_update')
        } catch (error) {
             console.error(`Failed to ${isUpdating ? 'update' : 'add'} server:`, error);
             alert(`Erro ao salvar servidor: ${error.message}`);
        }
    }

    async function deleteServer(id) {
        if (!confirm('Tem certeza que deseja deletar este servidor?')) return;

        try {
            const response = await fetch(`/api/servers/${id}`, { method: 'DELETE' });
             if (!response.ok) {
                 // Try parsing error message if available
                 let errorMsg = `HTTP error! status: ${response.status}`;
                 try {
                     const result = await response.json();
                     errorMsg = result.message || errorMsg;
                 } catch (e) { /* Ignore if no JSON body */ }
                 throw new Error(errorMsg);
             }
            console.log(`Server ${id} deleted.`);
             if (selectedServerId === id) {
                 hideLogs(); // Hide logs if the deleted server was selected
                 selectedServerId = null;
             }
            // Server list update will come via WebSocket ('config_update')
        } catch (error) {
            console.error(`Failed to delete server ${id}:`, error);
             alert(`Erro ao deletar servidor: ${error.message}`);
        }
    }


    // --- UI Rendering and Logic ---
    function renderServerList() {
        serverList.innerHTML = ''; // Clear existing list
        if (currentServers.length === 0) {
             serverList.innerHTML = '<li>Nenhum servidor configurado.</li>';
             return;
        }

        currentServers.forEach(server => {
            const li = document.createElement('li');
            li.dataset.serverId = server.id;
            if (server.id === selectedServerId) {
                 li.classList.add('selected');
             }

            li.innerHTML = `
                <div class="server-info" title="ID: ${server.id}\nComando: ${server.command} ${server.args ? server.args.join(' ') : ''}">
                    <span class="status-indicator status-${server.status || 'stopped'}"></span>
                    <span>${server.name || server.id}</span>
                     ${server.description ? `<small style="color: grey; margin-left: 5px;"> - ${server.description}</small>` : ''}
                </div>
                <div class="server-actions">
                    <button class="start-btn" ${server.status === 'running' || server.status === 'starting' ? 'disabled' : ''}>Ligar</button>
                    <button class="stop-btn" ${!(server.status === 'running' || server.status === 'stopping') ? 'disabled' : ''}>Desligar</button>
                    <button class="edit-btn" ${server.status === 'running' ? 'disabled' : ''}>Editar</button>
                    <button class="delete-btn" ${server.status === 'running' ? 'disabled' : ''}>X</button>
                </div>
            `;

            // Event Listeners for buttons
            li.querySelector('.start-btn').addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent li click event
                sendServerAction(server.id, 'start');
            });
            li.querySelector('.stop-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                sendServerAction(server.id, 'stop');
            });
             li.querySelector('.edit-btn').addEventListener('click', (e) => {
                 e.stopPropagation();
                 showForm(server);
             });
             li.querySelector('.delete-btn').addEventListener('click', (e) => {
                 e.stopPropagation();
                 deleteServer(server.id);
             });


            // Click on list item to select and show logs
             li.addEventListener('click', () => {
                 selectServer(server.id);
             });


            serverList.appendChild(li);
        });
    }

     function selectServer(id) {
         if (selectedServerId === id) return; // Already selected

         selectedServerId = id;
         const server = currentServers.find(s => s.id === id);

         // Update selection highlight
         document.querySelectorAll('#server-list li').forEach(item => {
             item.classList.toggle('selected', item.dataset.serverId === id);
         });


         if (server) {
             showLogs(server.name || id);
             hideForm(); // Hide form when selecting server
         } else {
             hideLogs();
         }
     }

    function updateServerStatus(id, status, message, pid, code) {
        const li = serverList.querySelector(`li[data-server-id="${id}"]`);
        if (!li) return;

        const indicator = li.querySelector('.status-indicator');
        const startBtn = li.querySelector('.start-btn');
        const stopBtn = li.querySelector('.stop-btn');
        const editBtn = li.querySelector('.edit-btn');
        const deleteBtn = li.querySelector('.delete-btn');


        // Update indicator class
        indicator.className = `status-indicator status-${status}`;

        // Update button states
        const isRunning = status === 'running';
         const isStarting = status === 'starting';
         const isStopping = status === 'stopping';
         const canInteract = !isStarting && !isStopping;


        startBtn.disabled = isRunning || isStarting || isStopping;
        stopBtn.disabled = !isRunning || isStarting || isStopping;
         editBtn.disabled = isRunning || isStarting || isStopping; // Can't edit while running/transient
         deleteBtn.disabled = isRunning || isStarting || isStopping; // Can't delete while running/transient

        // Find server in local cache and update status
         const serverIndex = currentServers.findIndex(s => s.id === id);
         if (serverIndex > -1) {
             currentServers[serverIndex].status = status;
         }
    }

    function appendLog(message, type = 'stdout') { // type can be 'stdout', 'stderr', 'status'
         if (!logContainer.style.display || logContainer.style.display === 'none') {
             return; // Don't append if logs aren't visible for the selected server
         }
        const logEntry = document.createElement('span');
         logEntry.classList.add(`log-${type}`);
         logEntry.textContent = message.endsWith('\n') ? message : message + '\n'; // Ensure newline
        logsOutput.appendChild(logEntry);
        // Auto-scroll to bottom
        logsOutput.scrollTop = logsOutput.scrollHeight;
    }

     function showLogs(serverName) {
         logServerName.textContent = serverName;
         logsOutput.innerHTML = ''; // Clear previous logs
         logContainer.style.display = 'block';
     }

     function hideLogs() {
         logContainer.style.display = 'none';
     }

     function showForm(server = null) { // Pass server object to edit, null to add
         if (server) {
             formTitle.textContent = 'Editar Servidor';
             document.getElementById('server-id').value = server.id;
             document.getElementById('server-name').value = server.name || '';
             document.getElementById('server-description').value = server.description || '';
             document.getElementById('server-command').value = server.command || '';
             document.getElementById('server-args').value = (server.args || []).join(', '); // Join args with comma+space
             document.getElementById('server-env').value = server.env ? JSON.stringify(server.env, null, 2) : '';
         } else {
             formTitle.textContent = 'Adicionar Servidor';
             serverForm.reset(); // Clear form for adding
             document.getElementById('server-id').value = ''; // Ensure ID is empty for new server
         }
         hideLogs(); // Hide logs when showing form
         serverFormContainer.style.display = 'block';
     }

     function hideForm() {
         serverFormContainer.style.display = 'none';
         serverForm.reset();
     }

    // --- Event Listeners ---
    addServerBtn.addEventListener('click', () => showForm());
    cancelEditBtn.addEventListener('click', () => hideForm());
    clearLogsBtn.addEventListener('click', () => {
         logsOutput.innerHTML = '';
     });

    serverForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const envValue = document.getElementById('server-env').value;
        let envJson = {};
        try {
            if (envValue.trim()) {
                envJson = JSON.parse(envValue);
            }
        } catch (err) {
             alert('Variáveis de Ambiente (JSON) inválido: ' + err.message);
             return;
        }

        // Split args by comma, trim whitespace
         const argsArray = document.getElementById('server-args').value
             .split(',')
             .map(arg => arg.trim())
             .filter(arg => arg !== ''); // Remove empty strings


        const serverData = {
            id: document.getElementById('server-id').value || undefined, // Send undefined for new
            name: document.getElementById('server-name').value,
            description: document.getElementById('server-description').value,
            command: document.getElementById('server-command').value,
            args: argsArray,
            env: envJson
        };
        saveServer(serverData);
    });


    // --- Initial Load ---
    fetchServers();
    connectWebSocket();
});