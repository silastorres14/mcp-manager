# MCP Manager Local

Um gerenciador web local simples para iniciar, parar, configurar e visualizar logs de servidores MCP (Multi-Capability Protocol), com funcionalidades para clonar novos servidores de repositórios Git e adicionar configurações via JSON.

## Funcionalidades

*   **Interface Web:** Gerencie seus servidores MCP através de uma interface web acessível em `http://localhost:3000`.
*   **Gerenciamento de Servidores:**
    *   Adicione configurações de servidor manualmente.
    *   Adicione configurações colando um objeto JSON.
    *   Edite configurações existentes (nome, comando, argumentos, variáveis de ambiente).
    *   Remova configurações da lista.
*   **Controle de Processos:**
    *   Inicie ("Ligar") e Pare ("Desligar") processos de servidores MCP individualmente.
    *   Visualize o status (Rodando, Parado, Erro, etc.).
*   **Visualização de Logs:** Veja a saída padrão (stdout) e erro padrão (stderr) dos servidores em tempo real na interface.
*   **Clonagem Git:** Clone repositórios Git contendo servidores MCP diretamente pela interface. Um placeholder para o servidor clonado é adicionado automaticamente à lista para configuração posterior.
*   **Persistência:** As configurações dos servidores são salvas no arquivo `servers.json` local.

## Pré-requisitos

*   **Node.js:** Versão 18 ou superior recomendada. ([Download Node.js](https://nodejs.org/))
*   **Git:** Necessário para a funcionalidade de clonagem. ([Download Git](https://git-scm.com/downloads))

## Instalação e Execução (Desenvolvimento)

1.  **Clone o Repositório:**
    ```bash
    git clone https://github.com/<seu-usuario-github>/<nome-do-repositorio>.git
    # Substitua pela URL correta do SEU repositório
    ```

2.  **Navegue até a Pasta:**
    ```bash
    cd <nome-do-repositorio>
    ```

3.  **Instale as Dependências:**
    ```bash
    npm install
    ```

4.  **(Opcional) Configure Servidores Iniciais:**
    *   Você pode editar o arquivo `servers.json` manualmente para adicionar configurações iniciais.
    *   **IMPORTANTE:** NÃO comite arquivos `servers.json` contendo segredos (API keys, client secrets) em repositórios públicos. Use a interface web para adicionar configurações com segredos após clonar o repositório. O `servers.json` no repositório deve conter apenas exemplos ou estar vazio.

5.  **Inicie o Servidor do MCP Manager:**
    ```bash
    node server.js
    ```

6.  **Acesse a Interface:**
    *   Abra seu navegador web e vá para `http://localhost:3000`.

## Construindo o Executável (Opcional)

Você pode criar um executável independente usando `pkg`.

1.  **Execute o script de build (definido no `package.json`):**
    ```bash
    npm run build-pkg
    ```
    *(Isso executará o comando `pkg . --targets ... --output ...`)*

2.  **Encontre o Executável:** O executável (ex: `mcp-manager.exe` no Windows) estará na pasta `dist/`.

3.  **Execute:**
    *   **Crucial:** Copie o arquivo `servers.json` (com sua configuração inicial ou vazio) para **dentro** da pasta `dist/`, ao lado do executável.
    *   Dê dois cliques no executável (ou execute via terminal: `.\mcp-manager.exe` ou `./mcp-manager`).
    *   Acesse `http://localhost:3000` no navegador.
    *   A pasta `cloned_servers/` será criada dentro de `dist/` quando você clonar o primeiro repositório usando o executável.

## Como Usar

1.  **Acessar:** Abra `http://localhost:3000` no navegador.
2.  **Clonar Servidor:** Use a seção "Clonar Repositório MCP" para baixar um servidor de um repositório Git. Um placeholder será adicionado à lista.
3.  **Adicionar por JSON:** Use a seção "Adicionar Configuração por JSON" para colar e adicionar uma configuração completa.
4.  **Adicionar Manualmente:** Clique em "Adicionar Servidor Manualmente" e preencha os detalhes no formulário.
5.  **Gerenciar Servidores:**
    *   Clique em um servidor na lista para ver seus logs (se estiver rodando).
    *   Use os botões de ação (`▶`, `■`, `✎`, `🗑️`) para Ligar, Desligar, Editar ou Remover um servidor (ações de edição/remoção só habilitadas quando o servidor está parado).
    *   Ao **Editar**, preencha os campos `Comando`, `Argumentos` (separados por vírgula) e `Variáveis de Ambiente` (formato JSON) corretamente para que o servidor possa ser iniciado. Use caminhos **absolutos** nos argumentos se necessário.

## Estrutura do `servers.json`

O arquivo `servers.json` armazena um array de objetos, onde cada objeto representa um servidor MCP configurado:

```json
[
  {
    "id": "uuid-gerado-automaticamente",
    "name": "Nome Amigável do Servidor",
    "description": "Descrição opcional.",
    "command": "comando_para_executar", // ex: "node", "python", "/caminho/executavel"
    "args": ["argumento1", "/caminho/script.js", "--flag"], // Array de strings
    "env": { // Objeto chave-valor para variáveis de ambiente
      "VARIAVEL_1": "valor1",
      "API_KEY": "NAO_COMITAR_SEGREDOS_AQUI"
    }
  }
]