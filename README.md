# Ponto Simples

Controle de ponto leve e direto, em duas versões. **As duas só aceitam e-mails dos domínios cadastrados** (veja [E-mails aceitos](#e-mails-aceitos)).

| Versão | Arquivo | Para quem | Onde ficam os dados |
| --- | --- | --- | --- |
| **Sem servidor** | `index.html` | um computador usado como relógio de ponto | no navegador (`localStorage`) |
| **Com servidor (SaaS)** | `server.js` + `public/` | várias empresas e vários computadores | banco SQLite no servidor |

**Acesse online:** https://mbastida43.github.io/ponto-simples/ (versão sem servidor)

## Versão sem servidor (`index.html`)

Um único arquivo com HTML, CSS e JavaScript juntos. Não precisa de Node, de instalação nem de internet.

### Como usar

Dê dois cliques no `index.html`, ou abra o link do GitHub Pages acima.

1. **Cadastro do funcionário:** no primeiro acesso a tela já abre em *Cadastrar funcionário* (nome, cargo, e-mail corporativo e senha de no mínimo 8 caracteres). **O primeiro cadastro vira administrador**; os seguintes entram como colaboradores.
2. **Login:** e-mail e senha. A sessão termina quando o navegador é fechado.
3. **Bater ponto:** o botão registra a hora do computador na próxima marcação livre do dia (entrada, saída para intervalo, retorno, saída).
4. **Marcar manualmente:** o botão abre o dia (hoje ou um dia anterior) com os quatro horários para o próprio usuário preencher ou corrigir. O dia fica com um lápis (✎) na tabela, indicando que foi preenchido manualmente.
5. **Tela da semana:** a apuração abre mostrando só a semana atual inteira, de segunda a domingo, com o saldo da semana. As setas trocam de semana. Imprimir e Exportar CSV também são por semana.
6. **Administrador:** edita jornada e dias de trabalho de cada colaborador, corrige marcações, abona dias, imprime e exporta CSV. O colaborador só consulta o próprio ponto.

### Esqueci minha senha

Na tela de login, *Esqueci minha senha* pede o e-mail corporativo e a nova senha, digitada duas vezes, e **troca a senha na hora**.

Não há e-mail de confirmação, porque esta versão não tem servidor: **quem souber o e-mail de um usuário e tiver acesso ao computador consegue trocar a senha dele**. Como controle, toda troca feita por esse caminho fica registrada: o administrador recebe um aviso no próximo login e o funcionário aparece na lista como *(trocou a senha pelo Esqueci minha senha em …)* até o administrador abrir **Editar** e salvar.

### Limites desta versão

- **Os dados ficam só no navegador onde o arquivo foi aberto.** Outro computador, outro navegador ou uma janela anônima começam do zero. Limpar os dados do navegador apaga tudo, e não há backup automático (use *Exportar CSV*).
- **Não há isolamento real entre usuários:** quem tem acesso ao computador consegue ler e alterar os dados pelas ferramentas do navegador. As senhas ficam protegidas (PBKDF2 com salt, nunca em texto puro), mas as marcações não.
- **A hora vem do relógio do computador**, que pode ser alterado.
- Uma única empresa por navegador.

Se algum desses pontos for um problema, use a versão com servidor.

## Versão com servidor (`server.js`)

Multiempresa, com os dados no servidor.

- **Backend:** Node.js puro, **zero dependências** (`npm install` não é necessário). Banco SQLite embutido do próprio Node (`node:sqlite`).
- **Frontend:** `public/` (HTML + CSS + JavaScript puro, sem framework e sem etapa de build).

### Como rodar

Requer Node.js **22.13 ou superior**.

```bash
node server.js          # inicia em http://localhost:3000
node server.js --demo   # cria uma empresa de exemplo se o banco estiver vazio (apenas para testes)
```

Logins da demo: `admin@demo.com` (administrador) e `ana@demo.com` (colaboradora), senha `demo1234`. As contas da demo são criadas direto no banco e por isso não passam pela regra de domínio.

Variáveis de ambiente:

| Variável | Uso |
| --- | --- |
| `PORT` | porta (padrão 3000) |
| `DATA_DIR` | pasta do banco `ponto.db` (padrão `./data`) |
| `NODE_ENV=production` | marca o cookie de sessão como `Secure` (exige HTTPS) |
| `TRUST_PROXY=1` | usa `X-Forwarded-For` para o limite de tentativas, quando atrás de proxy reverso |

### Como funciona

- **Criar conta da empresa:** cada cadastro cria uma empresa (tenant) e o seu primeiro administrador.
- **Administrador:** cadastra colaboradores (e-mail + senha inicial, jornada, dias de trabalho), vê a apuração de todos, corrige marcações, abona dias, imprime e exporta CSV.
- **Colaborador:** bate o próprio ponto e consulta a própria apuração (somente leitura).
- **Bater ponto:** registra a hora do servidor, no fuso da empresa.
- **Tela da semana:** igual à da versão sem servidor (semana inteira, de segunda a domingo).

O cadastro feito pelo próprio funcionário e o *Esqueci minha senha* existem apenas na versão sem servidor.

### Segurança já incluída

- Isolamento entre empresas: toda consulta é filtrada pela empresa da sessão; o cliente nunca informa o tenant.
- Autorização verificada a cada requisição (negado por padrão; perfis admin/colaborador).
- Senhas com scrypt + salt; sessão em cookie `HttpOnly` + `SameSite=Strict`, com apenas o hash do token no banco.
- Proteção contra CSRF (cookie Strict + exigência de JSON + verificação de origem).
- Consultas SQL parametrizadas e validação de todos os campos de entrada.
- Limite de tentativas de login e de cadastro; resposta de login não revela se o e-mail existe.
- Cabeçalhos de segurança (CSP restrita, `X-Frame-Options`, `nosniff`).

### Antes de colocar em produção

Itens que ficaram de fora de propósito, para manter o projeto simples:

1. **HTTPS:** rode atrás de um proxy reverso (Caddy, nginx) com TLS e defina `NODE_ENV=production` e `TRUST_PROXY=1`.
2. **Recuperação de senha e verificação de e-mail:** não há envio de e-mail. O administrador redefine a senha do colaborador; o administrador não tem como recuperar a própria.
3. **Planos e cobrança:** não há assinatura nem limite por plano.
4. **MFA** para administradores e **log de auditoria** das correções de ponto.
5. **Escala:** o SQLite e o limite de tentativas em memória atendem a uma única instância. Para várias instâncias, migre para PostgreSQL (com Row-Level Security) e um limitador compartilhado.
6. **Backup** de `data/ponto.db`.
7. **LGPD:** termos de uso, política de privacidade e exclusão de dados da empresa.
8. O `node:sqlite` ainda emite um aviso de "experimental" no Node 22.

### API

| Método | Rota | Quem | Descrição |
| --- | --- | --- | --- |
| POST | `/api/signup` | público | cria empresa + administrador |
| POST | `/api/login`, `/api/logout` | — | sessão |
| GET | `/api/me` | logado | usuário, empresa e data atual |
| POST | `/api/me/password` | logado | troca a própria senha |
| POST | `/api/punch` | logado | bate o próprio ponto |
| GET | `/api/employees` | logado | admin: todos da empresa; colaborador: só ele |
| POST | `/api/employees` | admin | cria colaborador |
| PUT / DELETE | `/api/employees/:id` | admin | edita / exclui |
| GET | `/api/employees/:id/records?from=AAAA-MM-DD&to=AAAA-MM-DD` | admin ou o próprio | marcações do período |
| PUT | `/api/employees/:id/records` | admin | corrige marcações |

## E-mails aceitos

Só entram e-mails dos **domínios cadastrados**:

- `@qintess.com`
- `@marlonbastida.com.br`

Qualquer endereço desses domínios é aceito; todos os outros (Gmail, Hotmail e demais domínios) são recusados com a mensagem "Use um e-mail corporativo de um domínio cadastrado".

A regra vale no cadastro, no *Esqueci minha senha* e quando o administrador cadastra ou edita um colaborador. Para cadastrar outro domínio, acrescente-o à lista `CORP_DOMAINS` no `index.html` e no `server.js`.

## Regras de cálculo (as duas versões)

- Previsto = soma dos dois períodos da jornada, nos dias de trabalho a partir do início da apuração.
- Saldo do dia = trabalhado − previsto. Positivo conta como extra.
- Atraso = minutos após a entrada prevista, com tolerância de 5 minutos (constante `TOLERANCE`).
- Dia de trabalho passado sem marcação = falta. O dia de hoje só entra no saldo após as quatro marcações.
- Abono zera o saldo negativo do dia.

## Validade legal

Nenhuma das versões é um REP homologado (Portaria MTP 671/2021). Confirme os requisitos antes de usar como registro oficial de jornada.

## Estrutura

```
index.html         versão sem servidor (tudo em um arquivo)
server.js          versão com servidor: API REST, autenticação e arquivos estáticos
public/            telas da versão com servidor (index.html, style.css, app.js)
data/ponto.db      banco SQLite da versão com servidor (criado automaticamente)
LICENSE            licença MIT
```

## Licença

[MIT](LICENSE) © 2026 Marlon Bastida
